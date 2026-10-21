import { AppError, type ErrorSeverity } from "@nexus/shared";

/**
 * Erreurs propres au worker Android.
 *
 * Les erreurs communes — capacité indisponible, arguments invalides, violation
 * de politique, délai, annulation — viennent de `@nexus/worker-core` et sont
 * réexportées pour les appelants. Ne restent ici que celles qui décrivent une
 * contrainte du système Android, parce qu'un message générique n'aiderait pas :
 * « permission refusée » et « le service d'accessibilité est désactivé »
 * n'appellent pas la même action de la part de l'utilisateur.
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

/**
 * Le service d'accessibilité n'est pas activé.
 *
 * Réessayable : l'utilisateur peut l'activer, et la tâche aboutira alors. Le
 * message dit exactement quoi faire — un « permission refusée » laisserait
 * chercher dans les réglages de l'application, où il n'y a rien à trouver.
 */
export class AccessibilityDisabledError extends AppError {
  readonly code = "ANDROID_ACCESSIBILITY_DISABLED";
  readonly httpStatus = 403;
  override readonly retryable = true;

  constructor(capability: string) {
    super({
      message: `Service d'accessibilité désactivé, requis par ${capability}`,
      userMessage:
        "The NEXUS accessibility service is not enabled on this phone. " +
        "Settings → Accessibility → Installed apps → NEXUS Worker.",
      context: { capability },
    });
  }
}

/** Une permission Android nécessaire n'a pas été accordée. */
export class AndroidPermissionDeniedError extends AppError {
  readonly code = "ANDROID_PERMISSION_DENIED";
  readonly httpStatus = 403;
  override readonly retryable = true;

  constructor(permission: string, howTo: string) {
    super({
      message: `Permission Android refusée : ${permission}`,
      userMessage: `This action needs a permission that was not granted. ${howTo}`,
      context: { permission },
    });
  }
}

/** L'élément d'interface visé n'existe pas à l'écran. */
export class UiNodeNotFoundError extends AppError {
  readonly code = "ANDROID_UI_NODE_NOT_FOUND";
  readonly httpStatus = 404;
  override readonly severity: ErrorSeverity = "warning";
  // Réessayable : l'écran a pu changer entre la décision et l'action, et une
  // nouvelle tentative après rafraîchissement peut aboutir.
  override readonly retryable = true;

  constructor(selectorKind: string) {
    super({
      message: `Aucun élément ne correspond au sélecteur (${selectorKind})`,
      userMessage: "The target element was not found on screen.",
      context: { selectorKind },
    });
  }
}

/** L'application visée n'est pas installée, ou n'est pas visible du worker. */
export class AppNotAvailableError extends AppError {
  readonly code = "ANDROID_APP_NOT_AVAILABLE";
  readonly httpStatus = 404;

  constructor(packageName: string) {
    super({
      message: `Paquet introuvable ou non visible : ${packageName}`,
      userMessage: `The app "${packageName}" is not installed on this phone.`,
      context: { packageName },
    });
  }
}

/**
 * Le système a refusé de lancer l'activité.
 *
 * Cas courant depuis Android 10 : une application en arrière-plan ne peut pas
 * démarrer une activité sans exemption. Sur MIUI, une autorisation
 * supplémentaire — « Afficher les fenêtres contextuelles en arrière-plan » —
 * s'y ajoute, et son absence produit exactement ce refus.
 */
export class ActivityLaunchBlockedError extends AppError {
  readonly code = "ANDROID_ACTIVITY_LAUNCH_BLOCKED";
  readonly httpStatus = 403;
  override readonly retryable = true;

  constructor(packageName: string, reason: string) {
    super({
      message: `Lancement bloqué pour ${packageName} : ${reason}`,
      userMessage:
        "Android refused to open the app from the background. " +
        'On Xiaomi/MIUI, allow "Display pop-up windows while running in the background" ' +
        "for NEXUS Worker.",
      context: { packageName, reason },
    });
  }
}
