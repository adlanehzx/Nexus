import type { z } from "zod";
import { LLMProviderError, type LLMProvider, type ProviderCapabilities } from "../provider.js";
import type { GenerateRequest, GenerateResponse, StreamChunk } from "../types.js";
import { toolInputJsonSchema } from "../json-schema.js";

export interface LocalLLMProviderOptions {
  baseURL?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * Abstraction minimale pour un provider local (ex: Ollama, LMStudio) via API HTTP locale.
 * Permet de se connecter ultérieurement à un runtime local.
 */
export class LocalLLMProvider implements LLMProvider {
  readonly id = "local-llm";
  readonly model: string;
  readonly baseURL: string;
  readonly timeoutMs: number;

  readonly capabilities: ProviderCapabilities = {
    tools: false,
    vision: false,
    structuredOutput: true,
    maxContextTokens: 32_000,
  };

  constructor(options: LocalLLMProviderOptions = {}) {
    this.model = options.model ?? "local-model";
    this.baseURL = options.baseURL ?? "http://127.0.0.1:11434"; // Defaut style Ollama
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const prompt = this.#buildPrompt(request);

    // Polyfill minimal timeout si request.signal n'est pas fourni
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = request.signal ?? controller.signal;

    try {
      // Abstraction basée sur un standard `/api/generate`
      const res = await fetch(this.baseURL + "/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: prompt,
          stream: false,
        }),
        signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        throw new LLMProviderError(this.id, {
          message: "Le provider local a répondu avec " + res.status,
          retryable: res.status >= 500 || res.status === 429,
        });
      }

      const data = (await res.json()) as { response?: string };
      return {
        content: [{ type: "text", text: data.response ?? "" }],
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: this.model,
      };
    } catch (error: unknown) {
      clearTimeout(timeout);
      const e = error as Error & { name?: string };
      if (e.name === "AbortError" || e.name === "TimeoutError") {
        throw new LLMProviderError(this.id, {
          message: "Requête locale annulée ou timeout",
          retryable: false,
          cause: e,
        });
      }
      throw new LLMProviderError(this.id, {
        message: "Erreur de connexion au provider local: " + e.message,
        retryable: true,
        cause: e,
      });
    }
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const response = await this.generate(request);
    yield {
      type: "text_delta",
      delta: response.content[0]?.type === "text" ? response.content[0].text : "",
    };
    yield { type: "done", response };
  }

  async structuredOutput<T>(request: GenerateRequest, schema: z.ZodType<T>): Promise<T> {
    const schemaJson = JSON.stringify(toolInputJsonSchema(schema), null, 2);
    const customRequest = {
      ...request,
      system:
        (request.system ?? "") +
        "\n\nIMPORTANT: Tu dois ABSOLUMENT répondre avec un JSON strict correspondant à:\n" +
        schemaJson,
    };

    const response = await this.generate(customRequest);
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";

    try {
      const jsonMatch = /\{[\s\S]*\}/.exec(text);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text) as unknown;
      return schema.parse(parsed);
    } catch (err: unknown) {
      throw new LLMProviderError(this.id, {
        message: "Sortie JSON invalide du LLM local",
        cause: err,
        retryable: true,
      });
    }
  }

  countTokens(
    request: Pick<GenerateRequest, "messages" | "system" | "tools">,
  ): Promise<number> {
    return Promise.resolve(Math.ceil(JSON.stringify(request).length / 4));
  }

  #buildPrompt(request: GenerateRequest): string {
    let prompt = request.system ? "System: " + request.system + "\n\n" : "";
    for (const msg of request.messages) {
      const text = msg.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text?: string }).text ?? "")
        .join("");
      prompt += msg.role + ": " + text + "\n";
    }
    return prompt.trim();
  }
}
