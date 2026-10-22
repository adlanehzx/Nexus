import { AppError } from "@nexus/shared";

/**
 * Errors specific to the Windows worker.
 *
 * Errors common to all workers — capability unavailable, invalid arguments,
 * policy violation, timeout, cancellation, configuration — live in
 * `@nexus/worker-core` and are re-exported here for existing callers.
 *
 * Only errors specific to a workstation environment remain here:
 * file paths and executables.
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

/** Target path falls outside allowed root directories. */
export class PathNotAllowedError extends AppError {
  readonly code = "PATH_NOT_ALLOWED";
  readonly httpStatus = 403;

  constructor(requested: string, reason: string) {
    super({
      // Requested path goes into context, not display message:
      // revealing the directory tree to an unauthorized caller is a leak.
      message: `Path not allowed (${reason})`,
      userMessage: "That path is outside the allowed directories.",
      context: { requested, reason },
    });
  }
}

/** Executable is not present in the allowed list. */
export class ExecutableNotAllowedError extends AppError {
  readonly code = "EXECUTABLE_NOT_ALLOWED";
  readonly httpStatus = 403;

  constructor(executable: string) {
    super({
      message: `Executable not allowed: ${executable}`,
      userMessage: `The program "${executable}" is not allowed on this device.`,
      context: { executable },
    });
  }
}
