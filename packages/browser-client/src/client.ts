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
 * Browser Worker client.
 *
 * The TypeScript backend only interacts with the Python worker through this file: a
 * versioned HTTP contract, never a direct import (ADR-006). The worker is reachable
 * only on the internal network — it is never exposed to the Internet.
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
  /** Service token. Presented on each call; never logged. */
  token: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface WaitOptions {
  signal?: AbortSignal;
  /** Invoked on each new event, in order. */
  onEvent?: (event: BrowserEvent) => void;
  pollIntervalMs?: number;
  /** Client-side guardrail, independent of the worker's timeout. */
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

  /** Starts the task. Returns immediately: the task is asynchronous. */
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

  /** State of a task, with events that occurred since `sinceSeq`. */
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
   * Follows a task until completion, streaming its events as they arrive.
   *
   * Polling rather than streaming: the worker keeps numbered events, so
   * resuming after a disconnection loses nothing — and a long-lived connection is not
   * necessary for an internal service.
   *
   * Cancelling the signal also cancels **the task on the worker side**: without this,
   * a browser would continue clicking even after the user has cancelled.
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
          message: `Task ${taskId} cancelled`,
          userMessage: "Browsing was cancelled.",
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
          message: `Task ${taskId} timed out on client side`,
          userMessage: "Browsing timed out.",
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
          // The worker rejects any unauthenticated call: it is not public,
          // but we do not rely solely on network topology.
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
          message: "Call to Browser Worker cancelled",
          userMessage: "The operation was cancelled.",
          cause: error,
        });
      }
      // Worker offline, network interrupted: retryable, and not fatal for the agent.
      throw new BrowserWorkerError("BROWSER_WORKER_UNAVAILABLE", {
        message: `Browser Worker unreachable: ${error instanceof Error ? error.message : String(error)}`,
        userMessage: "The browsing service is unavailable.",
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
        message: `HTTP ${String(response.status)} from Browser Worker`,
        userMessage: "The browsing service failed.",
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

/** Validates a received event — the worker is a separate service, not a trusted friend. */
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
