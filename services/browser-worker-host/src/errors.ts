import { AppError, type ErrorSeverity } from "@nexus/shared";

/**
 * Domain errors specific to the browser worker host.
 */

export {
  CapabilityInputError,
  CapabilityUnavailableError,
  ExecutionCancelledError,
  ExecutionTimeoutError,
  PolicyViolationError,
  WorkerConfigurationError,
} from "@nexus/worker-core";

/**
 * Target website requires human intervention (CAPTCHA or MFA).
 *
 * This is an intentional stopping point, not a technical worker failure.
 */
export class HumanVerificationRequiredError extends AppError {
  readonly code = "BROWSER_NEEDS_HUMAN";
  readonly httpStatus = 409;
  override readonly severity: ErrorSeverity = "warning";
  override readonly retryable = false;

  constructor(capability: string, message: string) {
    super({
      message: `${capability}: human verification required`,
      userMessage: message,
      context: { capability },
    });
  }
}

/** Navigation completed without producing actionable results. */
export class BrowserTaskFailedError extends AppError {
  readonly code = "BROWSER_TASK_FAILED";
  readonly httpStatus = 502;
  override readonly retryable: boolean;

  constructor(
    capability: string,
    detail: {
      status: string;
      code: string | undefined;
      message: string | undefined;
      retryable: boolean;
    },
  ) {
    super({
      message: `${capability}: browser task ended in ${detail.status}`,
      userMessage: detail.message ?? `Navigation completed without result (${detail.status}).`,
      context: { capability, status: detail.status, workerCode: detail.code ?? null },
    });
    this.retryable = detail.retryable;
  }
}

/**
 * Python browser worker is unreachable.
 */
export class BrowserWorkerUnreachableError extends AppError {
  readonly code = "BROWSER_WORKER_UNREACHABLE";
  readonly httpStatus = 503;
  override readonly retryable = true;

  constructor(cause?: string) {
    super({
      message: "Browser Use worker is not responding",
      userMessage: "The browsing service is temporarily unavailable.",
      context: cause === undefined ? {} : { cause },
    });
  }
}
