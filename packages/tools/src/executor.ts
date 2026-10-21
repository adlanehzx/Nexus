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

/** Retry policy. Jitter prevents thundering herd problem. */
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

/** Calculates delay before retry attempt n (1 = first retry). */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = policy.initialDelayMs * Math.pow(policy.factor, attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  return policy.jitter ? Math.round(capped / 2 + random() * (capped / 2)) : Math.round(capped);
}

export interface ToolExecutorOptions {
  defaultTimeoutMs?: number;
  retry?: RetryPolicy;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  maxSummaryChars?: number;
  onAttempt?: (event: {
    toolName: string;
    attempt: number;
    error: AppError;
    willRetryInMs: number | undefined;
  }) => void;
}

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
  promise.catch(() => undefined);
  return { promise, dispose };
}

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
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

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
    context: Omit<ToolContext, "attempt">,
  ): Promise<ToolResult<O>> {
    const startedAt = performance.now();

    if (context.signal.aborted) {
      return this.#failure(tool.name, new ToolCancelledError(tool.name), startedAt, 0);
    }

    const parsedInput = tool.inputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      return this.#failure(
        tool.name,
        new ToolInputValidationError(tool.name, parsedInput.error.issues),
        startedAt,
        0,
      );
    }
    const input = parsedInput.data;

    const maxAttempts =
      tool.idempotent === false ? 1 : (tool.retry?.attempts ?? this.#retry.attempts);

    let lastError: AppError | undefined;
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt += 1;
      const attemptContext: ToolContext = {
        ...context,
        attempt,
        onProgress: context.onProgress ?? noop,
      };

      try {
        const rawOutput = await this.#runOnce(tool, input, attemptContext);

        const parsedOutput = tool.outputSchema.safeParse(rawOutput);
        if (!parsedOutput.success) {
          throw new ToolOutputValidationError(tool.name, parsedOutput.error.issues);
        }

        return {
          ok: true,
          toolName: tool.name,
          output: parsedOutput.data,
          summaryForModel: this.#summarize(parsedOutput.data),
          metrics: { durationMs: Math.round(performance.now() - startedAt), attempts: attempt },
        };
      } catch (error) {
        const appError = this.#toAppError(error, tool.name);
        lastError = appError;

        const isLastAttempt = attempt >= maxAttempts;
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

  async #runOnce<I, O>(tool: ToolDefinition<I, O>, input: I, context: ToolContext): Promise<O> {
    const timeoutMs = tool.timeoutMs ?? this.#defaultTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([context.signal, timeoutSignal]);
    const abort = rejectOnAbort(combined);

    try {
      return await Promise.race([
        tool.execute(input, { ...context, signal: combined }),
        abort.promise,
      ]);
    } catch (error) {
      if (context.signal.aborted) throw new ToolCancelledError(tool.name);
      if (timeoutSignal.aborted) throw new ToolTimeoutError(tool.name, timeoutMs);
      throw error;
    } finally {
      abort.dispose();
    }
  }

  #toAppError(error: unknown, toolName: string): AppError {
    if (error instanceof AppError) return error;
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
      summaryForModel: `Failed: ${toolName} (${normalized.code}): ${normalized.message}`,
      metrics: { durationMs: Math.round(performance.now() - startedAt), attempts },
    };
  }

  #summarize(output: unknown): string {
    const text = typeof output === "string" ? output : JSON.stringify(output);
    const safe = text ?? "null";
    return safe.length <= this.#maxSummaryChars
      ? safe
      : `${safe.slice(0, this.#maxSummaryChars)}… [truncated, ${String(safe.length)} characters total]`;
  }
}
