import { AppError } from "@nexus/shared";
import type { ToolContext, ToolDefinition, ToolResult } from "./definition.js";
import {
  ToolCancelledError,
  ToolExecutionError,
  ToolInputValidationError,
  ToolOutputValidationError,
  ToolTimeoutError,
  normalizeToolError,
} from "./errors.js";

/** Politique de reprise. Le jitter évite que N runs réessaient en même temps. */
export interface RetryPolicy {
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 5_000,
  factor: 2,
  jitter: true,
};

/** Délai avant la tentative n° `attempt` (1 = première reprise). */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = policy.initialDelayMs * Math.pow(policy.factor, attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  // Jitter « full » : uniformément réparti sur [capped/2, capped]. Il conserve
  // la croissance exponentielle tout en désynchronisant les clients.
  return policy.jitter ? Math.round(capped / 2 + random() * (capped / 2)) : Math.round(capped);
}

export interface ToolExecutorOptions {
  defaultTimeoutMs?: number;
  retry?: RetryPolicy;
  /** Injecté pour rendre les tests de backoff déterministes et instantanés. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Taille maximale de la projection renvoyée au modèle. */
  maxSummaryChars?: number;
  onAttempt?: (event: {
    toolName: string;
    attempt: number;
    error: AppError;
    willRetryInMs: number | undefined;
  }) => void;
}

/**
 * Promesse qui rejette dès que le signal est abandonné.
 *
 * Indispensable : un outil qui ignore son `AbortSignal` ne rendrait jamais la
 * main. On fait donc courir son exécution contre le signal, plutôt que de lui
 * faire confiance pour s'arrêter.
 */
function rejectOnAbort(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let dispose: () => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortError());
      return;
    }
    const onAbort = (): void => {
      reject(new AbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    dispose = () => {
      signal.removeEventListener("abort", onAbort);
    };
  });
  // Personne n'attend cette promesse si l'exécution gagne la course : on neutralise
  // le rejet non géré qui serait signalé au processus.
  promise.catch(() => undefined);
  return { promise, dispose };
}

/** Marqueur interne : traduit ensuite en annulation ou en délai dépassé. */
class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

const noop = (): void => undefined;

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Exécuteur d'outils — la frontière d'exécution unique.
 *
 * Aucun chemin ne contourne ce pipeline :
 *   valider l'entrée → exécuter sous délai → réessayer si transitoire →
 *   valider la sortie → normaliser pour le modèle.
 *
 * Les permissions et les confirmations sont évaluées **en amont** par la boucle
 * agent : l'exécuteur ne reçoit que des appels déjà autorisés. Cette séparation
 * évite qu'un futur appelant contourne l'autorisation en appelant directement
 * l'exécuteur — il ne saurait pas quoi lui passer.
 */
export class ToolExecutor {
  readonly #defaultTimeoutMs: number;
  readonly #retry: RetryPolicy;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;
  readonly #maxSummaryChars: number;
  readonly #onAttempt: ToolExecutorOptions["onAttempt"];

  constructor(options: ToolExecutorOptions = {}) {
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.#retry = options.retry ?? DEFAULT_RETRY_POLICY;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.#maxSummaryChars = options.maxSummaryChars ?? 4_000;
    this.#onAttempt = options.onAttempt;
  }

  async execute<I, O>(
    tool: ToolDefinition<I, O>,
    rawInput: unknown,
    partialContext: Omit<ToolContext, "attempt" | "onProgress"> & {
      onProgress?: ToolContext["onProgress"];
    },
  ): Promise<ToolResult<O>> {
    const startedAt = performance.now();
    // Un outil ne doit jamais avoir à tester si le canal existe.
    const context = { ...partialContext, onProgress: partialContext.onProgress ?? noop };

    // 1. Validation des arguments. Un échec ici n'est jamais réessayé : il est
    //    renvoyé au modèle, qui peut corriger ses arguments au tour suivant.
    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const error = new ToolInputValidationError(tool.name, parsed.error.issues);
      return this.#failure(tool.name, error, startedAt, 1);
    }
    const input = parsed.data;

    const maxAttempts = Math.max(1, tool.retry?.attempts ?? this.#retry.attempts);
    // Un outil non idempotent n'est jamais rejoué automatiquement : on ne peut
    // pas savoir si le premier appel a déjà eu son effet de bord.
    const attemptsAllowed = tool.idempotent === false ? 1 : maxAttempts;

    let attempt = 0;
    let lastError: AppError | undefined;

    while (attempt < attemptsAllowed) {
      attempt += 1;

      if (context.signal.aborted) {
        return this.#failure(tool.name, new ToolCancelledError(tool.name), startedAt, attempt);
      }

      try {
        const output = await this.#runOnce(tool, input, { ...context, attempt });

        // 2. Validation de la sortie. Une sortie non conforme est un bug de
        //    l'outil : on ne la propage pas au modèle telle quelle.
        const validated = tool.outputSchema.safeParse(output);
        if (!validated.success) {
          const error = new ToolOutputValidationError(tool.name, validated.error.issues);
          return this.#failure(tool.name, error, startedAt, attempt);
        }

        return {
          ok: true,
          toolName: tool.name,
          output: validated.data,
          summaryForModel: this.#summarize(validated.data),
          metrics: { durationMs: Math.round(performance.now() - startedAt), attempts: attempt },
        };
      } catch (error) {
        const appError = this.#toAppError(error, tool.name);
        lastError = appError;

        const isLastAttempt = attempt >= attemptsAllowed;
        const shouldRetry = appError.retryable && !isLastAttempt && !context.signal.aborted;
        const delay = shouldRetry ? backoffDelay(attempt, this.#retry, this.#random) : undefined;

        this.#onAttempt?.({ toolName: tool.name, attempt, error: appError, willRetryInMs: delay });

        if (!shouldRetry) break;

        try {
          await this.#sleep(delay ?? 0, context.signal);
        } catch {
          return this.#failure(tool.name, new ToolCancelledError(tool.name), startedAt, attempt);
        }
      }
    }

    return this.#failure(
      tool.name,
      lastError ?? new ToolCancelledError(tool.name),
      startedAt,
      attempt,
    );
  }

  /** Une tentative, sous contrainte de délai et d'annulation. */
  async #runOnce<I, O>(tool: ToolDefinition<I, O>, input: I, context: ToolContext): Promise<O> {
    const timeoutMs = tool.timeoutMs ?? this.#defaultTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    // On combine les deux signaux mais on garde les originaux : c'est ce qui
    // permet de distinguer « annulé par l'utilisateur » de « délai dépassé ».
    const combined = AbortSignal.any([context.signal, timeoutSignal]);
    const abort = rejectOnAbort(combined);

    try {
      return await Promise.race([
        tool.execute(input, { ...context, signal: combined }),
        abort.promise,
      ]);
    } catch (error) {
      // L'ordre compte : une annulation utilisateur prime sur un délai dépassé
      // survenu au même instant — c'est l'intention de l'utilisateur qui gagne.
      if (context.signal.aborted) throw new ToolCancelledError(tool.name);
      if (timeoutSignal.aborted) throw new ToolTimeoutError(tool.name, timeoutMs);
      throw error;
    } finally {
      abort.dispose();
    }
  }

  #toAppError(error: unknown, toolName: string): AppError {
    if (error instanceof AppError) return error;
    // Une erreur brute est considérée comme NON réessayable. C'est à l'outil de
    // déclarer un échec transitoire, via `RetryableToolError` — réessayer par
    // défaut enverrait deux fois le même email.
    return new ToolExecutionError(toolName, {
      message: error instanceof Error ? error.message : String(error),
      userMessage: "The tool failed.",
      cause: error,
      retryable: false,
    });
  }

  #failure(
    toolName: string,
    error: AppError,
    startedAt: number,
    attempts: number,
  ): ToolResult<never> {
    const normalized = normalizeToolError(error, toolName);
    return {
      ok: false,
      toolName,
      error: normalized,
      summaryForModel: `Échec de ${toolName} (${normalized.code}) : ${normalized.message}`,
      metrics: { durationMs: Math.round(performance.now() - startedAt), attempts },
    };
  }

  #summarize(output: unknown): string {
    const text = typeof output === "string" ? output : JSON.stringify(output);
    const safe = text ?? "null";
    return safe.length <= this.#maxSummaryChars
      ? safe
      : `${safe.slice(0, this.#maxSummaryChars)}… [tronqué, ${String(safe.length)} caractères au total]`;
  }
}
