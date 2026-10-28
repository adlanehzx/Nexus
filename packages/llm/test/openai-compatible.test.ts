import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../src/adapters/openai-compatible.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("OpenAI-compatible tool calls", () => {
  it("converts function calls into provider-neutral tool blocks", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    function: { name: "search", arguments: '{"query":"NEXUS"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = new OpenAICompatibleProvider({
      id: "custom",
      model: "custom-model",
      baseURL: "https://models.example.test",
      apiKey: "secret",
    });

    const response = await provider.generate({
      messages: [{ role: "user", content: [{ type: "text", text: "Search" }] }],
    });

    expect(response.stopReason).toBe("tool_call");
    expect(response.content).toEqual([
      {
        type: "tool_call",
        id: "call-1",
        name: "search",
        arguments: { query: "NEXUS" },
      },
    ]);
  });
});
