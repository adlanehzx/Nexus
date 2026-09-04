import { AppError, redact } from "@nexus/shared";
import type { WorkerPayload } from "@nexus/protocol";
import type { CapabilityContext, LocalCapabilityRegistry } from "./capabilities.js";
import { ExecutionCancelledError, ExecutionTimeoutError } from "./errors.js";
import type { WorkerLogger } from "./logging.js";

/**
 * Exécution des étapes reçues du cœur.
 *
 * La chaîne est fixe, et aucun maillon n'est facultatif :
 *
 *     capacité connue → capacité disponible → schéma → capacité libre
 *       → exécution sous délai → progression → résultat
 *
 * Elle s'arrête au premier refus. Un ordre qui n'a pas traversé les quatre
 * premières étapes n'atteint jamais le système d'exploitation — c'est ce qui
 * distingue ce worker d'un exécuteur de commandes distant.
 *
 * Le cœur a déjà vérifié les permissions et obtenu les confirmations. Le worker
 * revérifie quand même ce qui le concerne : il est le dernier à savoir ce qui
 * est réellement possible et permis **sur cette machine**, et un cœur compromis
 * ne doit pas suffire à lui faire faire n'importe quoi.
 */

export interface TaskRunnerOptions {
  capabilities: LocalCapabilityRegistry;
  logger: WorkerLogger;
  /** Envoie une trame au cœur. Fourni par l'orchestrateur du worker. */
  sendProgress: (payload: WorkerPayload<"worker.task_progress">) => Promise<void>;
  sendResult: (payload: WorkerPayload<"worker.task_result">) => Promise<void>;
  /** Tâches menées de front. Au-delà, le worker refuse — le cœur ira ailleurs. */
  maxConcurrentTasks: number;
  defaultTimeoutMs: number;
  now?: () => Date;
}

interface RunningStep {
  taskId: string;
  stepId: string;
  capability: string;
  controller: AbortController;
  startedAt: number;
}

export class TaskRunner {
  readonly #capabilities: LocalCapabilityRegistry;
  readonly #logger: WorkerLogger;
  readonly #sendProgress: TaskRunnerOptions["sendProgress"];
  readonly #sendResult: TaskRunnerOptions["sendResult"];
  readonly #maxConcurrent: number;
  readonly #defaultTimeoutMs: number;
  readonly #now: () => Date;

  readonly #running = new Map<string, RunningStep>();
  /**
   * Requêtes déjà traitées.
   *
   * Le cœur peut renvoyer un ordre après une coupure, sans savoir si le premier
   * est arrivé. Sans cette table, `git.commit` s'exécuterait deux fois.
   */
  readonly #completedRequests = new Set<string>();

  constructor(options: TaskRunnerOptions) {
    this.#capabilities = options.capabilities;
    this.#logger = options.logger;
    this.#sendProgress = options.sendProgress;
    this.#sendResult = options.sendResult;
    this.#maxConcurrent = options.maxConcurrentTasks;
    this.#defaultTimeoutMs = options.defaultTimeoutMs;
    this.#now = options.now ?? (() => new Date());
  }

  get activeCount(): number {
    return this.#running.size;
  }

  get runningSteps(): { taskId: string; stepId: string; capability: string }[] {
    return [...this.#running.values()].map(({ taskId, stepId, capability }) => ({
      taskId,
      stepId,
      capability,
    }));
  }

  /**
   * Reçoit un ordre et le mène à son terme.
   *
   * Ne lève jamais : toute issue devient un `worker.task_result`. Une exception
   * qui remonterait jusqu'à la boucle de messages ferait tomber la connexion, et
   * le cœur attendrait un résultat qui n'arriverait plus.
   */
  async handleDispatch(payload: WorkerPayload<"worker.task_dispatch">): Promise<void> {
    const key = stepKey(payload.taskId, payload.stepId);
    const startedAt = Date.now();

    if (this.#completedRequests.has(payload.requestId)) {
      // Renvoi après coupure : déjà fait. On ne réexécute pas, et on ne répond
      // pas non plus — le cœur a soit déjà le résultat, soit repris l'étape.
      this.#logger.info("ordre déjà traité, ignoré", { requestId: payload.requestId });
      return;
    }

    if (this.#running.has(key)) {
      await this.#fail(payload, startedAt, {
        code: "STEP_ALREADY_RUNNING",
        message: "Cette étape est déjà en cours sur cet appareil.",
        retryable: false,
      });
      return;
    }

    if (this.#running.size >= this.#maxConcurrent) {
      // Réessayable : la machine n'est pas incapable, elle est occupée. Le
      // coordinateur peut basculer sur un autre exécutant immédiatement.
      await this.#fail(payload, startedAt, {
        code: "WORKER_SATURATED",
        message: "Cet appareil exécute déjà le maximum de tâches simultanées.",
        retryable: true,
      });
      return;
    }

    const controller = new AbortController();
    this.#running.set(key, {
      taskId: payload.taskId,
      stepId: payload.stepId,
      capability: payload.capability,
      controller,
      startedAt,
    });

    try {
      // 1. La capacité existe, est autorisée localement, et est disponible.
      const capability = this.#capabilities.require(payload.capability);

      // 2. Les arguments respectent le schéma déclaré. Rien ne s'exécute avant.
      const input = this.#capabilities.validateInput(payload.capability, payload.arguments);

      this.#logger.info("étape démarrée", {
        taskId: payload.taskId,
        stepId: payload.stepId,
        capability: payload.capability,
        // Les arguments sont journalisés **rédigés** ; l'exécution, elle, reçoit
        // les vrais. Même règle que dans le journal d'exécution du cœur.
        arguments: redact(maskSecretFields(input, capability.secretArguments)),
      });

      const timeoutMs = Math.min(payload.timeoutMs, this.#defaultTimeoutMs);
      const context: CapabilityContext = {
        taskId: payload.taskId,
        stepId: payload.stepId,
        signal: controller.signal,
        timeoutMs,
        onProgress: (progress) => {
          void this.#sendProgress({
            taskId: payload.taskId,
            stepId: payload.stepId,
            percent: progress.percent ?? null,
            label: progress.label ?? null,
          }).catch(() => undefined);
        },
      };

      // 3. Exécution sous double contrainte : le délai du worker et l'annulation
      //    venue du cœur. La capacité reçoit le signal et peut s'arrêter elle-même ;
      //    la course garantit qu'on répond même si elle ne le fait pas.
      const result = await withTimeout(
        capability.execute(input as never, context),
        timeoutMs,
        () => controller.abort(),
        payload.capability,
      );

      this.#completedRequests.add(payload.requestId);
      await this.#sendResult({
        taskId: payload.taskId,
        stepId: payload.stepId,
        ok: true,
        result: result ?? null,
        // La capacité déclare si sa sortie peut être conservée. Le cœur la
        // transmettra au client sans la ranger dans son journal d'audit.
        sensitiveResult: capability.sensitiveResult ?? false,
        error: null,
        durationMs: Date.now() - startedAt,
      });

      this.#logger.info("étape terminée", {
        taskId: payload.taskId,
        stepId: payload.stepId,
        durationMs: Date.now() - startedAt,
      });
    } catch (cause) {
      const error = toWireError(cause);
      this.#logger.warn("étape en échec", {
        taskId: payload.taskId,
        stepId: payload.stepId,
        code: error.code,
      });
      await this.#fail(payload, startedAt, error);
    } finally {
      this.#running.delete(key);
    }
  }

  /**
   * Annule une étape en cours.
   *
   * L'annulation se propage par `AbortSignal` jusqu'au processus enfant, qui est
   * réellement tué. Le résultat est envoyé par le chemin d'erreur ordinaire —
   * il n'y a pas de sortie silencieuse.
   */
  cancel(taskId: string, stepId: string, reason: string): boolean {
    const running = this.#running.get(stepKey(taskId, stepId));
    if (running === undefined) return false;

    this.#logger.info("annulation demandée", { taskId, stepId, reason });
    running.controller.abort();
    return true;
  }

  /** Annule tout — arrêt du worker, ou perte de la connexion. */
  cancelAll(reason: string): number {
    const count = this.#running.size;
    for (const running of this.#running.values()) running.controller.abort();
    this.#logger.info("annulation générale", { reason, count });
    return count;
  }

  async #fail(
    payload: WorkerPayload<"worker.task_dispatch">,
    startedAt: number,
    error: { code: string; message: string; retryable: boolean },
  ): Promise<void> {
    await this.#sendResult({
      taskId: payload.taskId,
      stepId: payload.stepId,
      ok: false,
      result: null,
      sensitiveResult: false,
      error,
      durationMs: Date.now() - startedAt,
    }).catch(() => undefined);
  }

  /** Horodatage courant — exposé pour les traces. */
  get now(): Date {
    return this.#now();
  }
}

function stepKey(taskId: string, stepId: string): string {
  return `${taskId}:${stepId}`;
}

/**
 * Masque les champs qu'une capacité a déclarés secrets.
 *
 * Appliqué **avant** `redact`, et non à la place : les deux se complètent. La
 * déclaration couvre ce que la capacité seule sait — un champ `text` qui reçoit
 * un mot de passe — et `redact` couvre le reste, y compris les champs
 * imprévus d'une charge utile mal formée.
 */
export function maskSecretFields(input: unknown, secretFields?: readonly string[]): unknown {
  if (secretFields === undefined || secretFields.length === 0) return input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;

  const masked: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const field of secretFields) {
    if (field in masked) masked[field] = REDACTED_ARGUMENT;
  }
  return masked;
}

/** Ce qui remplace un argument déclaré secret dans les journaux. */
export const REDACTED_ARGUMENT = "[REDACTED]";

/**
 * Traduit une exception en erreur de fil.
 *
 * `AppError` porte déjà `code` et `retryable` : on les respecte. Une exception
 * inconnue devient non réessayable, et **son message n'est pas transmis** — il
 * peut contenir un chemin, une variable d'environnement, un fragment de fichier.
 * Il part dans le journal local, pas sur le réseau.
 */
export function toWireError(cause: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (cause instanceof AppError) {
    return { code: cause.code, message: cause.userMessage, retryable: cause.retryable };
  }
  return {
    code: "WORKER_INTERNAL_ERROR",
    message: "L'appareil a rencontré une erreur inattendue.",
    retryable: false,
  };
}

/**
 * Impose un délai à une promesse.
 *
 * `onTimeout` déclenche l'annulation coopérative — c'est elle qui tue réellement
 * le processus. La course n'est qu'un filet : sans elle, une capacité qui
 * ignorerait le signal retiendrait l'étape indéfiniment.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  capability: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new ExecutionTimeoutError(capability, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export { ExecutionCancelledError };
