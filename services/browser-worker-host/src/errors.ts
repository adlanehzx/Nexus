import { AppError, type ErrorSeverity } from "@nexus/shared";

/**
 * Erreurs propres à l'exécutant navigateur.
 *
 * Le reste vient de `@nexus/worker-core` — `CapabilityUnavailableError`,
 * `CapabilityInputError`, `ExecutionTimeoutError`, `ExecutionCancelledError`.
 * On ne redéclare que ce qui n'existe nulle part ailleurs, et chaque classe
 * répond à une question que les autres ne posent pas.
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
 * Le site demande une vérification humaine.
 *
 * **Ce n'est pas un échec technique, et ce n'est pas non plus un refus de
 * NEXUS.** C'est un point d'arrêt prévu : un CAPTCHA ou un second facteur
 * existe pour qu'un humain le franchisse. Le worker ne le contourne pas, ne le
 * résout pas, et n'essaie pas — il rend la main.
 *
 * `retryable` est faux : réessayer sans intervention humaine reproduira
 * exactement la même demande, et une reprise automatique donnerait à l'agent
 * l'illusion qu'insister peut marcher.
 */
export class HumanVerificationRequiredError extends AppError {
  readonly code = "BROWSER_NEEDS_HUMAN";
  readonly httpStatus = 409;
  override readonly severity: ErrorSeverity = "warning";
  override readonly retryable = false;

  constructor(capability: string, message: string) {
    super({
      message: `${capability} : vérification humaine requise`,
      // Rédigé pour être relayé tel quel : c'est l'utilisateur qui doit agir.
      userMessage: message,
      context: { capability },
    });
  }
}

/** La navigation s'est terminée sans produire de résultat exploitable. */
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
      message: `${capability} : tâche navigateur terminée en ${detail.status}`,
      userMessage:
        detail.message ?? `La navigation s'est terminée sans résultat (${detail.status}).`,
      // Le code du worker Python est conservé : il distingue un domaine refusé
      // d'un délai dépassé, et le perdre rendrait le diagnostic impossible.
      context: { capability, status: detail.status, workerCode: detail.code ?? null },
    });
    this.retryable = detail.retryable;
  }
}

/**
 * Le worker Python ne répond pas.
 *
 * Distinct d'un échec de tâche : ici rien n'a été tenté. C'est réessayable, et
 * le cœur peut légitimement redispatcher.
 */
export class BrowserWorkerUnreachableError extends AppError {
  readonly code = "BROWSER_WORKER_UNREACHABLE";
  readonly httpStatus = 503;
  override readonly retryable = true;

  constructor(cause?: string) {
    super({
      message: "le worker Browser Use ne répond pas",
      userMessage: "Le service de navigation n'est pas disponible pour le moment.",
      // L'URL n'y figure pas : elle nomme un service interne.
      context: cause === undefined ? {} : { cause },
    });
  }
}
