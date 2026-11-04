import { describe, it, expect } from "vitest";
import { ModelCatalog, ProviderHub } from "../src/index.js";

describe("Unified Agent Providers Architecture", () => {
  it("initializes ModelCatalog with canonical models", () => {
    const catalog = new ModelCatalog();
    const models = catalog.listAll();
    expect(models.length).toBeGreaterThan(5);

    const claudeModel = catalog.get("claude", "claude-3-7-sonnet-20250219");
    expect(claudeModel).toBeDefined();
    expect(claudeModel?.supportsStreaming).toBe(true);
    expect(claudeModel?.maxOutputTokens).toBe(64000);

    const defaultModel = catalog.getDefault();
    expect(defaultModel?.provider).toBe("claude");
  });

  it("registers custom models in ModelCatalog", () => {
    const catalog = new ModelCatalog();
    catalog.registerCustomModel({
      id: "deepseek-r1-custom",
      provider: "openai",
      displayName: "DeepSeek R1 Custom",
      contextWindow: 128000,
      maxOutputTokens: 16384,
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsImages: false,
    });

    const custom = catalog.get("openai", "deepseek-r1-custom");
    expect(custom).toBeDefined();
    expect(custom?.displayName).toBe("DeepSeek R1 Custom");
  });

  it("spawns provider session via ProviderHub and streams chunks", async () => {
    const hub = new ProviderHub();
    const session = await hub.createSession({
      sessionId: "test-session-1",
      threadId: "test-thread-1",
      model: {
        provider: "claude",
        modelId: "claude-3-7-sonnet-20250219",
        reasoningEffort: "high",
        temperature: 0.5,
      },
      workspaceRoot: "/tmp",
    });

    expect(session.id).toBe("test-session-1");
    expect(session.providerType).toBe("claude");

    const events = [];
    for await (const event of session.sendPrompt("Refactor the parser")) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]?.type).toBe("text-delta");
    expect(events[events.length - 1]?.type).toBe("turn-complete");

    const closed = await hub.closeSession("test-session-1");
    expect(closed).toBe(true);
    expect(hub.getSession("test-session-1")).toBeUndefined();
  });

  it("resolves model fallback gracefully", () => {
    const hub = new ProviderHub();
    // Non-existent model should fallback to default for that provider or global default
    const fallback = hub.resolveFallback("claude", "non-existent-model");
    expect(fallback).toBeDefined();
    expect(fallback.provider).toBe("claude");
  });
});
