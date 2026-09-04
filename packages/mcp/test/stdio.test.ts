import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { ToolRegistry, ToolExecutor, type ToolContext } from "@nexus/tools";
import { McpManager, parseMcpServerConfig, type McpEvent } from "../src/index.js";

/**
 * Transport stdio réel.
 *
 * Ces tests lancent un **vrai processus enfant** qui parle le vrai protocole MCP
 * sur stdin/stdout. C'est le seul moyen d'éprouver ce qu'un transport en mémoire
 * ne peut pas : le `spawn`, l'isolation de l'environnement, et la mort du
 * processus serveur.
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

describe("transport stdio", () => {
  it("lance le serveur, découvre ses outils et les exécute", async () => {
    const { manager, registry } = build();
    await manager.start();

    expect(manager.healthOf("local")?.status).toBe("connected");
    expect(manager.healthOf("local")?.serverInfo?.name).toBe("serveur-stdio");
    expect(registry.has("mcp.local.add")).toBe(true);

    const result = await executor.execute(
      registry.require("mcp.local.add"),
      { a: 2, b: 40 },
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect((result.output as { text: string }).text).toBe("42");
  });

  it("n'hérite d'aucune variable d'environnement du backend", async () => {
    process.env.NEXUS_PARENT_ONLY = "fuite-interdite";
    try {
      const { manager, registry } = build({ NEXUS_TEST_SECRET: "valeur-injectee" });
      await manager.start();

      const result = await executor.execute(registry.require("mcp.local.whoami"), {}, context);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const payload = JSON.parse((result.output as { text: string }).text) as {
        secret: string;
        parentLeak: string;
      };

      // Ce qu'on donne explicitement passe...
      expect(payload.secret).toBe("valeur-injectee");
      // ...et rien d'autre. Un serveur MCP tiers ne doit pas voir les secrets
      // applicatifs du backend simplement parce qu'ils sont dans son env.
      expect(payload.parentLeak).toBe("(absent)");
    } finally {
      delete process.env.NEXUS_PARENT_ONLY;
    }
  });

  it("détecte la mort du serveur, se reconnecte et republie ses outils", async () => {
    const { manager, registry, events } = build();
    await manager.start();
    expect(manager.healthOf("local")?.status).toBe("connected");

    // Le serveur répond, puis se tue : la panne survient à un instant maîtrisé.
    await executor.execute(registry.require("mcp.local.crash"), {}, context);

    // On attend la **condition**, pas une durée. Une pause fixe suppose de
    // savoir combien de temps met un processus enfant à mourir puis à renaître —
    // ce qui dépend de la charge de la machine. Sous une suite complète, lancer
    // un processus Node prend parfois plusieurs secondes, et le test échouait
    // alors sur une reconnexion qui avait simplement pris son temps.
    await waitUntil(
      () => events.some((event) => event.type === "server.disconnected"),
      "déconnexion détectée",
    );
    await waitUntil(
      () => manager.healthOf("local")?.status === "connected" && registry.has("mcp.local.add"),
      "reconnexion et republication des outils",
    );

    const result = await executor.execute(
      registry.require("mcp.local.add"),
      { a: 1, b: 1 },
      context,
    );
    expect(result.ok).toBe(true);
  });

  it("échoue proprement sur une commande inexistante", async () => {
    const { manager, registry } = build({}, { command: "binaire-absent-xyz-123" });
    const health = await manager.start();

    expect(health[0]?.status).toBe("failed");
    expect(health[0]?.lastError).toBeTruthy();
    expect(registry.size).toBe(0);
  });
});

/**
 * Attend une condition, en laissant tourner l'horloge.
 *
 * Ces tests pilotent de vrais processus enfants : leur rythme dépend de la
 * machine et de ce qui tourne à côté. Attendre une durée fixe revient à parier
 * sur cette charge, et le pari se perd quand la suite complète s'exécute en
 * parallèle.
 */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`condition jamais atteinte : ${label}`);
}
