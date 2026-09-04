import { AppError } from "@nexus/shared";

/**
 * Erreurs propres au worker Windows.
 *
 * Les erreurs communes à tous les exécutants — capacité indisponible, arguments
 * invalides, violation de politique, délai, annulation, configuration — vivent
 * dans `@nexus/worker-core` et sont réexportées ici pour les appelants existants.
 *
 * Ne restent en propre que celles qui n'ont de sens que sur un poste de travail :
 * un chemin de fichier et un exécutable.
 */

export {
  CapabilityUnavailableError,
  CapabilityInputError,
  PolicyViolationError,
  ExecutionTimeoutError,
  ExecutionCancelledError,
  WorkerNotAuthenticatedError,
  WorkerConfigurationError,
} from "@nexus/worker-core";

/** Le chemin visé sort des racines autorisées. */
export class PathNotAllowedError extends AppError {
  readonly code = "PATH_NOT_ALLOWED";
  readonly httpStatus = 403;

  constructor(requested: string, reason: string) {
    super({
      // Le chemin demandé va dans le contexte, pas dans le message affiché :
      // révéler l'arborescence d'une machine à un appelant qui n'y a pas accès
      // est déjà une fuite.
      message: `Chemin refusé (${reason})`,
      userMessage: "Ce chemin est en dehors des dossiers autorisés.",
      context: { requested, reason },
    });
  }
}

/** L'exécutable n'est pas dans la liste autorisée. */
export class ExecutableNotAllowedError extends AppError {
  readonly code = "EXECUTABLE_NOT_ALLOWED";
  readonly httpStatus = 403;

  constructor(executable: string) {
    super({
      message: `Exécutable non autorisé : ${executable}`,
      userMessage: `Le programme « ${executable} » n'est pas autorisé sur cet appareil.`,
      context: { executable },
    });
  }
}
