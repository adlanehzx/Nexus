import { AppError, type AppErrorOptions } from "@nexus/shared";

/**
 * Erreurs du plan appareil.
 *
 * Elles suivent la taxonomie de `@nexus/shared` : code stable, message sûr à
 * afficher, caractère réessayable. Un échec de sélection n'est pas une panne —
 * c'est une observation que l'agent doit pouvoir relayer à l'utilisateur.
 */

export class DeviceNotFoundError extends AppError {
  readonly code = "DEVICE_NOT_FOUND";
  readonly httpStatus = 404;
  readonly deviceId: string;

  constructor(deviceId: string) {
    super({
      message: `Appareil inconnu : ${deviceId}`,
      userMessage: "Cet appareil n'est pas enregistré.",
      context: { deviceId },
    });
    this.deviceId = deviceId;
  }
}

/**
 * Aucun worker ne peut exécuter l'étape.
 *
 * `reasons` détaille pourquoi chaque candidat a été écarté : c'est ce que
 * l'agent relaie à l'utilisateur, et c'est la différence entre « je n'ai pas pu »
 * et « ton poste fixe est hors ligne, allume-le ou autorise ton portable ».
 */
export class NoEligibleWorkerError extends AppError {
  readonly code = "NO_ELIGIBLE_WORKER";
  readonly httpStatus = 409;
  override readonly retryable = true;
  readonly requiredCapabilities: readonly string[];
  readonly reasons: readonly string[];

  constructor(requiredCapabilities: readonly string[], reasons: readonly string[]) {
    super({
      message: `Aucun worker éligible pour ${requiredCapabilities.join(", ")}`,
      userMessage:
        reasons.length > 0
          ? `Aucun appareil ne peut faire ça : ${reasons.join(" ; ")}.`
          : "Aucun appareil disponible ne peut exécuter cette action.",
      context: { requiredCapabilities, reasons },
    });
    this.requiredCapabilities = requiredCapabilities;
    this.reasons = reasons;
  }
}

/** L'appareil ne déclare pas la capacité demandée. */
export class CapabilityNotRegisteredError extends AppError {
  readonly code = "CAPABILITY_NOT_REGISTERED";
  readonly httpStatus = 403;
  readonly deviceId: string;
  readonly capability: string;

  constructor(deviceId: string, capability: string) {
    super({
      message: `L'appareil ${deviceId} ne déclare pas la capacité ${capability}`,
      userMessage: "Cet appareil ne sait pas faire cette action.",
      context: { deviceId, capability },
    });
    this.deviceId = deviceId;
    this.capability = capability;
  }
}

export class DeviceRevokedError extends AppError {
  readonly code = "DEVICE_REVOKED";
  readonly httpStatus = 403;
  readonly deviceId: string;

  constructor(deviceId: string) {
    super({
      message: `Appareil révoqué : ${deviceId}`,
      userMessage: "Cet appareil a été révoqué et ne peut plus rien exécuter.",
      context: { deviceId },
    });
    this.deviceId = deviceId;
  }
}

export class DeviceAuthenticationError extends AppError {
  readonly code = "DEVICE_UNAUTHENTICATED";
  readonly httpStatus = 401;
  readonly deviceId: string;

  constructor(deviceId: string, reason: string, context: Record<string, unknown> = {}) {
    super({
      message: `Authentification refusée pour ${deviceId} : ${reason}`,
      userMessage: "L'appareil n'a pas pu s'authentifier.",
      context: { deviceId, reason, ...context },
    });
    this.deviceId = deviceId;
  }
}

/** Rejeu détecté, ou horodatage hors de la fenêtre acceptée. */
export class ReplayRejectedError extends AppError {
  readonly code = "DEVICE_REPLAY_REJECTED";
  readonly httpStatus = 401;

  constructor(options: AppErrorOptions) {
    super({ userMessage: "Requête rejetée : signature déjà utilisée ou périmée.", ...options });
  }
}

/** Le plan référence une étape inexistante, ou décrit un cycle. */
export class InvalidTaskPlanError extends AppError {
  readonly code = "INVALID_TASK_PLAN";
  readonly httpStatus = 400;
  readonly details: readonly string[];

  constructor(details: readonly string[]) {
    super({
      message: `Plan de tâche invalide : ${details.join(" ; ")}`,
      userMessage: "Ce plan de tâche est incohérent.",
      context: { details },
    });
    this.details = details;
  }
}
