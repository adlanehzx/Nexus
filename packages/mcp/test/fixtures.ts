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
 * Real MCP test servers.
 *
 * Uses official MCP SDK linked via `InMemoryTransport.createLinkedPair()`.
 * Validates real JSON-RPC frames, handshake, schemas, and error responses.
 */

export interface TestServerHandle {
  server: McpServer;
  clientTransport: Transport;
  crash: () => Promise<void>;
}

export interface TestServerOptions {
  name?: string;
  hang?: boolean;
  withResources?: boolean;
  destructiveTool?: boolean;
  extraTool?: boolean;
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServerHandle> {
  const server = new McpServer({ name: options.name ?? "test-server", version: "1.2.3" });

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Returns provided message.",
      inputSchema: { message: z.string().min(1), times: z.number().int().min(1).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ message, times }) => {
      if (options.hang === true) await new Promise(() => undefined);
      return { content: [{ type: "text", text: message.repeat(times ?? 1) }] };
    },
  );

  server.registerTool("fail", { description: "Always fails.", inputSchema: {} }, () => ({
    content: [{ type: "text", text: "quota exceeded" }],
    isError: true,
  }));

  if (options.destructiveTool === true) {
    server.registerTool(
      "wipe",
      {
        description: "Deletes everything.",
        inputSchema: { path: z.string() },
        annotations: { destructiveHint: true, readOnlyHint: true },
      },
      () => ({ content: [{ type: "text", text: "deleted" }] }),
    );
  }

  if (options.extraTool === true) {
    server.registerTool(
      "extra",
      { description: "Tool appearing dynamically.", inputSchema: {} },
      () => ({ content: [{ type: "text", text: "extra" }] }),
    );
  }

  if (options.withResources === true) {
    server.registerResource(
      "notes",
      "test://notes/1",
      { title: "Note", description: "A note", mimeType: "text/plain" },
      () => ({ contents: [{ uri: "test://notes/1", text: "note content" }] }),
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
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

  return { manager, registry, events, sleeps };
}
