/**
 * Error taxonomy shared across the monorepo.
 *
 * Three core invariants held everywhere:
 *  1. `userMessage` is always safe to display to end-users; `context` never is.
 *  2. An error `code` is a public contract: it never changes once published.
 *  3. An error declares its own HTTP status and retryability — upper layers
 *     do not guess.
 */

export type ErrorSeverity = "warning" | "error" | "fatal";

export interface AppErrorOptions {
  /** Technical message intended for logs and diagnostics. */
  message: string;
  /** Safe message intended for display to the end user. */
  userMessage?: string;
  /** Diagnostic context. Never leaked across network boundaries. */
  context?: Record<string, unknown>;
  cause?: unknown;
}

export abstract class AppError extends Error {
  /** Stable public error contract code. */
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  readonly severity: ErrorSeverity = "error";
  readonly retryable: boolean = false;
  readonly userMessage: string;
  readonly context: Record<string, unknown> | undefined;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.userMessage = options.userMessage ?? "An error occurred.";
    this.context = options.context;
    Error.captureStackTrace?.(this, new.target);
  }

  /** Safe serialization: payload that can cross network boundaries. */
  toPublicJSON(): { code: string; message: string; retryable: boolean } {
    return { code: this.code, message: this.userMessage, retryable: this.retryable };
  }
}

export class ValidationError extends AppError {
  readonly code = "VALIDATION_ERROR";
  readonly httpStatus = 400;
  override readonly severity: ErrorSeverity = "warning";

  constructor(options: AppErrorOptions) {
    super({ userMessage: "The request is invalid.", ...options });
  }
}

export class AuthenticationError extends AppError {
  readonly code = "UNAUTHENTICATED";
  readonly httpStatus = 401;

  constructor(options: AppErrorOptions) {
    super({ userMessage: "Authentication required.", ...options });
  }
}

export class AuthorizationError extends AppError {
  readonly code = "FORBIDDEN";
  readonly httpStatus = 403;

  constructor(options: AppErrorOptions) {
    super({ userMessage: "Access denied.", ...options });
  }
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  readonly httpStatus = 404;
  override readonly severity: ErrorSeverity = "warning";

  constructor(options: AppErrorOptions) {
    super({ userMessage: "Resource not found.", ...options });
  }
}

export class ConflictError extends AppError {
  readonly code = "CONFLICT";
  readonly httpStatus = 409;

  constructor(options: AppErrorOptions) {
    super({ userMessage: "Conflict with the current state of the resource.", ...options });
  }
}

export class RateLimitError extends AppError {
  readonly code = "RATE_LIMITED";
  readonly httpStatus = 429;
  override readonly retryable = true;
  override readonly severity: ErrorSeverity = "warning";

  constructor(options: AppErrorOptions) {
    super({ userMessage: "Too many requests. Try again in a moment.", ...options });
  }
}

export class ConfigurationError extends AppError {
  readonly code = "CONFIGURATION_ERROR";
  readonly httpStatus = 500;
  override readonly severity: ErrorSeverity = "fatal";

  constructor(options: AppErrorOptions) {
    super({ userMessage: "The service is misconfigured.", ...options });
  }
}

export class DependencyError extends AppError {
  readonly code = "DEPENDENCY_UNAVAILABLE";
  readonly httpStatus = 503;
  override readonly retryable = true;

  constructor(options: AppErrorOptions) {
    super({ userMessage: "A service NEXUS depends on is unavailable.", ...options });
  }
}

export class InternalError extends AppError {
  readonly code = "INTERNAL_ERROR";
  readonly httpStatus = 500;

  constructor(options: AppErrorOptions) {
    super({ userMessage: "An internal error occurred.", ...options });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Normalizes any unknown thrown value to an AppError.
 * Error handling pipelines must never encounter unhandled throwables.
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    return new InternalError({ message: error.message, cause: error });
  }
  return new InternalError({ message: "Untyped error", context: { raw: String(error) } });
}
