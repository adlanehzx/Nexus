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
 * Adaptateur Anthropic — le premier fournisseur concret.
 *
 * C'est le SEUL fichier du monorepo autorisé à importer `@anthropic-ai/sdk`
 * (cf. ADR-004). Tout ce qui en sort est traduit dans le format neutre de
 * `@nexus/llm` ; rien de spécifique au fournisseur ne remonte au cœur agent,
 * hormis `providerBlocks`, qui est opaque et seulement transporté.
 */

export interface AnthropicProviderOptions {
  /** À défaut, le SDK résout `ANTHROPIC_API_KEY` ou un profil `ant auth login`. */
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /**
   * Profondeur de raisonnement. `high` est le défaut de l'API ; `xhigh` convient
   * aux tâches agentiques longues, `low` aux classifications et au routage.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Injectable pour les tests d'intégration ; sinon construit depuis `apiKey`. */
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
      // Streaming systématique : les réponses agentiques peuvent être longues,
      // et un `max_tokens` élevé sans streaming heurte le délai HTTP du SDK.
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
          message: "Le modèle n'a pas produit de sortie structurée exploitable",
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
      // Raisonnement adaptatif : le modèle décide quand et combien réfléchir.
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
      if (message.role === "system") continue; // porté par le champ `system`

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
        // Rejeu à l'identique des blocs du fournisseur (raisonnement, signatures).
        // Les reconstruire depuis le format neutre les perdrait, et l'API
        // refuserait la suite de la conversation.
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
          // `input` est déjà désérialisé par le SDK — pas d'analyse de chaîne ici.
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
   * Traduit les erreurs du SDK en `LLMProviderError`.
   *
   * On distingue le transitoire (429, 5xx, réseau) du définitif (400, 401) :
   * réessayer une requête malformée ne fait que brûler du budget.
   */
  #toProviderError(error: unknown): LLMProviderError {
    if (error instanceof LLMProviderError) return error;

    if (error instanceof Anthropic.APIError) {
      // `status` est typé librement par le SDK : on le ramène explicitement à
      // un nombre plutôt que de laisser un `any` traverser notre taxonomie.
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
        message: "Génération annulée",
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
