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
import { McpSandboxManager } from "./sandbox.js";
import { assertSafeRemoteUrl } from "./ssrf.js";

export const MAX_TOOL_OUTPUT_CHARS = 65_536;

export function boundOutputText(text: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n... [truncated by NEXUS: output exceeds max length]";
}

/**
 * MCP client.
 *
 * Thin wrapper around the official SDK adding timeouts, error taxonomy mapping,
 * secret resolution at startup, and connection lifecycle management.
 */

export type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "failed";

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  /**
   * Optional server hints.
   * Only used to raise risk, never lower it (cf. `tool-adapter.ts`).
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
  /** Concatenated text from content blocks for model consumption. */
  text: string;
  /** Structured output when provided by the server. */
  structured: unknown;
  isError: boolean;
}

/** Resolves secret references into values. Never logged. */
export type SecretResolver = (ref: string) => Promise<string | undefined>;

export interface McpClientOptions {
  config: McpServerConfig;
  /** Injected transport for testing against real protocol implementations. */
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
      throw new McpConnectionError(this.config.name, {
        message: `Connection to "${this.config.name}" failed: ${this.#lastError}`,
        cause: error,
        context: { transport: this.config.transport },
      });
    }
  }

  /** Gracefully closes the client session. */
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
      .map((entry) =>
        "text" in entry && typeof entry.text === "string"
          ? entry.text
          : `[${entry.mimeType ?? "binary"}] ${entry.uri}`,
      )
      .join("\n");

    return { text: boundOutputText(text), structured: result.contents, isError: false };
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
        if (typed.type === "resource") return `[resource] ${typed.resource?.uri ?? ""}`;
        return `[${typed.type ?? "content"}]`;
      })
      .join("\n");

    return {
      text: boundOutputText(text),
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
        message: `Server "${this.config.name}" not connected`,
      });
    }
    return this.#client;
  }

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
      const resolved = await this.#resolveEnv(config.env, config.envRefs);
      const baseEnv = { ...getDefaultEnvironment(), ...resolved };
      const prepared = config.sandbox?.enabled
        ? await McpSandboxManager.prepareStdio(config, baseEnv)
        : {
            command: config.command,
            args: config.args,
            env: baseEnv,
          };

      return new StdioClientTransport({
        command: prepared.command,
        args: prepared.args,
        env: prepared.env,
        ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
        stderr: "pipe",
      });
    }

    const headers = await this.#resolveEnv(config.headers, config.headerRefs);
    await assertSafeRemoteUrl(config.url, { serverName: config.name });
    const url = new URL(config.url);

    return (config.transport === "sse"
      ? new SSEClientTransport(url, { requestInit: { headers } })
      : new StreamableHTTPClientTransport(url, {
          requestInit: { headers },
        })) as unknown as Transport;
  }

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
