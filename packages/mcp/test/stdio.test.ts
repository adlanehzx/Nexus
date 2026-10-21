import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { ToolRegistry, ToolExecutor, type ToolContext } from "@nexus/tools";
import { McpManager, parseMcpServerConfig, type McpEvent } from "../src/index.js";

/**
 * Real stdio transport tests.
 *
 * Spawns a real child process speaking the MCP protocol over stdin/stdout.
 */

const SERVER = fileURLToPath(new URL("./stdio-server.mjs", import.meta.url));

const managers: McpManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
});

function build(env: Record<string, string> = {}, overrides: Record<string, unknown> = {}) {
  const registry = new ToolRegistry();
  const events: McpEvent[] = [];
  const config = parseMcpServerConfig({
    name: "local",
    transport: "stdio",
    command: process.execPath,
    args: [SERVER],
    env,
    connectTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
    reconnectInitialDelayMs: 10,
    reconnectMaxDelayMs: 50,
    maxReconnectAttempts: 2,
    ...overrides,
  });

  const manager = new McpManager({ registry, configs: [config], onEvent: (e) => events.push(e) });
  managers.push(manager);
  return { manager, registry, events };
}

const context: Omit<ToolContext, "attempt"> = {
  runId: "run-1",
  userId: "user-1",
  conversationId: "conv-1",
  correlationId: "corr-1",
  signal: new AbortController().signal,
  idempotencyKey: "key-1",
  onProgress: () => undefined,
};

const executor = new ToolExecutor({ defaultTimeoutMs: 10_000, sleep: () => Promise.resolve() });

describe("stdio transport", () => {
  it("spawns server, discovers tools and executes them", async () => {
    const { manager, registry } = build();
    await manager.start();

    expect(manager.healthOf("local")?.status).toBe("connected");
    expect(manager.healthOf("local")?.serverInfo?.name).toBe("stdio-server");
    expect(registry.has("mcp.local.add")).toBe(true);

    const result = await executor.execute(
      registry.require("mcp.local.add"),
      { a: 2, b: 40 },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect((result.output as { text: string }).text).toBe("42");
  });

  it("does not inherit backend environment variables", async () => {
    process.env.NEXUS_PARENT_ONLY = "leak-forbidden";
    try {
      const { manager, registry } = build({ NEXUS_TEST_SECRET: "injected-value" });
      await manager.start();

      const result = await executor.execute(registry.require("mcp.local.whoami"), {}, context);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const payload = JSON.parse((result.output as { text: string }).text) as {
        secret: string;
        parentLeak: string;
      };

      expect(payload.secret).toBe("injected-value");
      expect(payload.parentLeak).toBe("(absent)");
    } finally {
      delete process.env.NEXUS_PARENT_ONLY;
    }
  });

  it("detects server process crash, reconnects and republishes tools", async () => {
    const { manager, registry, events } = build();
    await manager.start();
    expect(manager.healthOf("local")?.status).toBe("connected");

    await executor.execute(registry.require("mcp.local.crash"), {}, context);

    await waitUntil(
      () => events.some((event) => event.type === "server.disconnected"),
      "disconnection detected",
    );
    await waitUntil(
      () => manager.healthOf("local")?.status === "connected" && registry.has("mcp.local.add"),
      "reconnection and tool republication",
    );

    const result = await executor.execute(
      registry.require("mcp.local.add"),
      { a: 1, b: 1 },
      context,
    );
    expect(result.ok).toBe(true);
  });

  it("fails cleanly when command does not exist", async () => {
    const { manager, registry } = build({}, { command: "missing-binary-xyz-123" });
    const health = await manager.start();

    expect(health[0]?.status).toBe("failed");
    expect(health[0]?.lastError).toBeTruthy();
    expect(registry.size).toBe(0);
  });
});

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`condition not reached within timeout: ${label}`);
}
