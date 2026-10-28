import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalLlmCapability } from "../src/capabilities/llm.js";

describe("local LLM worker capability", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stays absent until a local runtime and model are explicitly configured", () => {
    expect(
      createLocalLlmCapability({
        runtime: "disabled",
        baseUrl: "http://127.0.0.1:11434",
        model: "",
        apiKey: undefined,
      }),
    ).toBeNull();
  });

  it("probes and executes Ollama without exposing the model server to Core", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: "qwen3:8b",
            message: { content: "local answer" },
            prompt_eval_count: 12,
            eval_count: 4,
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const capability = createLocalLlmCapability({
      runtime: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:8b",
      apiKey: undefined,
    });
    expect(capability).not.toBeNull();
    await expect(capability!.probe?.()).resolves.toBe(true);
    await expect(
      capability!.execute(
        { messages: [{ role: "user", content: "hello" }], maxTokens: 32 },
        {
          taskId: "task-1",
          stepId: "step-1",
          signal: new AbortController().signal,
          timeoutMs: 10_000,
          onProgress: () => undefined,
        },
      ),
    ).resolves.toMatchObject({
      text: "local answer",
      model: "qwen3:8b",
      inputTokens: 12,
      outputTokens: 4,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://127.0.0.1:11434/api/chat");
    expect(capability?.metadata).toEqual({
      runtime: "ollama",
      model: "qwen3:8b",
      privacy: "local_only",
    });
  });

  it("keeps an OpenAI-compatible local key inside the worker request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "local-model",
          choices: [{ message: { content: "ready" } }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const capability = createLocalLlmCapability({
      runtime: "openai-compatible",
      baseUrl: "http://127.0.0.1:8000",
      model: "local-model",
      apiKey: "worker-only-secret",
    });
    await capability!.execute(
      { messages: [{ role: "user", content: "hello" }] },
      {
        taskId: "task-1",
        stepId: "step-1",
        signal: new AbortController().signal,
        timeoutMs: 10_000,
        onProgress: () => undefined,
      },
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer worker-only-secret");
  });
});
