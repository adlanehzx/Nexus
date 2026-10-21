import { AppError, type AppErrorOptions, type ErrorSeverity } from "@nexus/shared";

/**
 * Erreurs communes aux exécutants.
 *
 * Elles étendent `AppError` du monorepo — même taxonomie, mêmes garanties :
 * `userMessage` est sûr à afficher, `context` ne l'est jamais, et `retryable`
 * dit au coordinateur s'il vaut la peine de recommencer ailleurs.
 *
 * La distinction qui compte : **refusé** (la politique l'interdit, inutile de
 * réessayer) contre **empêché** (la machine était occupée, un autre exécutant y
 * arrivera). Les confondre ferait soit boucler sur un refus définitif, soit
 * abandonner une tâche parfaitement exécutable.
 *
 * Ce qui est propre à une plateforme reste chez elle : `PathNotAllowedError`
 * n'a de sens que sur un poste de travail, `AccessibilityUnavailableError` que
 * sur Android.
 */

/** La capacité demandée n'est pas déclarée, ou a été désactivée localement. */
export class CapabilityUnavailableError extends AppError {
  readonly code = "CAPABILITY_UNAVAILABLE";
  readonly httpStatus = 404;

  constructor(capability: string, reason: string) {
    super({
      message: `Capacité ${capability} indisponible : ${reason}`,
      userMessage: `Cet appareil ne sait pas faire « ${capability} ».`,
      context: { capability, reason },
    });
  }
}

/** Les arguments ne respectent pas le schéma déclaré par la capacité. */
export class CapabilityInputError extends AppError {
  readonly code = "CAPABILITY_INPUT_INVALID";
  readonly httpStatus = 400;
  override readonly severity: ErrorSeverity = "warning";

  constructor(capability: string, issues: string[]) {
    super({
      message: `Arguments invalides pour ${capability} : ${issues.join(" ; ")}`,
      userMessage: `The arguments given for "${capability}" are invalid: ${issues.join("; ")}.`,
      context: { capability, issues },
    });
  }
}

/**
 * La politique locale refuse l'opération.
 *
 * Non réessayable, et c'est délibéré : une politique ne change pas entre deux
 * tentatives. Basculer sur une autre machine peut avoir du sens ; recommencer
 * sur celle-ci, jamais.
 */
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

/** L'exécution a dépassé son délai. Réessayable : la machine peut se libérer. */
export class ExecutionTimeoutError extends AppError {
  readonly code = "EXECUTION_TIMEOUT";
  readonly httpStatus = 504;
  override readonly retryable = true;

  constructor(capability: string, timeoutMs: number) {
    super({
      message: `${capability} a dépassé ${String(timeoutMs)} ms`,
      userMessage: "The operation took too long and was interrupted.",
      context: { capability, timeoutMs },
    });
  }
}

/** L'opération a été annulée — par NEXUS, ou par l'arrêt du worker. */
export class ExecutionCancelledError extends AppError {
  readonly code = "EXECUTION_CANCELLED";
  readonly httpStatus = 499;
  override readonly severity: ErrorSeverity = "warning";

  constructor(capability: string, reason: string) {
    super({
      message: `${capability} annulée : ${reason}`,
      userMessage: "The operation was cancelled.",
      context: { capability, reason },
    });
  }
}

/** Le worker n'a pas de session valide. */
export class WorkerNotAuthenticatedError extends AppError {
  readonly code = "WORKER_NOT_AUTHENTICATED";
  readonly httpStatus = 401;
  override readonly retryable = true;

  constructor(reason: string) {
    super({
      message: `Worker non authentifié : ${reason}`,
      userMessage: "This device is not authenticated with NEXUS.",
      context: { reason },
    });
  }
}

/** La configuration du worker est inutilisable. Fatal : rien ne peut démarrer. */
export class WorkerConfigurationError extends AppError {
  readonly code = "WORKER_CONFIGURATION_INVALID";
  readonly httpStatus = 500;
  override readonly severity: ErrorSeverity = "fatal";

  constructor(issues: string[]) {
    super({
      message: `Configuration invalide : ${issues.join(" ; ")}`,
      userMessage: "La configuration de l'appareil est invalide.",
      context: { issues },
    });
  }
}
