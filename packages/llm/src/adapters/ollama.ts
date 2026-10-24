import type { z } from "zod";
import { toolInputJsonSchema } from "../json-schema.js";
import { LLMProviderError, type LLMProvider, type ProviderCapabilities } from "../provider.js";
import { textOf, type GenerateRequest, type GenerateResponse, type StreamChunk } from "../types.js";

export class OllamaProvider implements LLMProvider {
  readonly id = "ollama";
  readonly model: string;
  readonly baseURL: string;
  readonly capabilities: ProviderCapabilities;
  readonly #timeoutMs: number;

  constructor(options: { baseURL?: string; model?: string; timeoutMs?: number } = {}) {
    this.baseURL = (options.baseURL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.model = options.model ?? "llama3.2";
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.capabilities = {
      tools: true,
      vision: false,
      structuredOutput: true,
      maxContextTokens: 32_000,
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(`${this.baseURL}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            ...(request.system === undefined ? [] : [{ role: "system", content: request.system }]),
            ...request.messages.map((message) => ({
              role: message.role,
              content: textOf(message.content),
            })),
          ],
          ...(request.tools === undefined
            ? {}
            : {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  },
                })),
              }),
        }),
        signal: request.signal ?? controller.signal,
      });
      if (!response.ok) {
        throw new LLMProviderError(this.id, {
          message: `Ollama returned status ${response.status}`,
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
        });
      }
      const payload = (await response.json()) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
        model?: string;
        done_reason?: string;
      };
      if (payload.message?.content === undefined) {
        throw new LLMProviderError(this.id, {
          message: "Ollama returned an invalid response",
          retryable: true,
        });
      }
      return {
        content: [{ type: "text", text: payload.message.content }],
        stopReason: payload.done_reason === "length" ? "max_tokens" : "end_turn",
        usage: {
          inputTokens: payload.prompt_eval_count ?? 0,
          outputTokens: payload.eval_count ?? 0,
        },
        model: payload.model ?? this.model,
      };
    } catch (error) {
      if (error instanceof LLMProviderError) throw error;
      throw new LLMProviderError(this.id, {
        message: "Ollama is unreachable",
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const response = await this.generate(request);
    yield { type: "text_delta", delta: textOf(response.content) };
    yield { type: "done", response };
  }

  async structuredOutput<T>(request: GenerateRequest, schema: z.ZodType<T>): Promise<T> {
    const response = await this.generate({
      ...request,
      system: `${request.system ?? ""}\nReturn only JSON matching: ${JSON.stringify(
        toolInputJsonSchema(schema),
      )}`,
    });
    try {
      return schema.parse(JSON.parse(textOf(response.content)) as unknown);
    } catch (error) {
      throw new LLMProviderError(this.id, {
        message: "Ollama output did not match the requested schema",
        retryable: true,
        cause: error,
      });
    }
  }

  countTokens(request: Pick<GenerateRequest, "messages" | "system" | "tools">): Promise<number> {
    return Promise.resolve(Math.ceil(JSON.stringify(request).length / 4));
  }
}
