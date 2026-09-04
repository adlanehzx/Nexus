import { AppError, type AppErrorOptions } from "@nexus/shared";
import {
  BROWSER_PROTOCOL_VERSION,
  browserEventSchema,
  healthSchema,
  sessionSchema,
  taskSchema,
  workerErrorSchema,
  type BrowserEvent,
  type BrowserSession,
  type BrowserTask,
  type BrowserWorkerHealth,
  type CreateSessionRequest,
  type RunTaskRequest,
} from "./protocol.js";

/**
 * Client du Browser Worker.
 *
 * Le backend TypeScript ne connaît le worker Python qu'à travers ce fichier : un
 * contrat HTTP versionné, jamais un import (ADR-006). Le worker n'est joignable
 * que sur le réseau interne — il n'est jamais exposé à Internet.
 */

export class BrowserWorkerError extends AppError {
  readonly code: string;
  readonly httpStatus = 502;
  override readonly retryable: boolean;

  constructor(code: string, options: AppErrorOptions & { retryable?: boolean }) {
    super(options);
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export interface BrowserWorkerClientOptions {
  baseUrl: string;
  /** Jeton de service. Présenté à chaque appel ; jamais journalisé. */
  token: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface WaitOptions {
  signal?: AbortSignal;
  /** Appelé à chaque nouvel événement, dans l'ordre. */
  onEvent?: (event: BrowserEvent) => void;
  pollIntervalMs?: number;
  /** Garde-fou côté client, indépendant de celui du worker. */
  maxWaitMs?: number;
}

export class BrowserWorkerClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: BrowserWorkerClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async health(signal?: AbortSignal): Promise<BrowserWorkerHealth> {
    return healthSchema.parse(await this.#request("GET", "/v1/health", undefined, signal));
  }

  async createSession(
    request: CreateSessionRequest,
    signal?: AbortSignal,
  ): Promise<BrowserSession> {
    return sessionSchema.parse(await this.#request("POST", "/v1/sessions", request, signal));
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<BrowserSession> {
    return sessionSchema.parse(
      await this.#request(
        "GET",
        `/v1/sessions/${encodeURIComponent(sessionId)}`,
        undefined,
        signal,
      ),
    );
  }

  async closeSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.#request(
      "DELETE",
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      undefined,
      signal,
    );
  }

  /** Démarre la tâche. Rend la main immédiatement : la tâche est asynchrone. */
  async runTask(request: RunTaskRequest, signal?: AbortSignal): Promise<BrowserTask> {
    return taskSchema.parse(
      await this.#request(
        "POST",
        `/v1/sessions/${encodeURIComponent(request.sessionId)}/tasks`,
        request,
        signal,
      ),
    );
  }

  /** État d'une tâche, avec les événements survenus depuis `sinceSeq`. */
  async getStatus(taskId: string, sinceSeq = -1, signal?: AbortSignal): Promise<BrowserTask> {
    const query = sinceSeq >= 0 ? `?since=${String(sinceSeq)}` : "";
    return taskSchema.parse(
      await this.#request(
        "GET",
        `/v1/tasks/${encodeURIComponent(taskId)}${query}`,
        undefined,
        signal,
      ),
    );
  }

  async cancelTask(taskId: string, signal?: AbortSignal): Promise<BrowserTask> {
    return taskSchema.parse(
      await this.#request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {}, signal),
    );
  }

  /**
   * Suit une tâche jusqu'à son terme, en publiant ses événements au fil de l'eau.
   *
   * Scrutation plutôt que flux : le worker garde les événements numérotés, donc
   * une reprise après coupure ne perd rien — et une connexion longue n'est pas
   * nécessaire pour un service interne.
   *
   * L'annulation du signal annule **aussi la tâche côté worker** : sans cela, un
   * navigateur continuerait de cliquer alors que l'utilisateur a coupé.
   */
  async waitForTask(taskId: string, options: WaitOptions = {}): Promise<BrowserTask> {
    const interval = options.pollIntervalMs ?? 500;
    const deadline = Date.now() + (options.maxWaitMs ?? 900_000);
    let since = -1;
    let task: BrowserTask;

    for (;;) {
      if (options.signal?.aborted === true) {
        await this.cancelTask(taskId).catch(() => undefined);
        throw new BrowserWorkerError("BROWSER_TASK_CANCELLED", {
          message: `Tâche ${taskId} annulée`,
          userMessage: "La navigation a été annulée.",
        });
      }

      task = await this.getStatus(taskId, since);

      for (const event of task.events) {
        since = Math.max(since, event.seq);
        options.onEvent?.(event);
      }

      if (isTerminal(task.status)) return task;

      if (Date.now() > deadline) {
        await this.cancelTask(taskId).catch(() => undefined);
        throw new BrowserWorkerError("BROWSER_TASK_TIMEOUT", {
          message: `Tâche ${taskId} sans réponse au-delà du délai client`,
          userMessage: "La navigation a pris trop de temps.",
          retryable: true,
        });
      }

      await sleep(interval, options.signal);
    }
  }

  async #request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          // Le worker refuse tout appel non authentifié : il n'est pas public,
          // mais on ne compte pas sur la seule topologie réseau.
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
          "x-browser-protocol-version": String(BROWSER_PROTOCOL_VERSION),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted === true) {
        throw new BrowserWorkerError("BROWSER_TASK_CANCELLED", {
          message: "Appel au Browser Worker annulé",
          userMessage: "L'opération a été annulée.",
          cause: error,
        });
      }
      // Worker éteint, réseau coupé : réessayable, et surtout pas fatal pour l'agent.
      throw new BrowserWorkerError("BROWSER_WORKER_UNAVAILABLE", {
        message: `Browser Worker injoignable : ${error instanceof Error ? error.message : String(error)}`,
        userMessage: "Le service de navigation est indisponible.",
        retryable: true,
        cause: error,
      });
    }

    if (response.status === 204) return undefined;

    const text = await response.text();
    const payload: unknown = text.length > 0 ? safeJson(text) : undefined;

    if (!response.ok) {
      const parsed = workerErrorSchema.safeParse(payload);
      if (parsed.success) {
        throw new BrowserWorkerError(parsed.data.error.code, {
          message: parsed.data.error.message,
          userMessage: parsed.data.error.message,
          retryable: parsed.data.error.retryable,
        });
      }
      throw new BrowserWorkerError("BROWSER_WORKER_ERROR", {
        message: `HTTP ${String(response.status)} du Browser Worker`,
        userMessage: "Le service de navigation a échoué.",
        retryable: response.status >= 500,
      });
    }

    return payload;
  }
}

export function isTerminal(status: BrowserTask["status"]): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timeout" ||
    status === "needs_human"
  );
}

/** Valide un événement reçu — le worker est un service distinct, pas un ami. */
export function parseBrowserEvent(input: unknown): BrowserEvent {
  return browserEventSchema.parse(input);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
