import { FreeLLM, Kilo, NIM, OVHcloud, type Provider } from "freelm";
import type { z } from "zod";
import { toolInputJsonSchema } from "../json-schema.js";
import { LLMProviderError, type LLMProvider, type ProviderCapabilities } from "../provider.js";
import {
  textOf,
  type ContentBlock,
  type GenerateRequest,
  type GenerateResponse,
  type LlmMessage,
  type StreamChunk,
} from "../types.js";

export type FreeLlmStrategy = "smart" | "priority" | "round_robin" | "quota_aware" | "latency";

export interface NativeFreeLlmProviderOptions {
  nvidiaApiKey?: string;
  allowKeyless?: boolean;
  model?: string;
  strategy?: FreeLlmStrategy;
  timeoutMs?: number;
}

/**
 * Native FreeLLM router used as a free-tier fallback by NEXUS.
 *
 * Only official provider APIs are enabled. NVIDIA NIM uses the key supplied by
 * the NEXUS vault; optional keyless routes are deliberately opt-in because
 * their operators may retain prompts. No secret is copied into logs or state.
 */
export class NativeFreeLlmProvider implements LLMProvider {
  readonly id = "freelm";
  readonly model: string;
  readonly capabilities: ProviderCapabilities = {
    tools: true,
    vision: false,
    structuredOutput: true,
    maxContextTokens: 128_000,
  };

  readonly #client: FreeLLM;

  constructor(options: NativeFreeLlmProviderOptions = {}) {
    const providers: Provider[] = [];
    const key = options.nvidiaApiKey?.trim();
    if (key !== undefined && key.length > 0) providers.push(new NIM(key));
    if (options.allowKeyless === true) {
      providers.push(new Kilo(null, { priority: 90 }), new OVHcloud({ priority: 100 }));
    }
    if (providers.length === 0) {
      throw new Error("FreeLLM requires an NVIDIA key or explicit keyless routes.");
    }
    this.model = options.model ?? "auto";
    this.#client = new FreeLLM(providers, {
      strategy: options.strategy ?? "quota_aware",
      timeout: (options.timeoutMs ?? 60_000) / 1_000,
      maxAttempts: 8,
      hedge: true,
      persist: false,
    });
  }

  health(): Record<string, unknown>[] {
    return this.#client.health() as Record<string, unknown>[];
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    try {
      const response = await this.#client.chat(toMessages(request.messages, request.system), {
        model: this.model,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
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
      });
      const content: ContentBlock[] = [];
      if (response.text.length > 0) content.push({ type: "text", text: response.text });
      for (const [index, call] of (response.toolCalls ?? []).entries()) {
        const candidate = call as {
          id?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        };
        const name = candidate.function?.name;
        if (typeof name !== "string" || name.length === 0) continue;
        content.push({
          type: "tool_call",
          id: typeof candidate.id === "string" ? candidate.id : `freelm-tool-${String(index)}`,
          name,
          arguments: parseArguments(candidate.function?.arguments),
        });
      }
      return {
        content,
        stopReason: (response.toolCalls?.length ?? 0) === 0 ? "end_turn" : "tool_call",
        usage: {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
        },
        model: response.model ?? this.model,
      };
    } catch (error) {
      if (error instanceof LLMProviderError) throw error;
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new LLMProviderError(this.id, {
        message: aborted ? "FreeLLM request was cancelled." : "FreeLLM providers are unavailable.",
        retryable: true,
        cause: error,
      });
    }
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const response = await this.generate(request);
    const text = textOf(response.content);
    if (text.length > 0) yield { type: "text_delta", delta: text };
    for (const block of response.content) {
      if (block.type === "tool_call") yield { type: "tool_call", call: block };
    }
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
      return schema.parse(JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? text) as unknown);
    } catch (error) {
      throw new LLMProviderError(this.id, {
        message: "FreeLLM output did not match the requested schema.",
        retryable: true,
        cause: error,
      });
    }
  }

  countTokens(request: Pick<GenerateRequest, "messages" | "system" | "tools">): Promise<number> {
    return Promise.resolve(Math.ceil(JSON.stringify(request).length / 4));
  }
}

function toMessages(messages: LlmMessage[], system?: string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] =
    system === undefined ? [] : [{ role: "system", content: system }];
  for (const message of messages) {
    const toolResult = message.content.find((block) => block.type === "tool_result");
    if (toolResult?.type === "tool_result") {
      result.push({
        role: "tool",
        content: toolResult.content,
        tool_call_id: toolResult.toolCallId,
      });
      continue;
    }
    const toolCalls = message.content
      .filter((block) => block.type === "tool_call")
      .map((block) => ({
        id: block.type === "tool_call" ? block.id : "",
        type: "function",
        function: {
          name: block.type === "tool_call" ? block.name : "",
          arguments: JSON.stringify(block.type === "tool_call" ? block.arguments : {}),
        },
      }));
    result.push({
      role: message.role,
      content: textOf(message.content),
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    });
  }
  return result;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
