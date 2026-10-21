import { AppError, type AppErrorOptions } from "@nexus/shared";

/**
 * MCP errors.
 *
 * All MCP errors are structured for agent consumption: stable code,
 * safe userMessage, and retryable flag. An MCP server failure must never
 * bubble up as an opaque exception.
 */

export class McpConnectionError extends AppError {
  readonly code = "MCP_CONNECTION_FAILED";
  readonly httpStatus = 502;
  override readonly retryable = true;
  readonly server: string;

  constructor(server: string, options: Omit<AppErrorOptions, "userMessage">) {
    super({
      ...options,
      userMessage: `The tool server "${server}" is unreachable.`,
      context: { server, ...options.context },
    });
    this.server = server;
  }
}

export class McpTimeoutError extends AppError {
  readonly code = "MCP_TIMEOUT";
  readonly httpStatus = 504;
  override readonly retryable = true;
  readonly server: string;

  constructor(server: string, timeoutMs: number, operation: string) {
    super({
      message: `${operation} on "${server}" exceeded ${String(timeoutMs)} ms`,
      userMessage: `The tool server "${server}" is not responding fast enough.`,
      context: { server, timeoutMs, operation },
    });
    this.server = server;
  }
}

/**
 * Server is configured but unavailable (disconnected, down, circuit open).
 * Represents a state rather than an isolated transient failure.
 */
export class McpUnavailableError extends AppError {
  readonly code = "MCP_SERVER_UNAVAILABLE";
  readonly httpStatus = 503;
  override readonly retryable = true;
  readonly server: string;
  readonly status: string;

  constructor(server: string, status: string, detail?: string) {
    super({
      message: `MCP server "${server}" unavailable (status: ${status})${detail === undefined ? "" : ` — ${detail}`}`,
      userMessage: `The requested tool depends on server "${server}", which is unavailable. Try again later, or use another means.`,
      context: { server, status, detail },
    });
    this.server = server;
    this.status = status;
  }
}

/** Server responded, but tool reported failure (`isError: true`). */
export class McpToolCallError extends AppError {
  readonly code = "MCP_TOOL_FAILED";
  readonly httpStatus = 502;
  readonly server: string;
  readonly tool: string;

  constructor(server: string, tool: string, detail: string) {
    super({
      message: `MCP tool ${tool} (${server}) failed: ${detail}`,
      userMessage: detail,
      context: { server, tool },
    });
    this.server = server;
    this.tool = tool;
  }
}

/** Unparseable or unsupported tool schema. */
export class McpSchemaError extends AppError {
  readonly code = "MCP_SCHEMA_UNSUPPORTED";
  readonly httpStatus = 500;
  readonly server: string;
  readonly tool: string;

  constructor(server: string, tool: string, reason: string) {
    super({
      message: `Unsupported schema for ${tool} (${server}): ${reason}`,
      userMessage: "This tool declares a schema NEXUS cannot interpret.",
      context: { server, tool, reason },
    });
    this.server = server;
    this.tool = tool;
  }
}

export class McpSecurityError extends AppError {
  readonly code = "MCP_SECURITY_VIOLATION";
  readonly httpStatus = 403;
  override readonly retryable = false;
  readonly server: string;

  constructor(server: string, reason: string) {
    super({
      message: `Security violation on MCP server "${server}": ${reason}`,
      userMessage: `Running MCP server "${server}" was blocked by the security policy.`,
      context: { server, reason },
    });
    this.server = server;
  }
}
