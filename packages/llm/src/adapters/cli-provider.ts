import { spawn } from "node:child_process";
import type { z } from "zod";
import { LLMProviderError, type LLMProvider, type ProviderCapabilities } from "../provider.js";
import type { GenerateRequest, GenerateResponse, StreamChunk } from "../types.js";
import { toolInputJsonSchema } from "../json-schema.js";

export interface CliProviderOptions {
  /** Primary CLI executable (e.g., 'claude', 'gemini') */
  command: string;
  id: string;
  model: string;
  /** Execution timeout in ms (default: 60s) */
  timeoutMs?: number;
  /** Optional CLI prefix arguments (e.g., ['-y', 'claude-code']) */
  argsPrefix?: string[];
}

/**
 * Provider backed by a local CLI interface (e.g. claude-code, gemini-cli).
 * Enables running models via official local CLI tools.
 */
export class CliProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;
  readonly command: string;
  readonly argsPrefix: string[];
  readonly timeoutMs: number;

  readonly capabilities: ProviderCapabilities = {
    tools: false,
    vision: false,
    structuredOutput: true,
    maxContextTokens: 100_000,
  };

  constructor(options: CliProviderOptions) {
    this.command = options.command;
    this.argsPrefix = options.argsPrefix ?? [];
    this.id = options.id;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const prompt = this.#buildPrompt(request);
    // Pass prompt via parameter (-p).
    const result = await this.#execute([...this.argsPrefix, "-p", prompt], request.signal);
    return {
      content: [{ type: "text", text: result }],
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: this.model,
    };
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
    const systemMsg =
      (request.system ?? "") +
      "\n\nIMPORTANT: You must respond ONLY with a strict JSON object exactly matching this schema:\n" +
      schemaJson +
      "\nDo not include any text or backticks before or after the JSON.";
    const customRequest = {
      ...request,
      system: systemMsg,
    };

    const response = await this.generate(customRequest);
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";

    try {
      const jsonMatch = /\{[\s\S]*\}/.exec(text);
      const jsonString = jsonMatch ? jsonMatch[0] : text;
      const parsed = JSON.parse(jsonString) as unknown;
      return schema.parse(parsed);
    } catch (err: unknown) {
      throw new LLMProviderError(this.id, {
        message: "CLI output did not conform to expected schema",
        cause: err,
        retryable: true,
      });
    }
  }

  countTokens(request: Pick<GenerateRequest, "messages" | "system" | "tools">): Promise<number> {
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

  #execute(args: string[], signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.command, args, { signal });
      let stdout = "";
      let stderr = "";

      let timeoutId: NodeJS.Timeout | undefined;
      if (this.timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          proc.kill("SIGTERM");
          reject(
            new LLMProviderError(this.id, {
              message: "Timeout of " + this.timeoutMs + "ms exceeded",
              retryable: true,
            }),
          );
        }, this.timeoutMs);
      }

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", (err: Error & { code?: string }) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (err.name === "AbortError" || err.code === "ABORT_ERR") {
          reject(
            new LLMProviderError(this.id, {
              message: "Generation cancelled",
              retryable: false,
              cause: err,
            }),
          );
        } else if (err.code === "ENOENT") {
          reject(
            new LLMProviderError(this.id, {
              message: "Provider unavailable: command '" + this.command + "' not found",
              retryable: false,
              cause: err,
            }),
          );
        } else {
          reject(
            new LLMProviderError(this.id, {
              message: "CLI error: " + err.message,
              retryable: true,
              cause: err,
            }),
          );
        }
      });

      proc.on("close", (code) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (code !== 0) {
          reject(
            new LLMProviderError(this.id, {
              message: "CLI execution failed (code " + code + "): " + stderr,
              retryable: true,
            }),
          );
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }
}

export class ClaudeCliProvider extends CliProvider {
  constructor(options?: { timeoutMs?: number }) {
    const isWin = process.platform === "win32";
    super({
      command: isWin ? "npx.cmd" : "npx",
      argsPrefix: ["--yes", "@anthropic-ai/claude-code"],
      id: "claude-cli",
      model: "claude-3-7-sonnet-20250219",
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }
}

export class GeminiCliProvider extends CliProvider {
  constructor(options?: { timeoutMs?: number }) {
    const isWin = process.platform === "win32";
    super({
      command: isWin ? "gemini.cmd" : "gemini",
      id: "gemini-cli",
      model: "gemini-2.5-flash",
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }
}
