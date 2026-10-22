import { AppError, type ErrorSeverity } from "@nexus/shared";

/**
 * Android worker specific errors.
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
 * Accessibility service is not enabled.
 */
export class AccessibilityDisabledError extends AppError {
  readonly code = "ANDROID_ACCESSIBILITY_DISABLED";
  readonly httpStatus = 403;
  override readonly retryable = true;

  constructor(capability: string) {
    super({
      message: `Accessibility service disabled, required by ${capability}`,
      userMessage:
        "The NEXUS accessibility service is not enabled on this phone. " +
        "Settings → Accessibility → Installed apps → NEXUS Worker.",
      context: { capability },
    });
  }
}

/** Required Android permission was not granted. */
export class AndroidPermissionDeniedError extends AppError {
  readonly code = "ANDROID_PERMISSION_DENIED";
  readonly httpStatus = 403;
  override readonly retryable = true;

  constructor(permission: string, howTo: string) {
    super({
      message: `Android permission denied: ${permission}`,
      userMessage: `This action needs a permission that was not granted. ${howTo}`,
      context: { permission },
    });
  }
}

/** Target UI element was not found on screen. */
export class UiNodeNotFoundError extends AppError {
  readonly code = "ANDROID_UI_NODE_NOT_FOUND";
  readonly httpStatus = 404;
  override readonly severity: ErrorSeverity = "warning";
  override readonly retryable = true;

  constructor(selectorKind: string) {
    super({
      message: `No element matches selector (${selectorKind})`,
      userMessage: "The target element was not found on screen.",
      context: { selectorKind },
    });
  }
}

/** Target app is not installed or not visible to the worker. */
export class AppNotAvailableError extends AppError {
  readonly code = "ANDROID_APP_NOT_AVAILABLE";
  readonly httpStatus = 404;

  constructor(packageName: string) {
    super({
      message: `Package not found or not visible: ${packageName}`,
      userMessage: `The app "${packageName}" is not installed on this phone.`,
      context: { packageName },
    });
  }
}

/**
 * System refused to start the activity.
 */
export class ActivityLaunchBlockedError extends AppError {
  readonly code = "ANDROID_ACTIVITY_LAUNCH_BLOCKED";
  readonly httpStatus = 403;
  override readonly retryable = true;

  constructor(packageName: string, reason: string) {
    super({
      message: `Launch blocked for ${packageName}: ${reason}`,
      userMessage:
        "Android refused to open the app from the background. " +
        'On Xiaomi/MIUI, allow "Display pop-up windows while running in the background" ' +
        "for NEXUS Worker.",
      context: { packageName, reason },
    });
  }
}
