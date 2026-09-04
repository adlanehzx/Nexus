import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolRegistry } from "@nexus/tools";
import {
  McpManager,
  parseMcpServerConfig,
  type McpEvent,
  type McpServerConfig,
} from "../src/index.js";

/**
 * Serveurs MCP réels pour les tests.
 *
 * On ne simule **pas** le protocole : les deux extrémités utilisent le SDK
 * officiel, reliées par `InMemoryTransport.createLinkedPair()`. Les cadres
 * JSON-RPC, le handshake, les schémas et les erreurs sont ceux de vrais serveurs.
 * Seul le tuyau change — et c'est le SDK qui le fournit.
 */

export interface TestServerHandle {
  server: McpServer;
  clientTransport: Transport;
  /** Coupe la connexion comme le ferait un serveur qui tombe. */
  crash: () => Promise<void>;
}

export interface TestServerOptions {
  name?: string;
  /** Bloque `echo` jusqu'à libération — sert aux tests de délai. */
  hang?: boolean;
  withResources?: boolean;
  destructiveTool?: boolean;
  extraTool?: boolean;
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServerHandle> {
  const server = new McpServer({ name: options.name ?? "serveur-test", version: "1.2.3" });

  server.registerTool(
    "echo",
    {
      title: "Écho",
      description: "Renvoie le message fourni.",
      inputSchema: { message: z.string().min(1), times: z.number().int().min(1).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ message, times }) => {
      if (options.hang === true) await new Promise(() => undefined);
      return { content: [{ type: "text", text: message.repeat(times ?? 1) }] };
    },
  );

  server.registerTool("fail", { description: "Échoue toujours.", inputSchema: {} }, () => ({
    content: [{ type: "text", text: "quota dépassé" }],
    isError: true,
  }));

  if (options.destructiveTool === true) {
    server.registerTool(
      "wipe",
      {
        description: "Supprime tout.",
        inputSchema: { path: z.string() },
        // Le serveur se déclare inoffensif tout en étant destructeur : le cas
        // exact contre lequel les annotations ne doivent jamais abaisser le risque.
        annotations: { destructiveHint: true, readOnlyHint: true },
      },
      () => ({ content: [{ type: "text", text: "supprimé" }] }),
    );
  }

  if (options.extraTool === true) {
    server.registerTool(
      "extra",
      { description: "Outil apparu après coup.", inputSchema: {} },
      () => ({ content: [{ type: "text", text: "extra" }] }),
    );
  }

  if (options.withResources === true) {
    server.registerResource(
      "notes",
      "test://notes/1",
      { title: "Note", description: "Une note", mimeType: "text/plain" },
      () => ({ contents: [{ uri: "test://notes/1", text: "contenu de la note" }] }),
    );
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  return {
    server,
    clientTransport,
    crash: async () => {
      await serverTransport.close();
    },
  };
}

export function testConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return parseMcpServerConfig({
    name: "test",
    transport: "stdio",
    command: "node",
    args: [],
    connectTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    reconnectInitialDelayMs: 1,
    reconnectMaxDelayMs: 5,
    ...overrides,
  });
}

export interface ManagerHarness {
  manager: McpManager;
  registry: ToolRegistry;
  events: McpEvent[];
  sleeps: number[];
}

/** Monte un `McpManager` branché sur un transport réel injecté. */
export function makeManager(
  configs: McpServerConfig[],
  transports: Record<string, Transport>,
  options: { now?: () => number } = {},
): ManagerHarness {
  const registry = new ToolRegistry();
  const events: McpEvent[] = [];
  const sleeps: number[] = [];

  const manager = new McpManager({
    registry,
    configs,
    transports,
    onEvent: (event) => events.push(event),
    ...(options.now ? { now: options.now } : {}),
    // Le backoff est enregistré, jamais attendu : on teste son calcul, pas
    // la patience de la suite de tests.
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

  return { manager, registry, events, sleeps };
}
