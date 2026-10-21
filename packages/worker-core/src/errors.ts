import { AppError, type AppErrorOptions, type ErrorSeverity } from "@nexus/shared";

/**
 * Common worker errors.
 *
 * Extends monorepo `AppError` taxonomy:
 *  - `userMessage`: Safe for user display;
 *  - `context`: Structured diagnostic data;
 *  - `retryable`: Indicates to orchestrator whether retrying on another node is viable.
 */

/** Requested capability is not declared or disabled locally. */
export class CapabilityUnavailableError extends AppError {
  readonly code = "CAPABILITY_UNAVAILABLE";
  readonly httpStatus = 404;

  constructor(capability: string, reason: string) {
    super({
      message: `Capability ${capability} unavailable: ${reason}`,
      userMessage: `This device cannot perform "${capability}".`,
      context: { capability, reason },
    });
  }
}

/** Arguments violate capability validation schema. */
export class CapabilityInputError extends AppError {
  readonly code = "CAPABILITY_INPUT_INVALID";
  readonly httpStatus = 400;
  override readonly severity: ErrorSeverity = "warning";

  constructor(capability: string, issues: string[]) {
    super({
      message: `Invalid arguments for ${capability}: ${issues.join("; ")}`,
      userMessage: `The arguments given for "${capability}" are invalid: ${issues.join("; ")}.`,
      context: { capability, issues },
    });
  }
}

/** Local device policy prohibits the requested operation. */
export class PolicyViolationError extends AppError {
  readonly code = "WORKER_POLICY_VIOLATION";
  readonly httpStatus = 403;

  constructor(options: AppErrorOptions & { rule: string }) {
    super({
      userMessage: options.userMessage ?? "This operation is forbidden by the local policy.",
      ...options,
      context: { rule: options.rule, ...options.context },
    });
  }
}

/** Execution exceeded timeout budget. Retryable on available nodes. */
export class ExecutionTimeoutError extends AppError {
  readonly code = "EXECUTION_TIMEOUT";
  readonly httpStatus = 504;
  override readonly retryable = true;

  constructor(capability: string, timeoutMs: number) {
    super({
      message: `${capability} exceeded ${String(timeoutMs)} ms`,
      userMessage: "The operation took too long and was interrupted.",
      context: { capability, timeoutMs },
    });
  }
}

/** Operation was cancelled by orchestrator or worker shutdown. */
export class ExecutionCancelledError extends AppError {
  readonly code = "EXECUTION_CANCELLED";
  readonly httpStatus = 499;
  override readonly severity: ErrorSeverity = "warning";

  constructor(capability: string, reason: string) {
    super({
      message: `${capability} cancelled: ${reason}`,
      userMessage: "The operation was cancelled.",
      context: { capability, reason },
    });
  }
}

/** Worker lacks valid session authentication. */
export class WorkerNotAuthenticatedError extends AppError {
  readonly code = "WORKER_NOT_AUTHENTICATED";
  readonly httpStatus = 401;
  override readonly retryable = true;

  constructor(reason: string) {
    super({
      message: `Worker not authenticated: ${reason}`,
      userMessage: "This device is not authenticated with NEXUS.",
      context: { reason },
    });
  }
}

/** Fatal configuration error preventing worker startup. */
export class WorkerConfigurationError extends AppError {
  readonly code = "WORKER_CONFIGURATION_INVALID";
  readonly httpStatus = 500;
  override readonly severity: ErrorSeverity = "fatal";

  constructor(issues: string[]) {
    super({
      message: `Invalid configuration: ${issues.join("; ")}`,
      userMessage: "The device configuration is invalid.",
      context: { issues },
    });
  }
}
