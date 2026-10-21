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
 * Scripted LLM provider for tests.
 *
 * The model is the sole truly external boundary of the agent core: it is the
 * only component mocked in tests. Everything else — loop, permissions,
 * confirmations, executor, retries — runs against real implementations.
 *
 * A scripted turn describes what the model "decides": answer, invoke tools, or
 * fail. Recorded requests allow verifying what the core actually sent
 * (exposed tools, transcript, reinjected observations).
 */

export type ScriptedTurn =
  | { kind: "final"; text: string; usage?: Partial<TokenUsage>; fallbackCount?: number }
  | {
      kind: "tool_calls";
      text?: string;
      calls: { id: string; name: string; arguments: unknown }[];
      usage?: Partial<TokenUsage>;
      fallbackCount?: number;
    }
  | { kind: "error"; error: Error }
  /** Never resolves until signal is aborted: tests cancellation and timeouts. */
  | { kind: "hang" };

export interface ScriptedProviderOptions {
  model?: string;
  /** Turn used when the script is exhausted. Defaults to an explicit error. */
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

  /** Number of calls received — iteration count from the model's perspective. */
  get callCount(): number {
    return this.requests.length;
  }

  /** Replaces remaining script turns. Useful for steering scenarios dynamically. */
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
      ...(turn.fallbackCount === undefined ? {} : { fallbackCount: turn.fallbackCount }),
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
    // Intentionally simple heuristic: ~4 chars per token. Tests need a stable,
    // monotonic count rather than an exact tokenizer.
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
        message: `Script exhausted after ${String(this.#index - 1)} turn(s): the agent core called the model more times than expected.`,
        retryable: false,
      }),
    };
  }

  #hang(signal: AbortSignal | undefined): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      if (signal === undefined) return; // intentionally never resolves
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
