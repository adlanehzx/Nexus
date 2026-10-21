/**
 * Taxonomie d'erreurs partagée par tout le monorepo.
 *
 * Trois principes, tenus partout :
 *  1. `userMessage` est toujours sûr à afficher ; `context` ne l'est jamais.
 *  2. Un `code` est un contrat public : il ne change pas une fois publié.
 *  3. Une erreur porte elle-même son statut HTTP et son caractère réessayable —
 *     les couches supérieures n'ont pas à le deviner.
 */

export type ErrorSeverity = "warning" | "error" | "fatal";

export interface AppErrorOptions {
  /** Message technique, destiné aux logs. */
  message: string;
  /** Message sûr à afficher à l'utilisateur final. */
  userMessage?: string;
  /** Données de diagnostic. Jamais renvoyées au client. */
  context?: Record<string, unknown>;
  cause?: unknown;
}

export abstract class AppError extends Error {
  /** Contrat public et stable. */
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  readonly severity: ErrorSeverity = "error";
  readonly retryable: boolean = false;
  readonly userMessage: string;
  readonly context: Record<string, unknown> | undefined;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.userMessage = options.userMessage ?? "Une erreur est survenue.";
    this.context = options.context;
    Error.captureStackTrace?.(this, new.target);
  }

  /** Représentation sûre : ce qui peut franchir la frontière réseau. */
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
    super({ userMessage: "Authentification requise.", ...options });
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
    super({ userMessage: "Ressource introuvable.", ...options });
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
    super({ userMessage: "Une erreur interne est survenue.", ...options });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Ramène n'importe quoi à une AppError. Le pipeline d'erreurs ne doit jamais
 * rencontrer une valeur qu'il ne sait pas traiter.
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    return new InternalError({ message: error.message, cause: error });
  }
  return new InternalError({ message: "Erreur non typée", context: { raw: String(error) } });
}
