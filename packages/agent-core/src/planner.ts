import {
  toolInputJsonSchema,
  textOf,
  toolCallsOf,
  type GenerateResponse,
  type LLMProvider,
  type LlmMessage,
  type LlmToolSpec,
  type ToolCallBlock,
} from "@nexus/llm";
import type { ToolDefinition } from "@nexus/tools";
import type { AgentContext } from "./context.js";

/**
 * Planner decision output.
 *
 * Derived strictly from structured tool call blocks emitted by LLM provider.
 */
export type AgentDecision =
  | { kind: "final"; text: string; message: LlmMessage }
  | { kind: "tool_calls"; calls: ToolCallBlock[]; text: string; message: LlmMessage };

export interface PlannerOptions {
  llm: LLMProvider;
  systemPrompt?: string;
  maxTokens?: number;
}

/**
 * Agent planner.
 *
 * Bridges the context state to LLM completions, interpreting completions into typed decisions.
 */
export class Planner {
  readonly #llm: LLMProvider;
  readonly #maxTokens: number | undefined;

  constructor(options: PlannerOptions) {
    this.#llm = options.llm;
    this.#maxTokens = options.maxTokens;
  }

  get model(): string {
    return this.#llm.model;
  }

  /** Converts authorized tools into LLM tool specifications. */
  static toolSpecs(tools: readonly ToolDefinition<never, unknown>[]): LlmToolSpec[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputJsonSchema ?? toolInputJsonSchema(tool.inputSchema),
    }));
  }

  async decide(
    context: AgentContext,
    signal: AbortSignal,
  ): Promise<{ decision: AgentDecision; response: GenerateResponse }> {
    const response = await this.#llm.generate({
      messages: [...context.messages],
      system: context.systemPrompt,
      tools: Planner.toolSpecs(context.tools),
      ...(this.#maxTokens !== undefined ? { maxTokens: this.#maxTokens } : {}),
      signal,
    });

    const text = textOf(response.content);
    const calls = toolCallsOf(response.content);

    const message: LlmMessage = {
      role: "assistant",
      content: response.content,
      ...(response.providerBlocks !== undefined ? { providerBlocks: response.providerBlocks } : {}),
    };

    if (calls.length > 0) {
      return { decision: { kind: "tool_calls", calls, text, message }, response };
    }

    return { decision: { kind: "final", text, message }, response };
  }
}
