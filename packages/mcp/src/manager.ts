import type { ToolDefinition, ToolRegistry } from "@nexus/tools";
import { McpClient, type McpConnectionStatus, type SecretResolver } from "./client.js";
import { describeConfig, type McpSbom, type McpServerConfig } from "./config.js";
import { adaptMcpResources } from "./resource-adapter.js";
import { adaptMcpTool } from "./tool-adapter.js";
import { McpSchemaError } from "./errors.js";
import { generateSbom } from "./sandbox.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * MCP Server Manager.
 *
 * Connects configured MCP servers, discovers their tools, adapts them,
 * and registers them into the `ToolRegistry`. The agent core consumes them as
 * standard `ToolDefinition`s without needing specific MCP logic (ADR-005).
 *
 * Handles lifecycle supervision: reconnection with exponential backoff,
 * circuit breaker, health monitoring, and graceful shutdown.
 */

export type McpServerHealthStatus =
  McpConnectionStatus | "disabled" | "circuit_open" | "reconnecting";

export interface McpServerHealth {
  name: string;
  status: McpServerHealthStatus;
  toolCount: number;
  lastError: string | undefined;
  consecutiveFailures: number;
  reconnectAttempts: number;
  circuitOpenUntil: number | undefined;
  serverInfo: { name: string; version: string } | undefined;
}

export type McpEvent =
  | { type: "server.connected"; server: string; toolCount: number }
  | { type: "server.disconnected"; server: string; willReconnect: boolean }
  | { type: "server.failed"; server: string; error: string; attempt: number }
  | { type: "server.circuit_opened"; server: string; until: number }
  | { type: "server.circuit_closed"; server: string }
  | { type: "tools.registered"; server: string; names: string[] }
  | { type: "tools.unregistered"; server: string; names: string[] };

export interface McpManagerOptions {
  registry: ToolRegistry;
  configs?: McpServerConfig[];
  resolveSecret?: SecretResolver;
  onEvent?: (event: McpEvent) => void;
  transports?: Record<string, Transport>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Connection {
  config: McpServerConfig;
  client: McpClient;
  toolNames: string[];
  consecutiveFailures: number;
  reconnectAttempts: number;
  circuitOpenUntil: number | undefined;
  reconnecting: boolean;
  connecting: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export class McpManager {
  readonly #registry: ToolRegistry;
  readonly #connections = new Map<string, Connection>();
  readonly #resolveSecret: SecretResolver | undefined;
  readonly #onEvent: ((event: McpEvent) => void) | undefined;
  readonly #transports: Record<string, Transport>;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #shuttingDown = false;

  constructor(options: McpManagerOptions) {
    this.#registry = options.registry;
    this.#resolveSecret = options.resolveSecret;
    this.#onEvent = options.onEvent;
    this.#transports = options.transports ?? {};
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;

    for (const config of options.configs ?? []) this.#addConnection(config);
  }

  /**
   * Connects all enabled servers and registers their tools.
   * Runs servers in parallel and independently: one failed server does not block others.
   */
  async start(): Promise<McpServerHealth[]> {
    this.#shuttingDown = false;
    await Promise.all(
      [...this.#connections.values()]
        .filter((connection) => connection.config.enabled)
        .map((connection) => this.#connectAndDiscover(connection)),
    );
    return this.health();
  }

  /** Dynamically adds an MCP server at runtime. */
  async addServer(config: McpServerConfig): Promise<McpServerHealth> {
    await this.removeServer(config.name);
    const connection = this.#addConnection(config);
    if (config.enabled) await this.#connectAndDiscover(connection);
    return this.#healthOf(connection);
  }

  /** Removes a server: unregisters its tools and closes connection. */
  async removeServer(name: string): Promise<boolean> {
    const connection = this.#connections.get(name);
    if (connection === undefined) return false;

    this.#unregisterTools(connection);
    await connection.client.close();
    this.#connections.delete(name);
    return true;
  }

  /**
   * Rediscover tools dynamically.
   */
  async refreshToolList(serverName?: string): Promise<McpServerHealth[]> {
    const targets =
      serverName === undefined
        ? [...this.#connections.values()]
        : [this.#connections.get(serverName)].filter((c): c is Connection => c !== undefined);

    await Promise.all(
      targets.map(async (connection) => {
        if (!connection.client.isConnected) return;
        await this.#discoverAndRegister(connection);
      }),
    );

    return serverName === undefined
      ? this.health()
      : targets.map((connection) => this.#healthOf(connection));
  }

  /** Forces a reconnection attempt, resetting circuit breaker. */
  async reconnect(name: string): Promise<McpServerHealth | undefined> {
    const connection = this.#connections.get(name);
    if (connection === undefined) return undefined;

    connection.circuitOpenUntil = undefined;
    connection.consecutiveFailures = 0;
    connection.reconnectAttempts = 0;
    await connection.client.close();
    await this.#connectAndDiscover(connection);
    return this.#healthOf(connection);
  }

  /** Graceful shutdown: closes every server connection cleanly. */
  async stop(): Promise<void> {
    this.#shuttingDown = true;
    await Promise.all(
      [...this.#connections.values()].map(async (connection) => {
        this.#unregisterTools(connection);
        await connection.client.close();
      }),
    );
  }

  health(): McpServerHealth[] {
    return [...this.#connections.values()].map((connection) => this.#healthOf(connection));
  }

  healthOf(name: string): McpServerHealth | undefined {
    const connection = this.#connections.get(name);
    return connection === undefined ? undefined : this.#healthOf(connection);
  }

  getSbom(serverName: string): McpSbom | undefined {
    const connection = this.#connections.get(serverName);
    return connection === undefined ? undefined : generateSbom(connection.config);
  }

  listSboms(): McpSbom[] {
    return [...this.#connections.values()].map((connection) => generateSbom(connection.config));
  }

  toolNames(serverName: string): string[] {
    return [...(this.#connections.get(serverName)?.toolNames ?? [])];
  }

  #addConnection(config: McpServerConfig): Connection {
    const client = new McpClient({
      config,
      ...(this.#transports[config.name] ? { transport: this.#transports[config.name] } : {}),
      ...(this.#resolveSecret ? { resolveSecret: this.#resolveSecret } : {}),
      onClose: () => {
        this.#handleDisconnect(config.name);
      },
    });

    const connection: Connection = {
      config,
      client,
      toolNames: [],
      consecutiveFailures: 0,
      reconnectAttempts: 0,
      circuitOpenUntil: undefined,
      reconnecting: false,
      connecting: false,
    };
    this.#connections.set(config.name, connection);
    return connection;
  }

  async #connectAndDiscover(connection: Connection): Promise<void> {
    if (this.#isCircuitOpen(connection)) return;

    connection.connecting = true;
    try {
      await connection.client.connect();
      connection.consecutiveFailures = 0;
      connection.reconnectAttempts = 0;
      if (connection.circuitOpenUntil !== undefined) {
        connection.circuitOpenUntil = undefined;
        this.#emit({ type: "server.circuit_closed", server: connection.config.name });
      }

      await this.#discoverAndRegister(connection);

      this.#emit({
        type: "server.connected",
        server: connection.config.name,
        toolCount: connection.toolNames.length,
      });
    } catch (error) {
      this.#recordFailure(connection, error);
    } finally {
      connection.connecting = false;
    }
  }

  async #discoverAndRegister(connection: Connection): Promise<void> {
    const { config, client } = connection;

    const tools = await client.listTools();
    const adapted: ToolDefinition<never, unknown>[] = [];

    for (const tool of tools) {
      if (config.toolPolicies[tool.name]?.disabled === true) continue;
      try {
        adapted.push(
          adaptMcpTool({
            client,
            config,
            tool,
            isAvailable: () => this.#isAvailable(config.name),
            unavailableReason: () => this.#unavailableReason(config.name),
          }) as unknown as ToolDefinition<never, unknown>,
        );
      } catch (error) {
        if (!(error instanceof McpSchemaError)) throw error;
      }
    }

    if (config.exposeResources && client.serverInfo !== undefined) {
      const capabilitiesAllowResources = await this.#supportsResources(connection);
      if (capabilitiesAllowResources) {
        adapted.push(
          ...adaptMcpResources({
            client,
            config,
            isAvailable: () => this.#isAvailable(config.name),
            unavailableReason: () => this.#unavailableReason(config.name),
          }),
        );
      }
    }

    const nextNames = adapted.map((tool) => tool.name);
    const removed = connection.toolNames.filter((name) => !nextNames.includes(name));
    for (const name of removed) this.#registry.unregister(name);
    if (removed.length > 0) {
      this.#emit({ type: "tools.unregistered", server: config.name, names: removed });
    }

    for (const tool of adapted) this.#registry.register(tool, { replace: true });
    connection.toolNames = nextNames;

    if (nextNames.length > 0) {
      this.#emit({ type: "tools.registered", server: config.name, names: nextNames });
    }
  }

  async #supportsResources(connection: Connection): Promise<boolean> {
    try {
      await connection.client.listResources();
      return true;
    } catch {
      return false;
    }
  }

  #handleDisconnect(name: string): void {
    const connection = this.#connections.get(name);
    if (connection === undefined || this.#shuttingDown || connection.connecting) return;

    const willReconnect = connection.config.autoReconnect && !this.#isCircuitOpen(connection);
    this.#emit({ type: "server.disconnected", server: name, willReconnect });

    if (willReconnect) void this.#scheduleReconnect(connection);
  }

  async #scheduleReconnect(connection: Connection): Promise<void> {
    if (connection.reconnecting) return;
    connection.reconnecting = true;

    try {
      while (
        !this.#shuttingDown &&
        connection.reconnectAttempts < connection.config.maxReconnectAttempts &&
        !connection.client.isConnected &&
        !this.#isCircuitOpen(connection)
      ) {
        connection.reconnectAttempts += 1;

        const delay = Math.min(
          connection.config.reconnectInitialDelayMs * Math.pow(2, connection.reconnectAttempts - 1),
          connection.config.reconnectMaxDelayMs,
        );
        await this.#sleep(delay);
        if (this.#shuttingDown) return;

        try {
          await connection.client.connect();
          connection.consecutiveFailures = 0;
          connection.reconnectAttempts = 0;
          await this.#discoverAndRegister(connection);
          this.#emit({
            type: "server.connected",
            server: connection.config.name,
            toolCount: connection.toolNames.length,
          });
          return;
        } catch (error) {
          this.#recordFailure(connection, error);
        }
      }
    } finally {
      connection.reconnecting = false;
    }
  }

  #recordFailure(connection: Connection, error: unknown): void {
    connection.consecutiveFailures += 1;
    const message = error instanceof Error ? error.message : String(error);

    this.#emit({
      type: "server.failed",
      server: connection.config.name,
      error: message,
      attempt: connection.consecutiveFailures,
    });

    if (connection.consecutiveFailures >= connection.config.circuitBreakerThreshold) {
      connection.circuitOpenUntil = this.#now() + connection.config.circuitBreakerResetMs;
      this.#unregisterTools(connection);
      this.#emit({
        type: "server.circuit_opened",
        server: connection.config.name,
        until: connection.circuitOpenUntil,
      });
    }
  }

  #unregisterTools(connection: Connection): void {
    if (connection.toolNames.length === 0) return;
    for (const name of connection.toolNames) this.#registry.unregister(name);
    this.#emit({
      type: "tools.unregistered",
      server: connection.config.name,
      names: [...connection.toolNames],
    });
    connection.toolNames = [];
  }

  #isCircuitOpen(connection: Connection): boolean {
    if (connection.circuitOpenUntil === undefined) return false;
    if (this.#now() < connection.circuitOpenUntil) return true;

    connection.circuitOpenUntil = undefined;
    connection.consecutiveFailures = 0;
    this.#emit({ type: "server.circuit_closed", server: connection.config.name });
    return false;
  }

  #isAvailable(name: string): boolean {
    const connection = this.#connections.get(name);
    return (
      connection !== undefined && connection.client.isConnected && !this.#isCircuitOpen(connection)
    );
  }

  #unavailableReason(name: string): { status: string; detail?: string } {
    const connection = this.#connections.get(name);
    if (connection === undefined) return { status: "unknown" };

    const status = this.#healthOf(connection).status;
    return connection.client.lastError === undefined
      ? { status }
      : { status, detail: connection.client.lastError };
  }

  #healthOf(connection: Connection): McpServerHealth {
    let status: McpServerHealthStatus;
    if (!connection.config.enabled) status = "disabled";
    else if (connection.circuitOpenUntil !== undefined && this.#now() < connection.circuitOpenUntil)
      status = "circuit_open";
    else if (connection.reconnecting) status = "reconnecting";
    else status = connection.client.status;

    return {
      name: connection.config.name,
      status,
      toolCount: connection.toolNames.length,
      lastError: connection.client.lastError,
      consecutiveFailures: connection.consecutiveFailures,
      reconnectAttempts: connection.reconnectAttempts,
      circuitOpenUntil: connection.circuitOpenUntil,
      serverInfo: connection.client.serverInfo,
    };
  }

  describe(): Record<string, unknown>[] {
    return [...this.#connections.values()].map((connection) => describeConfig(connection.config));
  }

  #emit(event: McpEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // Ignored
    }
  }
}
