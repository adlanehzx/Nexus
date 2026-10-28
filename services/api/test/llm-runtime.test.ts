import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { textOf } from "@nexus/llm";
import { ScriptedLLMProvider } from "@nexus/llm/testing";
import {
  UnifiedLlmRuntimeProvider,
  type DeviceInferencePort,
} from "../src/services/llm-runtime.js";
import {
  EncryptedFileVault,
  RuntimeConfigurationStore,
} from "../src/services/runtime-configuration.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("unified LLM runtime", () => {
  it("routes to the user's paired device before a lower-numbered paid engine", async () => {
    const { store, vault } = await runtime();
    await vault.set("openai-key", "paid-secret-that-must-stay-in-the-vault");
    await store.saveLlmRouting({
      enabled: true,
      preferLocal: true,
      engines: [paidEngine(1), deviceEngine(100)],
    });
    const select = vi.fn().mockResolvedValue({
      device: { id: "gpu-worker", name: "Private GPU PC" },
      score: 1,
      candidates: [],
      rejected: [],
    });
    const dispatch = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        text: "local answer",
        model: "qwen3:14b",
        inputTokens: 4,
        outputTokens: 2,
        toolCalls: [],
      },
    });
    globalThis.fetch = vi.fn();
    const provider = new UnifiedLlmRuntimeProvider({
      runtime: store,
      vault,
      baseProviders: [],
      devices: {
        selector: { select },
        transport: { dispatch, cancel: vi.fn() },
      },
    });

    const response = await provider.generate({
      messages: [{ role: "user", content: [{ type: "text", text: "Private prompt" }] }],
      routingContext: { userId: "owner-1", runId: "run-1" },
    });

    expect(textOf(response.content)).toBe("local answer");
    expect(response.model).toBe("Private GPU PC/qwen3:14b");
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-1",
        requiredCapabilities: ["llm.inference"],
        preferredDeviceId: "gpu-worker",
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "gpu-worker", capability: "llm.inference" }),
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("uses a paid API key from the vault without returning or persisting it", async () => {
    const { store, vault } = await runtime();
    await vault.set("openai-key", "paid-secret-that-must-stay-in-the-vault");
    await store.saveLlmRouting({
      enabled: true,
      preferLocal: false,
      engines: [paidEngine(1)],
    });
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "paid answer" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
          model: "gpt-test",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = request;
    const provider = new UnifiedLlmRuntimeProvider({
      runtime: store,
      vault,
      baseProviders: [],
      devices: noDevices(),
    });

    const response = await provider.generate({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      routingContext: { userId: "owner-1" },
    });

    expect(textOf(response.content)).toBe("paid answer");
    const init = request.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer paid-secret-that-must-stay-in-the-vault",
    );
    expect(JSON.stringify(await provider.status())).not.toContain(
      "paid-secret-that-must-stay-in-the-vault",
    );
  });

  it("does not dispatch device inference without an authenticated routing context", async () => {
    const { store, vault } = await runtime();
    await store.saveLlmRouting({ enabled: true, preferLocal: true, engines: [deviceEngine(1)] });
    const select = vi.fn();
    const provider = new UnifiedLlmRuntimeProvider({
      runtime: store,
      vault,
      baseProviders: [],
      devices: {
        selector: { select },
        transport: { dispatch: vi.fn(), cancel: vi.fn() },
      },
    });

    await expect(
      provider.generate({
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }),
    ).rejects.toThrow(/configured/i);
    expect(select).not.toHaveBeenCalled();
  });

  it("falls back when the preferred private worker is unavailable", async () => {
    const { store, vault } = await runtime();
    await store.saveLlmRouting({ enabled: true, preferLocal: true, engines: [deviceEngine(1)] });
    const fallback = new ScriptedLLMProvider([{ kind: "final", text: "fallback answer" }]);
    const provider = new UnifiedLlmRuntimeProvider({
      runtime: store,
      vault,
      baseProviders: [fallback],
      devices: {
        selector: { select: vi.fn().mockRejectedValue(new Error("worker offline")) },
        transport: { dispatch: vi.fn(), cancel: vi.fn() },
      },
    });

    const response = await provider.generate({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      routingContext: { userId: "owner-1" },
    });

    expect(textOf(response.content)).toBe("fallback answer");
    expect(response.fallbackCount).toBe(1);
  });
});

async function runtime(): Promise<{
  store: RuntimeConfigurationStore;
  vault: EncryptedFileVault;
}> {
  const directory = await mkdtemp(join(tmpdir(), "nexus-llm-runtime-"));
  const store = new RuntimeConfigurationStore(directory);
  return {
    store,
    vault: new EncryptedFileVault(store, "test-master-key-with-at-least-32-characters"),
  };
}

function paidEngine(priority: number) {
  return {
    id: "paid-openai",
    label: "Paid OpenAI",
    enabled: true,
    priority,
    model: "gpt-test",
    maxContextTokens: 128_000,
    kind: "paid-api" as const,
    provider: "openai" as const,
    apiKeyRef: "vault://nexus/openai-key",
    baseUrl: null,
    inputCostPerMillion: null,
    outputCostPerMillion: null,
  };
}

function deviceEngine(priority: number) {
  return {
    id: "private-device",
    label: "Private device",
    enabled: true,
    priority,
    model: "qwen3:14b",
    maxContextTokens: 32_768,
    kind: "device" as const,
    runtime: "ollama" as const,
    preferredDeviceId: "gpu-worker",
    minimumGpuVramMb: 0,
  };
}

function noDevices(): DeviceInferencePort {
  return {
    selector: { select: vi.fn() },
    transport: { dispatch: vi.fn(), cancel: vi.fn() },
  };
}
