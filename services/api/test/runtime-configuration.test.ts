import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeConfigurationStore } from "../src/services/runtime-configuration.js";

describe("configuration administrable NEXUS", () => {
  it("persiste MCP, Browser Use et uniquement les noms de secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-runtime-"));
    const store = new RuntimeConfigurationStore(directory);

    await store.saveMcp([
      {
        name: "filesystem",
        enabled: false,
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
        env: {},
        envRefs: { TOKEN: "vault://nexus/mcp-token" },
        defaultPermissions: [],
        defaultRisk: "MEDIUM",
        toolPolicies: {},
        connectTimeoutMs: 15_000,
        requestTimeoutMs: 60_000,
        autoReconnect: true,
        maxReconnectAttempts: 5,
        reconnectInitialDelayMs: 500,
        reconnectMaxDelayMs: 30_000,
        circuitBreakerThreshold: 5,
        circuitBreakerResetMs: 60_000,
        exposeResources: true,
      },
    ]);
    await store.saveBrowser({
      enabled: false,
      baseUrl: "http://127.0.0.1:8100",
      tokenRef: "vault://nexus/browser-worker-token",
    });
    await store.saveSecretNames(["mcp-token", "browser-worker-token"]);

    expect((await store.loadMcp())[0]?.name).toBe("filesystem");
    expect((await store.loadBrowser())?.baseUrl).toBe("http://127.0.0.1:8100");
    expect(await store.listSecretNames()).toEqual(["browser-worker-token", "mcp-token"]);
    expect(await readFile(join(directory, "secret-refs.json"), "utf8")).not.toContain(
      "valeur-secrète",
    );
  });
});
