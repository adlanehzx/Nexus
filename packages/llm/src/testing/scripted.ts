import type { z } from "zod";
import { LLMProviderError, type LLMProvider, type ProviderCapabilities } from "../provider.js";
import type {
  ContentBlock,
  GenerateRequest,
  GenerateResponse,
  StreamChunk,
  TokenUsage,
} from "../types.js";

/**
 * Fournisseur LLM scripté.
 *
 * Le modèle est la seule frontière véritablement externe du cœur agent : c'est
 * lui, et lui seul, qu'on remplace pour tester. Tout le reste — boucle,
 * permissions, confirmations, exécuteur, reprises — s'exécute réellement.
 *
 * Un tour scripté décrit ce que le modèle « décide » : répondre, appeler des
 * outils, ou échouer. Les requêtes reçues sont enregistrées, ce qui permet
 * d'affirmer *ce que le cœur a réellement envoyé* (outils exposés, transcript,
 * observations réinjectées).
 */

export type ScriptedTurn =
  | { kind: "final"; text: string; usage?: Partial<TokenUsage> }
  | {
      kind: "tool_calls";
      text?: string;
      calls: { id: string; name: string; arguments: unknown }[];
      usage?: Partial<TokenUsage>;
    }
  | { kind: "error"; error: Error }
  /** Ne résout jamais tant que le signal n'est pas abandonné : teste annulation et délais. */
  | { kind: "hang" };

export interface ScriptedProviderOptions {
  model?: string;
  /** Tour utilisé quand le script est épuisé. Par défaut : une erreur explicite. */
  fallback?: ScriptedTurn;
}

export class ScriptedLLMProvider implements LLMProvider {
  readonly id = "scripted";
  readonly model: string;
  readonly capabilities: ProviderCapabilities = {
    tools: true,
    vision: false,
    structuredOutput: true,
    maxContextTokens: 200_000,
  };

  readonly requests: GenerateRequest[] = [];
  #turns: ScriptedTurn[];
  #index = 0;
  readonly #fallback: ScriptedTurn | undefined;

  constructor(turns: ScriptedTurn[], options: ScriptedProviderOptions = {}) {
    this.#turns = [...turns];
    this.model = options.model ?? "scripted-model";
    this.#fallback = options.fallback;
  }

  /** Nombre d'appels reçus — le compte d'itérations du point de vue du modèle. */
  get callCount(): number {
    return this.requests.length;
  }

  /** Remplace le script restant. Utile pour piloter un scénario en deux temps. */
  setTurns(turns: ScriptedTurn[]): void {
    this.#turns = [...turns];
    this.#index = 0;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    this.requests.push(request);
    const turn = this.#nextTurn();

    if (turn.kind === "error") throw turn.error;
    if (turn.kind === "hang") return this.#hang(request.signal);

    const content: ContentBlock[] = [];
    if (turn.kind === "final") {
      content.push({ type: "text", text: turn.text });
    } else {
      if (turn.text !== undefined) content.push({ type: "text", text: turn.text });
      for (const call of turn.calls) {
        content.push({
          type: "tool_call",
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
    }

    return Promise.resolve({
      content,
      stopReason: turn.kind === "final" ? "end_turn" : "tool_call",
      usage: {
        inputTokens: turn.usage?.inputTokens ?? 100,
        outputTokens: turn.usage?.outputTokens ?? 20,
      },
      model: this.model,
    });
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const response = await this.generate(request);
    for (const block of response.content) {
      if (block.type === "text") yield { type: "text_delta", delta: block.text };
      if (block.type === "tool_call") yield { type: "tool_call", call: block };
    }
    yield { type: "done", response };
  }

  async structuredOutput<T>(request: GenerateRequest, schema: z.ZodType<T>): Promise<T> {
    const response = await this.generate(request);
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    return schema.parse(JSON.parse(text));
  }

  countTokens(request: Pick<GenerateRequest, "messages" | "system" | "tools">): Promise<number> {
    // Approximation volontairement grossière : ~4 caractères par jeton. Les
    // tests ont besoin d'un nombre stable et monotone, pas d'un tokenizer.
    const size = JSON.stringify(request).length;
    return Promise.resolve(Math.ceil(size / 4));
  }

  #nextTurn(): ScriptedTurn {
    const turn = this.#turns[this.#index];
    this.#index += 1;
    if (turn !== undefined) return turn;
    if (this.#fallback !== undefined) return this.#fallback;
    return {
      kind: "error",
      error: new LLMProviderError("scripted", {
        message: `Script épuisé après ${String(this.#index - 1)} tour(s) : le cœur agent a appelé le modèle plus souvent que prévu.`,
        retryable: false,
      }),
    };
  }

  #hang(signal: AbortSignal | undefined): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      if (signal === undefined) return; // ne résout jamais — volontaire
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }
}
