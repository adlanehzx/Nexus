import { describe, expect, it } from "vitest";
import { FallbackProvider } from "../src/adapters/fallback-provider.js";
import { LLMProviderError } from "../src/provider.js";
import type { GenerateRequest, LLMProvider } from "../src/index.js";

/**
 * An exhausted fallback chain must stay diagnosable.
 *
 * The chain itself is deliberately untouched by these tests: what they pin is
 * that the terminal error names the engines that were tried, so an operator
 * can tell a missing configuration from an unreachable one.
 */

function failing(id: string, retryable = true): LLMProvider {
  return {
    id,
    model: `${id}-model`,
    capabilities: { tools: false, vision: false, structuredOutput: true, maxContextTokens: 1024 },
    generate: () =>
      Promise.reject(new LLMProviderError(id, { message: `${id} is down`, retryable })),
    stream: () => {
      throw new LLMProviderError(id, { message: `${id} is down`, retryable });
    },
    structuredOutput: () =>
      Promise.reject(new LLMProviderError(id, { message: `${id} is down`, retryable })),
    countTokens: () => Promise.resolve(0),
  };
}

const request = {
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
} as unknown as GenerateRequest;

describe("FallbackProvider diagnostics", () => {
  it("names every engine it tried when the whole chain fails", async () => {
    const provider = new FallbackProvider([failing("device-local"), failing("free-llm")]);

    await expect(provider.generate(request)).rejects.toMatchObject({
      code: "LLM_PROVIDER_ERROR",
      message: expect.stringContaining("device-local, free-llm"),
    });
  });

  it("carries an actionable user message rather than a bare failure", async () => {
    const provider = new FallbackProvider([failing("device-local")]);

    await expect(provider.generate(request)).rejects.toMatchObject({
      userMessage: expect.stringContaining("Settings"),
    });
  });

  it("reports the stage so streaming and structured output stay distinguishable", async () => {
    const provider = new FallbackProvider([failing("device-local")]);

    await expect(
      provider.structuredOutput(request, { parse: (value: unknown) => value } as never),
    ).rejects.toMatchObject({
      message: expect.stringContaining("for structured output"),
    });
  });

  it("still short-circuits on a non-retryable error instead of walking the chain", async () => {
    // The fallback mechanism must keep its existing behaviour: a hard failure
    // stops immediately and is surfaced as-is.
    const provider = new FallbackProvider([failing("bad-auth", false), failing("never-reached")]);

    await expect(provider.generate(request)).rejects.toMatchObject({
      message: expect.stringContaining("bad-auth is down"),
    });
  });
});
