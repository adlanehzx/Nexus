import { AppError, type AppErrorOptions } from "@nexus/shared";

/**
 * Erreurs MCP.
 *
 * Toutes sont exploitables par l'agent : elles portent un code stable, un
 * message sûr à afficher, et un caractère réessayable. Une panne de serveur MCP
 * ne doit jamais remonter comme une exception opaque.
 */

export class McpConnectionError extends AppError {
  readonly code = "MCP_CONNECTION_FAILED";
  readonly httpStatus = 502;
  override readonly retryable = true;
  readonly server: string;

  constructor(server: string, options: Omit<AppErrorOptions, "userMessage">) {
    super({
      ...options,
      userMessage: `Le serveur d'outils « ${server} » est injoignable.`,
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
      message: `${operation} sur « ${server} » a dépassé ${String(timeoutMs)} ms`,
      userMessage: `Le serveur d'outils « ${server} » ne répond pas assez vite.`,
      context: { server, timeoutMs, operation },
    });
    this.server = server;
  }
}

/**
 * Le serveur est configuré mais indisponible : jamais connecté, tombé, ou
 * circuit ouvert. Distincte d'une erreur de connexion : c'est un **état**, pas
 * un incident ponctuel.
 */
export class McpUnavailableError extends AppError {
  readonly code = "MCP_SERVER_UNAVAILABLE";
  readonly httpStatus = 503;
  override readonly retryable = true;
  readonly server: string;
  readonly status: string;

  constructor(server: string, status: string, detail?: string) {
    super({
      message: `Serveur MCP « ${server} » indisponible (état : ${status})${detail === undefined ? "" : ` — ${detail}`}`,
      userMessage: `L'outil demandé dépend du serveur « ${server} », actuellement indisponible. Réessaie plus tard ou utilise un autre moyen.`,
      context: { server, status, detail },
    });
    this.server = server;
    this.status = status;
  }
}

/** Le serveur a répondu, mais l'outil a signalé un échec (`isError: true`). */
export class McpToolCallError extends AppError {
  readonly code = "MCP_TOOL_FAILED";
  readonly httpStatus = 502;
  readonly server: string;
  readonly tool: string;

  constructor(server: string, tool: string, detail: string) {
    super({
      message: `L'outil MCP ${tool} (${server}) a échoué : ${detail}`,
      userMessage: detail,
      context: { server, tool },
    });
    this.server = server;
    this.tool = tool;
  }
}

/** Schéma d'outil inexploitable : on refuse l'outil plutôt que de deviner. */
export class McpSchemaError extends AppError {
  readonly code = "MCP_SCHEMA_UNSUPPORTED";
  readonly httpStatus = 500;
  readonly server: string;
  readonly tool: string;

  constructor(server: string, tool: string, reason: string) {
    super({
      message: `Schéma inexploitable pour ${tool} (${server}) : ${reason}`,
      userMessage: "Cet outil déclare un schéma que NEXUS ne sait pas interpréter.",
      context: { server, tool, reason },
    });
    this.server = server;
    this.tool = tool;
  }
}
