import { createHash } from "node:crypto";
import {
  LLMProviderError,
  NativeFreeLlmProvider,
  type GenerateRequest,
  type GenerateResponse,
  type LLMProvider,
  type ProviderCapabilities,
  type StreamChunk,
} from "@nexus/llm";
import type { z } from "zod";
import type {
  FreeLlmRuntimeConfig,
  RuntimeConfigurationStore,
  SecretVault,
} from "./runtime-configuration.js";

export interface FreeLlmRuntimeStatus {
  enabled: boolean;
  model: string;
  strategy: FreeLlmRuntimeConfig["strategy"];
  allowKeyless: boolean;
  nvidiaConfigured: boolean;
  activeProviders: string[];
}

/** Hot-reloadable FreeLLM provider backed by NEXUS runtime config and vault. */
export class FreeLlmRuntimeProvider implements LLMProvider {
  readonly id = "freelm-runtime";
  readonly model = "auto";
  readonly capabilities: ProviderCapabilities = {
    tools: true,
    vision: false,
    structuredOutput: true,
    maxContextTokens: 128_000,
  };

  readonly #runtime: RuntimeConfigurationStore;
  readonly #vault: SecretVault;
  #cached: { fingerprint: string; provider: NativeFreeLlmProvider } | undefined;

  constructor(options: { runtime: RuntimeConfigurationStore; vault: SecretVault }) {
    this.#runtime = options.runtime;
    this.#vault = options.vault;
  }

  async status(): Promise<FreeLlmRuntimeStatus> {
    const config = await this.#runtime.loadFreeLlm();
    const key =
      config.nvidiaKeyRef === null ? undefined : await this.#vault.get(config.nvidiaKeyRef);
    return {
      enabled: config.enabled,
      model: config.model,
      strategy: config.strategy,
      allowKeyless: config.allowKeyless,
      nvidiaConfigured: key !== undefined,
      activeProviders: [
        ...(key === undefined ? [] : ["nvidia-nim"]),
        ...(config.allowKeyless ? ["kilo-free", "ovh-anonymous"] : []),
      ],
    };
  }

  async test(): Promise<{ provider: string; model: string; text: string }> {
    const provider = await this.#resolve();
    const response = await provider.generate({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Reply with exactly: NEXUS FreeLLM ready" }],
        },
      ],
      maxTokens: 32,
    });
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    return { provider: provider.id, model: response.model, text };
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    return (await this.#resolve()).generate(request);
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    yield* (await this.#resolve()).stream(request);
  }

  async structuredOutput<T>(request: GenerateRequest, schema: z.ZodType<T>): Promise<T> {
    return (await this.#resolve()).structuredOutput(request, schema);
  }

  async countTokens(
    request: Pick<GenerateRequest, "messages" | "system" | "tools">,
  ): Promise<number> {
    try {
      return await (await this.#resolve()).countTokens(request);
    } catch {
      return Math.ceil(JSON.stringify(request).length / 4);
    }
  }

  async #resolve(): Promise<NativeFreeLlmProvider> {
    const config = await this.#runtime.loadFreeLlm();
    if (!config.enabled) throw unavailable("FreeLLM is disabled.");
    const nvidiaKey =
      config.nvidiaKeyRef === null ? undefined : await this.#vault.get(config.nvidiaKeyRef);
    if (nvidiaKey === undefined && !config.allowKeyless) {
      throw unavailable("FreeLLM has no enabled provider.");
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(config))
      .update("\0")
      .update(nvidiaKey ?? "")
      .digest("hex");
    if (this.#cached?.fingerprint === fingerprint) return this.#cached.provider;
    const provider = new NativeFreeLlmProvider({
      ...(nvidiaKey === undefined ? {} : { nvidiaApiKey: nvidiaKey }),
      allowKeyless: config.allowKeyless,
      model: config.model,
      strategy: config.strategy,
    });
    this.#cached = { fingerprint, provider };
    return provider;
  }
}

function unavailable(message: string): LLMProviderError {
  return new LLMProviderError("freelm-runtime", { message, retryable: true });
}
