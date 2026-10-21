import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { LLMProviderError, type LLMProvider, type ProviderCapabilities } from "../provider.js";
import type {
  ContentBlock,
  GenerateRequest,
  GenerateResponse,
  LlmMessage,
  StopReason,
  StreamChunk,
  TokenUsage,
} from "../types.js";

/**
 * Anthropic adapter — the initial concrete provider.
 *
 * This is the ONLY file in the monorepo permitted to import `@anthropic-ai/sdk`
 * (cf. ADR-004). All inputs and outputs are mapped to and from `@nexus/llm`
 * neutral format; nothing provider-specific leaks into the agent core, except
 * `providerBlocks` which is opaque and merely transported.
 */

export interface AnthropicProviderOptions {
  /** If omitted, the SDK resolves `ANTHROPIC_API_KEY` or `ant auth login` profile. */
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /**
   * Reasoning effort. `high` is the API default; `xhigh` is suitable for long
   * agent tasks, `low` for routing and classification.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Injectable for integration tests; otherwise constructed from `apiKey`. */
  client?: Anthropic;
  baseURL?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_MAX_TOKENS = 16_000;

export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic";
  readonly model: string;
  readonly capabilities: ProviderCapabilities = {
    tools: true,
    vision: true,
    structuredOutput: true,
    maxContextTokens: 1_000_000,
  };

  readonly #client: Anthropic;
  readonly #maxTokens: number;
  readonly #effort: NonNullable<AnthropicProviderOptions["effort"]>;

  constructor(options: AnthropicProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#effort = options.effort ?? "high";
    this.#client =
      options.client ??
      new Anthropic({
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
        ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
        ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      });
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    try {
      // Systematic streaming: agent responses can be long, and high max_tokens
      // without streaming triggers SDK HTTP client timeouts.
      const stream = this.#client.messages.stream(
        this.#buildParams(request),
        request.signal ? { signal: request.signal } : {},
      );
      const message = await stream.finalMessage();
      return this.#toResponse(message);
    } catch (error) {
      throw this.#toProviderError(error);
    }
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    let stream;
    try {
      stream = this.#client.messages.stream(
        this.#buildParams(request),
        request.signal ? { signal: request.signal } : {},
      );
    } catch (error) {
      throw this.#toProviderError(error);
    }

    try {
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text_delta", delta: event.delta.text };
        }
      }
      const message = await stream.finalMessage();
      for (const call of this.#toResponse(message).content) {
        if (call.type === "tool_call") yield { type: "tool_call", call };
      }
      yield { type: "done", response: this.#toResponse(message) };
    } catch (error) {
      throw this.#toProviderError(error);
    }
  }

  async structuredOutput<T>(request: GenerateRequest, schema: z.ZodType<T>): Promise<T> {
    try {
      const message = await this.#client.messages.parse(
        {
          ...this.#buildParams(request),
          stream: false,
          output_config: { effort: this.#effort, format: zodOutputFormat(schema) },
        },
        request.signal ? { signal: request.signal } : {},
      );

      if (message.parsed_output === null || message.parsed_output === undefined) {
        throw new LLMProviderError(this.id, {
          message: "The model did not produce actionable structured output",
          retryable: true,
        });
      }
      return message.parsed_output;
    } catch (error) {
      throw this.#toProviderError(error);
    }
  }

  async countTokens(
    request: Pick<GenerateRequest, "messages" | "system" | "tools">,
  ): Promise<number> {
    try {
      const result = await this.#client.messages.countTokens({
        model: this.model,
        messages: this.#toApiMessages(request.messages),
        ...(request.system !== undefined ? { system: request.system } : {}),
        ...(request.tools?.length ? { tools: this.#toApiTools(request.tools) } : {}),
      });
      return result.input_tokens;
    } catch (error) {
      throw this.#toProviderError(error);
    }
  }

  #buildParams(request: GenerateRequest): Anthropic.MessageStreamParams {
    return {
      model: this.model,
      max_tokens: request.maxTokens ?? this.#maxTokens,
      messages: this.#toApiMessages(request.messages),
      // Adaptive thinking: model decides when and how much to deliberate.
      thinking: { type: "adaptive" },
      output_config: { effort: this.#effort },
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.tools?.length ? { tools: this.#toApiTools(request.tools) } : {}),
      ...(request.providerOptions ?? {}),
    };
  }

  #toApiTools(tools: NonNullable<GenerateRequest["tools"]>): Anthropic.Tool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));
  }

  #toApiMessages(messages: readonly LlmMessage[]): Anthropic.MessageParam[] {
    const out: Anthropic.MessageParam[] = [];

    for (const message of messages) {
      if (message.role === "system") continue; // passed via `system` parameter

      if (message.role === "tool") {
        out.push({
          role: "user",
          content: message.content
            .filter((block) => block.type === "tool_result")
            .map((block) => ({
              type: "tool_result" as const,
              tool_use_id: block.toolCallId,
              content: block.content,
              is_error: block.isError,
            })),
        });
        continue;
      }

      if (message.role === "assistant" && message.providerBlocks !== undefined) {
        // Replay provider blocks verbatim (thinking, signatures). Reconstructing
        // from neutral text would drop them, causing the provider to reject.
        out.push({
          role: "assistant",
          content: message.providerBlocks as Anthropic.ContentBlock[],
        });
        continue;
      }

      out.push({
        role: message.role,
        content: message.content.map((block) => this.#toApiBlock(block)),
      });
    }

    return out;
  }

  #toApiBlock(block: ContentBlock): Anthropic.ContentBlockParam {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "tool_call":
        return { type: "tool_use", id: block.id, name: block.name, input: block.arguments };
      case "tool_result":
        return {
          type: "tool_result",
          tool_use_id: block.toolCallId,
          content: block.content,
          is_error: block.isError,
        };
    }
  }

  #toResponse(message: Anthropic.Message): GenerateResponse {
    const content: ContentBlock[] = [];

    for (const block of message.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({
          type: "tool_call",
          id: block.id,
          name: block.name,
          // `input` is already deserialized by SDK — no string parsing here.
          arguments: block.input,
        });
      }
    }

    return {
      content,
      providerBlocks: message.content,
      stopReason: this.#toStopReason(message.stop_reason),
      usage: this.#toUsage(message.usage),
      model: message.model,
    };
  }

  #toStopReason(reason: Anthropic.Message["stop_reason"]): StopReason {
    switch (reason) {
      case "tool_use":
        return "tool_call";
      case "max_tokens":
        return "max_tokens";
      case "stop_sequence":
        return "stop_sequence";
      case "refusal":
        return "refusal";
      default:
        return "end_turn";
    }
  }

  #toUsage(usage: Anthropic.Usage): TokenUsage {
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ...(usage.cache_read_input_tokens !== null && usage.cache_read_input_tokens !== undefined
        ? { cacheReadTokens: usage.cache_read_input_tokens }
        : {}),
      ...(usage.cache_creation_input_tokens !== null &&
      usage.cache_creation_input_tokens !== undefined
        ? { cacheWriteTokens: usage.cache_creation_input_tokens }
        : {}),
    };
  }

  /**
   * Maps SDK errors into `LLMProviderError`.
   *
   * Distinguishes transient failures (429, 5xx, network) from fatal errors (400, 401).
   */
  #toProviderError(error: unknown): LLMProviderError {
    if (error instanceof LLMProviderError) return error;

    if (error instanceof Anthropic.APIError) {
      const rawStatus: unknown = error.status;
      const status = typeof rawStatus === "number" ? rawStatus : undefined;
      const retryable = status === undefined || status === 429 || status >= 500;
      return new LLMProviderError(this.id, {
        message: error.message,
        retryable,
        ...(status !== undefined ? { status } : {}),
        cause: error,
      });
    }

    if (error instanceof Error && error.name === "AbortError") {
      return new LLMProviderError(this.id, {
        message: "Generation cancelled",
        userMessage: "The operation was cancelled.",
        retryable: false,
        cause: error,
      });
    }

    return new LLMProviderError(this.id, {
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      cause: error,
    });
  }
}
