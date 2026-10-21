import type { z } from "zod";
import { LLMProviderError, type LLMProvider, type ProviderCapabilities } from "../provider.js";
import type { GenerateRequest, GenerateResponse, StreamChunk } from "../types.js";

/**
 * Minimal fallback router.
 * Attempts providers in sequential order.
 * Implements no domain business logic (permissions, security).
 */
export type FallbackStrategy = "sequential" | "random" | "fastest";

export class FallbackProvider implements LLMProvider {
  readonly id = "fallback-router";

  // Use first provider's model to satisfy interface
  get model(): string {
    return this.providers[0]?.model ?? "unknown";
  }

  // Expose union of provider capabilities
  get capabilities(): ProviderCapabilities {
    return {
      tools: this.providers.some((p) => p.capabilities.tools ?? false),
      vision: this.providers.some((p) => p.capabilities.vision ?? false),
      structuredOutput: this.providers.some((p) => p.capabilities.structuredOutput ?? false),
      maxContextTokens: Math.max(
        ...this.providers.map((p) => p.capabilities.maxContextTokens ?? 0),
      ),
    };
  }
  private readonly providers: LLMProvider[];

  constructor(providers: LLMProvider[]) {
    this.providers = providers;
    if (providers.length === 0) {
      throw new Error("FallbackProvider requires at least one provider.");
    }
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    let lastError: unknown;

    for (const [index, provider] of this.providers.entries()) {
      try {
        const response = await provider.generate(request);
        return {
          ...response,
          fallbackCount: (response.fallbackCount ?? 0) + index,
        };
      } catch (error) {
        lastError = error;
        // Non-retryable error (abort, bad auth, etc.) stops immediately
        if (error instanceof LLMProviderError && !error.retryable) {
          throw error;
        }
        // Otherwise continue to next fallback
      }
    }

    throw new LLMProviderError(this.id, {
      message: "All fallback providers failed.",
      retryable: false,
      cause: lastError,
    });
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    let lastError: unknown;

    for (const [index, provider] of this.providers.entries()) {
      try {
        const iterable = provider.stream(request);
        const iterator = iterable[Symbol.asyncIterator]();
        const first = await iterator.next();

        if (!first.done) {
          yield withFallbackCount(first.value, index);
          while (true) {
            const next = await iterator.next();
            if (next.done) break;
            yield withFallbackCount(next.value, index);
          }
        }
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof LLMProviderError && !error.retryable) {
          throw error;
        }
      }
    }

    throw new LLMProviderError(this.id, {
      message: "All fallback providers failed during streaming.",
      retryable: false,
      cause: lastError,
    });
  }

  async structuredOutput<T>(request: GenerateRequest, schema: z.ZodType<T>): Promise<T> {
    let lastError: unknown;

    for (const provider of this.providers) {
      try {
        return await provider.structuredOutput(request, schema);
      } catch (error) {
        lastError = error;
        if (error instanceof LLMProviderError && !error.retryable) {
          throw error;
        }
      }
    }

    throw new LLMProviderError(this.id, {
      message: "All fallback providers failed for structured output.",
      retryable: false,
      cause: lastError,
    });
  }

  async countTokens(
    request: Pick<GenerateRequest, "messages" | "system" | "tools">,
  ): Promise<number> {
    return this.providers[0]!.countTokens(request);
  }
}

function withFallbackCount(chunk: StreamChunk, count: number): StreamChunk {
  if (chunk.type !== "done") return chunk;
  return {
    ...chunk,
    response: {
      ...chunk.response,
      fallbackCount: (chunk.response.fallbackCount ?? 0) + count,
    },
  };
}
