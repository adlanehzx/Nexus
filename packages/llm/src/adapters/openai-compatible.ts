import type { z } from "zod";
import { toolInputJsonSchema } from "../json-schema.js";
import { LLMProviderError, type LLMProvider, type ProviderCapabilities } from "../provider.js";
import { textOf, type GenerateRequest, type GenerateResponse, type StreamChunk } from "../types.js";

export interface OpenAICompatibleProviderOptions {
  id: string;
  model: string;
  baseURL: string;
  apiKey?: string;
  timeoutMs?: number;
  capabilities?: Partial<ProviderCapabilities>;
}

interface CompletionPayload {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  readonly baseURL: string;
  readonly capabilities: ProviderCapabilities;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.id = options.id;
    this.model = options.model;
    this.baseURL = options.baseURL.replace(/\/$/, "");
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.capabilities = {
      tools: true,
      vision: false,
      structuredOutput: true,
      maxContextTokens: 32_000,
      ...options.capabilities,
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    const signal = request.signal ?? controller.signal;
    try {
      const response = await fetch(`${this.baseURL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.#apiKey === undefined ? {} : { authorization: `Bearer ${this.#apiKey}` }),
        },
        body: JSON.stringify({
          model: this.model,
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
          ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
          stream: false,
        }),
        signal,
      });
      if (!response.ok) {
        throw new LLMProviderError(this.id, {
          message: `OpenAI-compatible engine returned status ${response.status}`,
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
        });
      }
      const payload = (await response.json()) as CompletionPayload;
      const choice = payload.choices?.[0];
      if (choice?.message?.content === undefined) {
        throw new LLMProviderError(this.id, {
          message: "OpenAI-compatible engine returned an invalid response",
          retryable: true,
        });
      }
      return {
        content: [{ type: "text", text: choice.message.content }],
        stopReason: choice.finish_reason === "length" ? "max_tokens" : "end_turn",
        usage: {
          inputTokens: payload.usage?.prompt_tokens ?? 0,
          outputTokens: payload.usage?.completion_tokens ?? 0,
        },
        model: payload.model ?? this.model,
      };
    } catch (error) {
      if (error instanceof LLMProviderError) throw error;
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new LLMProviderError(this.id, {
        message: aborted ? "Engine request timed out or was cancelled" : "Engine is unreachable",
        retryable: !aborted,
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
      system: `${request.system ?? ""}\nReturn only JSON matching this schema: ${JSON.stringify(
        toolInputJsonSchema(schema),
      )}`,
    });
    try {
      const text = textOf(response.content);
      const fenced = /\{[\s\S]*\}/.exec(text)?.[0] ?? text;
      return schema.parse(JSON.parse(fenced) as unknown);
    } catch (error) {
      throw new LLMProviderError(this.id, {
        message: "Engine output did not match the requested schema",
        retryable: true,
        cause: error,
      });
    }
  }

  countTokens(request: Pick<GenerateRequest, "messages" | "system" | "tools">): Promise<number> {
    return Promise.resolve(Math.ceil(JSON.stringify(request).length / 4));
  }
}

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(options: { apiKey: string; model?: string; baseURL?: string; timeoutMs?: number }) {
    super({
      id: "deepseek",
      model: options.model ?? "deepseek-chat",
      baseURL: options.baseURL ?? "https://api.deepseek.com",
      apiKey: options.apiKey,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      capabilities: { maxContextTokens: 64_000 },
    });
  }
}

export class FreeLlmProvider extends OpenAICompatibleProvider {
  constructor(options: { baseURL: string; model: string; apiKey?: string; timeoutMs?: number }) {
    super({ id: "freellm", ...options });
  }
}

export class LlamaCppProvider extends OpenAICompatibleProvider {
  constructor(options: { baseURL?: string; model?: string; timeoutMs?: number } = {}) {
    super({
      id: "llama.cpp",
      model: options.model ?? "local-model",
      baseURL: options.baseURL ?? "http://127.0.0.1:8080",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }
}

export class VllmProvider extends OpenAICompatibleProvider {
  constructor(options: { baseURL?: string; model: string; apiKey?: string; timeoutMs?: number }) {
    super({
      id: "vllm",
      baseURL: options.baseURL ?? "http://127.0.0.1:8000",
      ...options,
    });
  }
}
