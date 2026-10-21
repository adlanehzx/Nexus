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
 * `LLMProvider` port — cf. ADR-004.
 *
 * Four methods, nothing more. The rest of the application never depends on a
 * vendor SDK: switching models or providers remains a configuration change,
 * never a rewrite.
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
 * Provider-side failure.
 *
 * `retryable` distinguishes transient errors (429, 5xx, network) from
 * permanent failures (400, invalid auth). The agent loop relies on this to
 * fail cleanly rather than burning through budget.
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
