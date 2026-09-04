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
 * Décision du planificateur.
 *
 * Elle est dérivée des **blocs structurés** renvoyés par le fournisseur —
 * jamais d'une analyse du texte. Un agent qui devine des appels d'outils avec
 * des expressions régulières est un agent qui finira par exécuter une action
 * hallucinée : la seule source d'un appel d'outil est un bloc `tool_call`.
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
 * Planificateur.
 *
 * Il traduit l'état du contexte en un appel au modèle, et la réponse du modèle
 * en une décision typée. C'est le seul endroit du cœur agent qui parle au LLM,
 * et il ne connaît que le port `LLMProvider` : aucun SDK n'entre ici.
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

  /** Traduit les outils autorisés en descriptions destinées au modèle. */
  static toolSpecs(tools: readonly ToolDefinition<never, unknown>[]): LlmToolSpec[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      // Un outil découvert dynamiquement porte le schéma JSON du serveur ;
      // pour un outil natif, on le dérive du schéma Zod.
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

    // On se fie aux blocs, pas au `stopReason` : un fournisseur peut renvoyer
    // `end_turn` tout en ayant émis des appels d'outils. La présence d'un bloc
    // `tool_call` est le seul critère qui compte.
    if (calls.length > 0) {
      return { decision: { kind: "tool_calls", calls, text, message }, response };
    }

    return { decision: { kind: "final", text, message }, response };
  }
}
