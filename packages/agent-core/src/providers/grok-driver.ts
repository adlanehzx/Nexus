/**
 * NEXUS Unified Provider Architecture - Grok (xAI) Provider Driver
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { LLMProvider, LlmMessage } from "@nexus/llm";
import { OpenAICompatibleProvider } from "@nexus/llm";
import type { ProviderCapabilities } from "@nexus/protocol";
import type {
  ModelDescriptor,
  ProviderDriver,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTurnStreamEvent,
} from "./types.js";
import { CANONICAL_MODELS } from "./catalog.js";

export class GrokProviderSession implements ProviderSession {
  readonly id: string;
  readonly providerType = "grok" as const;
  readonly modelId: string;
  private readonly config: ProviderSessionConfig;
  private readonly provider: LLMProvider;
  private readonly messages: LlmMessage[] = [];
  private activeAbortController: AbortController | null = null;
  private isClosed = false;

  constructor(config: ProviderSessionConfig, provider?: LLMProvider) {
    this.config = config;
    this.id = config.sessionId;
    this.modelId = config.model.modelId;
    this.provider =
      provider ??
      new OpenAICompatibleProvider({
        id: "grok",
        model: this.modelId,
        baseURL:
          config.environment?.XAI_BASE_URL ?? process.env.XAI_BASE_URL ?? "https://api.x.ai/v1",
        apiKey: config.authSecret ?? process.env.XAI_API_KEY ?? "xai-key",
      });
  }

  getConfig(): ProviderSessionConfig {
    return this.config;
  }

  getMessages(): readonly LlmMessage[] {
    return this.messages;
  }

  async *sendPrompt(
    prompt: string,
    _attachments: string[] = [],
  ): AsyncIterable<ProviderTurnStreamEvent> {
    if (this.isClosed) {
      throw new Error(`Grok session ${this.id} is closed`);
    }

    this.activeAbortController = new AbortController();
    const signal = this.activeAbortController.signal;

    this.messages.push({
      role: "user",
      content: [{ type: "text", text: prompt }],
    });

    try {
      const stream = this.provider.stream({
        messages: this.messages,
        ...(this.config.systemPrompt ? { system: this.config.systemPrompt } : {}),
        signal,
      });

      let accumulatedText = "";
      for await (const chunk of stream) {
        if (signal.aborted) break;

        if (chunk.type === "text_delta") {
          accumulatedText += chunk.delta;
          yield { type: "text-delta", delta: chunk.delta };
        } else if (chunk.type === "tool_call") {
          yield {
            type: "tool-call-start",
            callId: chunk.call.id ?? `tool-${Date.now()}`,
            toolName: chunk.call.name,
            args: (chunk.call.arguments as Record<string, unknown>) ?? {},
          };
        } else if (chunk.type === "done") {
          if (accumulatedText.length > 0) {
            this.messages.push({
              role: "assistant",
              content: [{ type: "text", text: accumulatedText }],
            });
          }
          yield {
            type: "turn-complete",
            stopReason: "end_turn",
          };
          return;
        }
      }

      if (accumulatedText.length > 0) {
        this.messages.push({
          role: "assistant",
          content: [{ type: "text", text: accumulatedText }],
        });
      }

      yield {
        type: "turn-complete",
        stopReason: signal.aborted ? "cancelled" : "end_turn",
      };
    } catch (err) {
      if (signal.aborted) {
        yield { type: "turn-complete", stopReason: "cancelled" };
        return;
      }
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        recoverable: true,
      };
    } finally {
      this.activeAbortController = null;
    }
  }

  async interrupt(): Promise<void> {
    await Promise.resolve();
    if (this.activeAbortController) {
      this.activeAbortController.abort();
    }
  }

  async close(): Promise<void> {
    await this.interrupt();
    this.isClosed = true;
  }
}

export class GrokProviderDriver implements ProviderDriver {
  readonly id = "grok" as const;
  readonly displayName = "xAI Grok Provider";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCall: true,
    imageInput: true,
    audioInput: false,
    contextHandoff: true,
    checkpointRollback: true,
    maxTokens: 32000,
    contextWindow: 128000,
  };

  private readonly injectedProvider: LLMProvider | undefined;

  constructor(injectedProvider?: LLMProvider) {
    this.injectedProvider = injectedProvider;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    await Promise.resolve();
    return CANONICAL_MODELS.filter((m) => m.provider === "grok");
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    await Promise.resolve();
    return new GrokProviderSession(config, this.injectedProvider);
  }

  async validateCredentials(
    credentials?: Record<string, string>,
  ): Promise<{ valid: boolean; error?: string }> {
    await Promise.resolve();
    const key = credentials?.apiKey ?? process.env.XAI_API_KEY;
    if (!key || key.trim().length === 0) {
      return { valid: false, error: "XAI_API_KEY is not configured" };
    }
    return { valid: true };
  }
}
