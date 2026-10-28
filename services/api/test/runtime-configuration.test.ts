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

  it("persists paid and device LLM engines without embedding provider credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-llm-engines-"));
    const store = new RuntimeConfigurationStore(directory);

    await store.saveLlmRouting({
      enabled: true,
      preferLocal: true,
      engines: [
        {
          id: "private-ollama",
          label: "Private Ollama",
          enabled: true,
          priority: 10,
          model: "qwen3:14b",
          maxContextTokens: 32_768,
          kind: "device",
          runtime: "ollama",
          preferredDeviceId: "device-gpu",
          minimumGpuVramMb: 12_000,
        },
        {
          id: "openai-work",
          label: "OpenAI work account",
          enabled: true,
          priority: 20,
          model: "gpt-5-mini",
          maxContextTokens: 128_000,
          kind: "paid-api",
          provider: "openai",
          apiKeyRef: "vault://nexus/llm-openai-work",
          baseUrl: null,
          inputCostPerMillion: null,
          outputCostPerMillion: null,
        },
      ],
    });

    expect(await store.loadLlmRouting()).toMatchObject({
      enabled: true,
      preferLocal: true,
      engines: [{ kind: "device" }, { kind: "paid-api", provider: "openai" }],
    });
    const persisted = await readFile(join(directory, "llm-engines.json"), "utf8");
    expect(persisted).toContain("vault://nexus/llm-openai-work");
    expect(persisted).not.toContain("sk-");
  });

  it("rejects ambiguous engine identifiers and unsafe custom remote endpoints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-llm-invalid-"));
    const store = new RuntimeConfigurationStore(directory);
    const engine = {
      id: "custom",
      label: "Custom",
      enabled: true,
      priority: 10,
      model: "model",
      maxContextTokens: 8_192,
      kind: "paid-api" as const,
      provider: "openai-compatible" as const,
      apiKeyRef: "vault://nexus/custom-key",
      baseUrl: "http://models.example.test/v1",
      inputCostPerMillion: null,
      outputCostPerMillion: null,
    };

    await expect(
      store.saveLlmRouting({ enabled: true, preferLocal: false, engines: [engine] }),
    ).rejects.toThrow(/https/i);
    await expect(
      store.saveLlmRouting({
        enabled: true,
        preferLocal: false,
        engines: [
          { ...engine, baseUrl: "https://models.example.test/v1" },
          { ...engine, baseUrl: "https://other.example.test/v1" },
        ],
      }),
    ).rejects.toThrow(/duplicate/i);
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
