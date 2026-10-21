import { AppError, type AppErrorOptions } from "@nexus/shared";

/**
 * Capability execution errors.
 *
 * Every error carries `retryable`, governing executor retry policies.
 * Only plausibly transient failures are retried; invalid arguments will
 * remain invalid on retry.
 */

export class ToolNotFoundError extends AppError {
  readonly code = "TOOL_NOT_FOUND";
  readonly httpStatus = 404;
  readonly toolName: string;

  constructor(toolName: string) {
    super({
      message: `Unknown tool: ${toolName}`,
      userMessage: "This tool does not exist.",
      context: { toolName },
    });
    this.toolName = toolName;
  }
}

export class ToolInputValidationError extends AppError {
  readonly code = "TOOL_INPUT_INVALID";
  readonly httpStatus = 400;
  readonly toolName: string;
  readonly issues: unknown;

  constructor(toolName: string, issues: unknown) {
    const detail = formatValidationIssues(issues);
    super({
      message: `Invalid arguments for ${toolName}`,
      userMessage:
        detail === undefined
          ? "Invalid arguments supplied to tool."
          : `Invalid parameters: ${detail}`,
      context: { toolName, issues },
    });
    this.toolName = toolName;
    this.issues = issues;
  }
}

/** Formats Zod validation issues without leaking user argument values. */
function formatValidationIssues(issues: unknown): string | undefined {
  if (!Array.isArray(issues) || issues.length === 0) return undefined;

  const parts = issues.slice(0, 5).map((raw) => {
    const issue = raw as { path?: readonly PropertyKey[]; message?: string };
    const path = (issue.path ?? []).map(String).join(".");
    const message = issue.message ?? "invalid";
    return path.length > 0 ? `${path} — ${message}` : message;
  });

  return parts.join("; ");
}

/** Output non-conformance with declared schema. Represents a tool defect. */
export class ToolOutputValidationError extends AppError {
  readonly code = "TOOL_OUTPUT_INVALID";
  readonly httpStatus = 500;
  readonly toolName: string;
  readonly issues: unknown;

  constructor(toolName: string, issues: unknown) {
    super({
      message: `Output does not match declared schema for ${toolName}`,
      userMessage: "The tool returned an unexpected result.",
      context: { toolName, issues },
    });
    this.toolName = toolName;
    this.issues = issues;
  }
}

export class ToolTimeoutError extends AppError {
  readonly code = "TOOL_TIMEOUT";
  readonly httpStatus = 504;
  override readonly retryable = true;
  readonly toolName: string;
  readonly timeoutMs: number;

  constructor(toolName: string, timeoutMs: number) {
    super({
      message: `Tool ${toolName} timed out after ${String(timeoutMs)} ms`,
      userMessage: "The tool took too long to answer.",
      context: { toolName, timeoutMs },
    });
    this.toolName = toolName;
    this.timeoutMs = timeoutMs;
  }
}

export class ToolCancelledError extends AppError {
  readonly code = "TOOL_CANCELLED";
  readonly httpStatus = 499;
  readonly toolName: string;

  constructor(toolName: string) {
    super({
      message: `Execution of ${toolName} cancelled`,
      userMessage: "The operation was cancelled.",
      context: { toolName },
    });
    this.toolName = toolName;
  }
}

export class PermissionDeniedError extends AppError {
  readonly code = "PERMISSION_DENIED";
  readonly httpStatus = 403;
  readonly toolName: string;
  readonly missing: readonly string[];

  constructor(toolName: string, missing: readonly string[]) {
    super({
      message: `Missing permissions for ${toolName}: ${missing.join(", ")}`,
      userMessage: "This action is not allowed.",
      context: { toolName, missing },
    });
    this.toolName = toolName;
    this.missing = missing;
  }
}

/** Error thrown by tool itself. Retryable only if explicitly declared. */
export class ToolExecutionError extends AppError {
  readonly code = "TOOL_EXECUTION_FAILED";
  readonly httpStatus = 502;
  override readonly retryable: boolean;
  readonly toolName: string;

  constructor(toolName: string, options: AppErrorOptions & { retryable?: boolean }) {
    super(options);
    this.toolName = toolName;
    this.retryable = options.retryable ?? false;
  }
}

/** Raised by a tool to signal a transient failure (network, 429, 5xx). */
export class RetryableToolError extends ToolExecutionError {
  constructor(toolName: string, options: AppErrorOptions) {
    super(toolName, { ...options, retryable: true });
  }
}

/** Normalized failure result representation for agent models. */
export interface NormalizedToolError {
  code: string;
  message: string;
  retryable: boolean;
}

export function normalizeToolError(error: unknown, toolName: string): NormalizedToolError {
  if (error instanceof AppError) {
    return { code: error.code, message: error.userMessage, retryable: error.retryable };
  }
  const wrapped = new ToolExecutionError(toolName, {
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
  return { code: wrapped.code, message: wrapped.userMessage, retryable: false };
}
