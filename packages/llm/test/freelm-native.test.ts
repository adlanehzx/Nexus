import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeFreeLlmProvider } from "../src/adapters/freelm-native.js";

describe("NativeFreeLlmProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fails closed unless a provider is explicitly enabled", () => {
    expect(() => new NativeFreeLlmProvider()).toThrow(/NVIDIA key or explicit keyless/);
  });

  it("uses the official NVIDIA NIM endpoint and maps usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "completion-1",
          model: "nvidia/nemotron-test",
          choices: [
            { index: 0, message: { role: "assistant", content: "ready" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new NativeFreeLlmProvider({
      nvidiaApiKey: "nvapi-test-secret",
      model: "auto",
      strategy: "priority",
      timeoutMs: 5_000,
    });

    const response = await provider.generate({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });

    expect(response.content).toEqual([{ type: "text", text: "ready" }]);
    expect(response.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
    expect(response.model).toBe("nvidia/nemotron-test");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(init.headers).toMatchObject({ Authorization: "Bearer nvapi-test-secret" });
  });

  it("normalizes upstream failures without exposing the API key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("nvapi-sensitive-value")));
    const provider = new NativeFreeLlmProvider({ nvidiaApiKey: "nvapi-sensitive-value" });

    const failure = provider.generate({ messages: [] });
    await expect(failure).rejects.toMatchObject({ provider: "freelm", retryable: true });
    await expect(failure).rejects.not.toThrow(/nvapi-sensitive-value/);
  });
});
