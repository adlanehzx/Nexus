import { AppError, redact } from "@nexus/shared";
import type { WorkerPayload } from "@nexus/protocol";
import type { CapabilityContext, LocalCapabilityRegistry } from "./capabilities.js";
import { ExecutionCancelledError, ExecutionTimeoutError } from "./errors.js";
import type { WorkerLogger } from "./logging.js";

/**
 * Task runner handling dispatch requests from core orchestrator.
 *
 * Sequence:
 *   known capability -> available capability -> argument schema -> concurrency check
 *   -> timed execution -> progress telemetry -> result delivery
 */

export interface TaskRunnerOptions {
  capabilities: LocalCapabilityRegistry;
  logger: WorkerLogger;
  sendProgress: (payload: WorkerPayload<"worker.task_progress">) => Promise<void>;
  sendResult: (payload: WorkerPayload<"worker.task_result">) => Promise<void>;
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
   * Handles inbound dispatch orders from orchestrator.
   *
   * Never throws uncaught exceptions: all failures convert to `worker.task_result`.
   */
  async handleDispatch(payload: WorkerPayload<"worker.task_dispatch">): Promise<void> {
    const key = stepKey(payload.taskId, payload.stepId);
    const startedAt = Date.now();

    if (this.#completedRequests.has(payload.requestId)) {
      this.#logger.info("dispatched order already completed, ignoring", { requestId: payload.requestId });
      return;
    }

    if (this.#running.has(key)) {
      await this.#fail(payload, startedAt, {
        code: "STEP_ALREADY_RUNNING",
        message: "This step is already running on this device.",
        retryable: false,
      });
      return;
    }

    if (this.#running.size >= this.#maxConcurrent) {
      await this.#fail(payload, startedAt, {
        code: "WORKER_SATURATED",
        message: "This device is already running maximum concurrent tasks.",
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
      const capability = this.#capabilities.require(payload.capability);
      const input = this.#capabilities.validateInput(payload.capability, payload.arguments);

      this.#logger.info("step started", {
        taskId: payload.taskId,
        stepId: payload.stepId,
        capability: payload.capability,
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
        sensitiveResult: capability.sensitiveResult ?? false,
        error: null,
        durationMs: Date.now() - startedAt,
      });

      this.#logger.info("step finished", {
        taskId: payload.taskId,
        stepId: payload.stepId,
        durationMs: Date.now() - startedAt,
      });
    } catch (cause) {
      const error = toWireError(cause);
      this.#logger.warn("step failed", {
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
   * Cancels a currently running task step.
   */
  cancel(taskId: string, stepId: string, reason: string): boolean {
    const running = this.#running.get(stepKey(taskId, stepId));
    if (running === undefined) return false;

    this.#logger.info("cancellation requested", { taskId, stepId, reason });
    running.controller.abort();
    return true;
  }

  /** Cancels all currently executing steps during shutdown or connection drops. */
  cancelAll(reason: string): number {
    const count = this.#running.size;
    for (const running of this.#running.values()) running.controller.abort();
    this.#logger.info("global cancellation", { reason, count });
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

  get now(): Date {
    return this.#now();
  }
}

function stepKey(taskId: string, stepId: string): string {
  return `${taskId}:${stepId}`;
}

/**
 * Masks argument fields flagged as secrets before logging.
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

export const REDACTED_ARGUMENT = "[REDACTED]";

/**
 * Normalizes exceptions into wire format errors.
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
    message: "The device encountered an unexpected error.",
    retryable: false,
  };
}

/**
 * Imposes timeout deadline with cooperative cancellation trigger.
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
