import type { z } from "zod";
import { LLMProviderError, type LLMProvider, type ProviderCapabilities } from "../provider.js";
import type { GenerateRequest, GenerateResponse, StreamChunk } from "../types.js";

/**
 * Routeur de fallback minimal.
 * Tente les providers dans l'ordre fourni.
 * Ne décide d'aucune logique métier (permissions, sécurité).
 */
export type FallbackStrategy = "sequential" | "random" | "fastest";

export class FallbackProvider implements LLMProvider {
  readonly id = "fallback-router";

  // On prend le modèle du premier provider pour satisfaire l'interface
  get model(): string {
    return this.providers[0]?.model ?? "unknown";
  }

  // On expose les capacités de l'intersection ou du premier
  get capabilities(): ProviderCapabilities {
    return {
      tools: this.providers.some((p) => p.capabilities.tools ?? false),
      vision: this.providers.some((p) => p.capabilities.vision ?? false),
      structuredOutput: this.providers.some((p) => p.capabilities.structuredOutput ?? false),
      maxContextTokens: Math.max(...this.providers.map((p) => p.capabilities.maxContextTokens ?? 0)),
    };
  }
  private readonly providers: LLMProvider[];

  constructor(providers: LLMProvider[]) {
    this.providers = providers;
    if (providers.length === 0) {
      throw new Error("FallbackProvider requiert au moins un provider.");
    }
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    let lastError: unknown;

    for (const provider of this.providers) {
      try {
        return await provider.generate(request);
      } catch (error) {
        lastError = error;
        // Si l'erreur est non-retryable (ex: abort, ou credentials invalides), on arrête
        if (error instanceof LLMProviderError && !error.retryable) {
          throw error;
        }
        // Sinon, on continue avec le prochain
      }
    }

    throw new LLMProviderError(this.id, {
      message: "Tous les providers de fallback ont échoué.",
      retryable: false,
      cause: lastError,
    });
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    let lastError: unknown;

    for (const provider of this.providers) {
      try {
        const iterable = provider.stream(request);
        // On vérifie le premier yield pour s'assurer que ça ne crash pas
        const iterator = iterable[Symbol.asyncIterator]();
        const first = await iterator.next();

        if (!first.done) {
          yield first.value;
          // On continue de yield le reste
          while (true) {
            const next = await iterator.next();
            if (next.done) break;
            yield next.value;
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
      message: "Tous les providers de fallback ont échoué lors du stream.",
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
      message: "Tous les providers de fallback ont échoué pour la sortie structurée.",
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
