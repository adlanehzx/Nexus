import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMcpServerConfig } from "@nexus/mcp";
import {
  EncryptedFileVault,
  RuntimeConfigurationStore,
} from "../src/services/runtime-configuration.js";

describe("NEXUS manageable configuration", () => {
  it("persists MCP, Browser Use, and only secret names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-runtime-"));
    const store = new RuntimeConfigurationStore(directory);

    await store.saveMcp([
      parseMcpServerConfig({
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
      }),
    ]);
    await store.saveBrowser({
      enabled: false,
      mode: "local-harness",
      cdpUrl: "http://127.0.0.1:19222",
    });
    await store.saveSecretNames(["mcp-token", "browser-worker-token"]);

    expect((await store.loadMcp())[0]?.name).toBe("filesystem");
    expect((await store.loadBrowser())?.mode).toBe("local-harness");
    expect(await store.listSecretNames()).toEqual(["browser-worker-token", "mcp-token"]);
    expect(await readFile(join(directory, "secret-refs.json"), "utf8")).not.toContain(
      "secret-value",
    );
  });

  it("migrates legacy browser worker configuration on read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-runtime-legacy-"));
    const store = new RuntimeConfigurationStore(directory);
    await store.saveBrowser({
      enabled: false,
      mode: "remote-worker",
      baseUrl: "http://127.0.0.1:8100",
      tokenRef: "vault://nexus/browser-worker-token",
    });
    const current = JSON.parse(await readFile(join(directory, "browser.json"), "utf8")) as Record<
      string,
      unknown
    >;
    delete current.mode;
    await writeFile(join(directory, "browser.json"), JSON.stringify(current));

    expect(await store.loadBrowser()).toMatchObject({ mode: "remote-worker", enabled: false });
  });

  it("persists FreeLLM routing by vault reference without embedding an NVIDIA key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-freelm-"));
    const store = new RuntimeConfigurationStore(directory);

    await store.saveFreeLlm({
      enabled: true,
      model: "chat:tools",
      strategy: "quota_aware",
      allowKeyless: false,
      nvidiaKeyRef: "vault://nexus/nvidia-api-key",
    });

    expect(await store.loadFreeLlm()).toEqual({
      enabled: true,
      model: "chat:tools",
      strategy: "quota_aware",
      allowKeyless: false,
      nvidiaKeyRef: "vault://nexus/nvidia-api-key",
    });
    const persisted = await readFile(join(directory, "freelm.json"), "utf8");
    expect(persisted).not.toContain("nvapi-");
  });

  it("keeps concurrent atomic writes independent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-runtime-concurrent-"));
    const store = new RuntimeConfigurationStore(directory);

    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        store.saveSecretNames([`concurrent-secret-${String(index)}`]),
      ),
    );

    expect(await store.listSecretNames()).toHaveLength(1);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("persists encrypted secrets without writing their plaintext value", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-vault-"));
    const store = new RuntimeConfigurationStore(directory);
    const vault = new EncryptedFileVault(store, "test-master-key-with-at-least-32-characters");

    await vault.set("browser-worker-token", "never-store-this-token-in-plaintext");

    const persisted = await readFile(join(directory, "secrets.enc.json"), "utf8");
    expect(persisted).not.toContain("never-store-this-token-in-plaintext");
    expect(await vault.list()).toEqual(["browser-worker-token"]);
    expect(await vault.get("vault://nexus/browser-worker-token")).toBe(
      "never-store-this-token-in-plaintext",
    );

    const reopened = new EncryptedFileVault(
      new RuntimeConfigurationStore(directory),
      "test-master-key-with-at-least-32-characters",
    );
    expect(await reopened.get("vault://nexus/browser-worker-token")).toBe(
      "never-store-this-token-in-plaintext",
    );
  });
});
