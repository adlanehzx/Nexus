import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isStdioConfig, type McpServerConfig } from "./config.js";
import { McpConnectionError, McpTimeoutError } from "./errors.js";

/**
 * Client MCP.
 *
 * Enveloppe fine autour du SDK officiel : elle ajoute les délais, la traduction
 * des erreurs vers notre taxonomie, la résolution des secrets au lancement, et
 * la remontée des ruptures de connexion. Elle **n'implémente pas** le protocole
 * — c'est le SDK qui s'en charge, et c'est délibéré.
 */

export type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "failed";

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  /**
   * Indications facultatives du serveur.
   *
   * Le SDK le dit explicitement : « Clients should never make tool use decisions
   * based on ToolAnnotations received from untrusted servers. » Elles ne servent
   * donc qu'à **élever** le risque, jamais à l'abaisser (cf. `tool-adapter.ts`).
   */
  annotations?: {
    title?: string | undefined;
    readOnlyHint?: boolean | undefined;
    destructiveHint?: boolean | undefined;
    idempotentHint?: boolean | undefined;
    openWorldHint?: boolean | undefined;
  };
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpCallResult {
  /** Texte concaténé des blocs de contenu — ce que le modèle lira. */
  text: string;
  /** Contenu structuré, quand le serveur en fournit un. */
  structured: unknown;
  isError: boolean;
}

/** Résout une référence de secret vers sa valeur. Jamais journalisée. */
export type SecretResolver = (ref: string) => Promise<string | undefined>;

export interface McpClientOptions {
  config: McpServerConfig;
  /** Transport injecté — utilisé par les tests, qui parlent le vrai protocole. */
  transport?: Transport;
  resolveSecret?: SecretResolver;
  onClose?: (error?: Error) => void;
  onError?: (error: Error) => void;
}

export class McpClient {
  readonly config: McpServerConfig;
  #client: Client | undefined;
  readonly #injectedTransport: Transport | undefined;
  readonly #resolveSecret: SecretResolver | undefined;
  readonly #onClose: ((error?: Error) => void) | undefined;
  readonly #onError: ((error: Error) => void) | undefined;
  #status: McpConnectionStatus = "disconnected";
  #lastError: string | undefined;

  constructor(options: McpClientOptions) {
    this.config = options.config;
    this.#injectedTransport = options.transport;
    this.#resolveSecret = options.resolveSecret;
    this.#onClose = options.onClose;
    this.#onError = options.onError;
  }

  get status(): McpConnectionStatus {
    return this.#status;
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }

  get isConnected(): boolean {
    return this.#status === "connected";
  }

  get serverInfo(): { name: string; version: string } | undefined {
    const info = this.#client?.getServerVersion();
    return info === undefined ? undefined : { name: info.name, version: info.version };
  }

  async connect(): Promise<void> {
    if (this.#status === "connected") return;
    this.#status = "connecting";
    this.#lastError = undefined;

    const client = new Client({ name: "nexus", version: "0.1.0" }, { capabilities: {} });

    // Une rupture de connexion est un événement normal, pas une exception : le
    // gestionnaire en est informé et décide de reconnecter.
    client.onclose = () => {
      this.#status = "disconnected";
      this.#onClose?.();
    };
    client.onerror = (error) => {
      this.#lastError = error.message;
      this.#onError?.(error);
    };

    try {
      const transport = this.#injectedTransport ?? (await this.#buildTransport());
      await client.connect(transport, { timeout: this.config.connectTimeoutMs });
      this.#client = client;
      this.#status = "connected";
    } catch (error) {
      this.#status = "failed";
      this.#lastError = error instanceof Error ? error.message : String(error);
      // La configuration est décrite sans ses valeurs sensibles.
      throw new McpConnectionError(this.config.name, {
        message: `Connexion à « ${this.config.name} » impossible : ${this.#lastError}`,
        cause: error,
        context: { transport: this.config.transport },
      });
    }
  }

  /** Ferme proprement : le processus enfant reçoit son signal, pas un SIGKILL. */
  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    this.#status = "disconnected";

    if (client === undefined) return;
    try {
      await client.close();
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const client = this.#require();
    const result = await this.#withTimeout(
      client.listTools(undefined, { timeout: this.config.requestTimeoutMs }),
      "listTools",
    );
    return result.tools.map((tool) => ({
      name: tool.name,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
      ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    }));
  }

  async listResources(): Promise<McpResourceInfo[]> {
    const client = this.#require();
    const result = await this.#withTimeout(
      client.listResources(undefined, { timeout: this.config.requestTimeoutMs }),
      "listResources",
    );
    return result.resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      ...(resource.title !== undefined ? { title: resource.title } : {}),
      ...(resource.description !== undefined ? { description: resource.description } : {}),
      ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
    }));
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpCallResult> {
    const client = this.#require();
    const result = await this.#withTimeout(
      client.readResource(
        { uri },
        { timeout: this.config.requestTimeoutMs, ...(signal ? { signal } : {}) },
      ),
      "readResource",
    );

    const text = result.contents
      // Une ressource MCP porte soit `text`, soit `blob` : on ne devine pas, on
      // teste. Un contenu binaire est annoncé, pas décodé au hasard.
      .map((entry) =>
        "text" in entry && typeof entry.text === "string"
          ? entry.text
          : `[${entry.mimeType ?? "binaire"}] ${entry.uri}`,
      )
      .join("\n");

    return { text, structured: result.contents, isError: false };
  }

  async callTool(
    name: string,
    args: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<McpCallResult> {
    const client = this.#require();

    const result = await this.#withTimeout(
      client.callTool({ name, arguments: args as Record<string, unknown> | undefined }, undefined, {
        timeout: options.timeoutMs ?? this.config.requestTimeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      `callTool(${name})`,
    );

    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((block) => {
        const typed = block as { type?: string; text?: string; resource?: { uri?: string } };
        if (typed.type === "text" && typeof typed.text === "string") return typed.text;
        if (typed.type === "resource") return `[ressource] ${typed.resource?.uri ?? ""}`;
        return `[${typed.type ?? "contenu"}]`;
      })
      .join("\n");

    return {
      text,
      structured: result.structuredContent ?? null,
      isError: result.isError === true,
    };
  }

  async ping(): Promise<boolean> {
    if (this.#client === undefined) return false;
    try {
      await this.#client.ping({ timeout: Math.min(this.config.connectTimeoutMs, 5_000) });
      return true;
    } catch {
      return false;
    }
  }

  #require(): Client {
    if (this.#client === undefined || this.#status !== "connected") {
      throw new McpConnectionError(this.config.name, {
        message: `Serveur « ${this.config.name} » non connecté`,
      });
    }
    return this.#client;
  }

  /**
   * Le SDK applique déjà son propre délai ; on traduit seulement son erreur en
   * `McpTimeoutError` pour que la boucle agent la reconnaisse comme réessayable.
   */
  async #withTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
    try {
      return await promise;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timed? ?out|timeout/i.test(message)) {
        throw new McpTimeoutError(this.config.name, this.config.requestTimeoutMs, operation);
      }
      throw error;
    }
  }

  async #buildTransport(): Promise<Transport> {
    const config = this.config;

    if (isStdioConfig(config)) {
      const env = await this.#resolveEnv(config.env, config.envRefs);
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        // Aucun héritage de l'environnement du backend : le serveur ne voit que
        // ce qu'on lui donne. `getDefaultEnvironment()` ne fournit que le
        // minimum vital (PATH, HOME…), sans le moindre secret applicatif.
        env: { ...getDefaultEnvironment(), ...env },
        ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
        // La sortie d'erreur du serveur est capturée, pas déversée dans la nôtre.
        stderr: "pipe",
      });
    }

    const headers = await this.#resolveEnv(config.headers, config.headerRefs);
    const url = new URL(config.url);

    // Les transports du SDK déclarent `sessionId?: string` sans `| undefined`,
    // ce que refuse `exactOptionalPropertyTypes`. Le décalage est purement
    // typographique : la conversion est sûre et confinée ici.
    return (config.transport === "sse"
      ? new SSEClientTransport(url, { requestInit: { headers } })
      : new StreamableHTTPClientTransport(url, {
          requestInit: { headers },
        })) as unknown as Transport;
  }

  /**
   * Fusionne les valeurs littérales et les secrets résolus.
   *
   * Les secrets n'existent qu'ici, le temps du lancement. Ils ne sont ni
   * stockés dans la configuration, ni renvoyés par `describeConfig`, ni
   * journalisés — et le modèle ne les voit jamais.
   */
  async #resolveEnv(
    literals: Record<string, string>,
    refs: Record<string, string>,
  ): Promise<Record<string, string>> {
    const resolved: Record<string, string> = { ...literals };

    for (const [key, ref] of Object.entries(refs)) {
      if (this.#resolveSecret === undefined) continue;
      const value = await this.#resolveSecret(ref);
      if (value !== undefined) resolved[key] = value;
    }
    return resolved;
  }
}
