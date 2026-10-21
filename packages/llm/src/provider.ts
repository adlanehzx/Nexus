import type { z } from "zod";
import { AppError, type AppErrorOptions } from "@nexus/shared";
import type { GenerateRequest, GenerateResponse, StreamChunk } from "./types.js";

export interface ProviderCapabilities {
  tools: boolean;
  vision: boolean;
  structuredOutput: boolean;
  maxContextTokens: number;
}

/**
 * Port `LLMProvider` — cf. ADR-004.
 *
 * Quatre méthodes, pas une de plus. Le reste de l'application ne dépend jamais
 * d'un SDK : changer de modèle ou de fournisseur doit rester une ligne de
 * configuration, pas une réécriture.
 */
export interface LLMProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  generate(request: GenerateRequest): Promise<GenerateResponse>;
  stream(request: GenerateRequest): AsyncIterable<StreamChunk>;
  structuredOutput<T>(request: GenerateRequest, schema: z.ZodType<T>): Promise<T>;
  countTokens(request: Pick<GenerateRequest, "messages" | "system" | "tools">): Promise<number>;
}

/**
 * Échec côté fournisseur.
 *
 * `retryable` distingue ce qui vaut la peine d'être retenté (429, 5xx, réseau)
 * de ce qui échouera identiquement (400, clé invalide). La boucle agent s'appuie
 * dessus pour décider d'abandonner proprement plutôt que de brûler du budget.
 */
export class LLMProviderError extends AppError {
  readonly code = "LLM_PROVIDER_ERROR";
  readonly httpStatus = 502;
  override readonly retryable: boolean;
  readonly provider: string;
  readonly status: number | undefined;

  constructor(
    provider: string,
    options: AppErrorOptions & { retryable?: boolean; status?: number },
  ) {
    super({
      userMessage: "The generation service is temporarily unavailable.",
      ...options,
    });
    this.provider = provider;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}
