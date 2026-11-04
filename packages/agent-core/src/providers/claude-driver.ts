/**
 * NEXUS Unified Provider Architecture - Claude Provider Driver
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { LLMProvider, LlmMessage } from "@nexus/llm";
import { AnthropicProvider } from "@nexus/llm";
import type { ProviderCapabilities } from "@nexus/protocol";
import type {
  ModelDescriptor,
  ProviderDriver,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTurnStreamEvent,
} from "./types.js";
import { CANONICAL_MODELS } from "./catalog.js";

export class ClaudeProviderSession implements ProviderSession {
  readonly id: string;
  readonly providerType = "claude" as const;
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

    const apiKey = config.authSecret ?? process.env.ANTHROPIC_API_KEY;
    if (provider) {
      this.provider = provider;
    } else if (apiKey && apiKey.trim().length > 0) {
      this.provider = new AnthropicProvider({
        apiKey,
        model: this.modelId,
      });
    } else {
      // Offline / dev fallback provider when no API key is configured
      this.provider = {
        id: "claude-dev",
        model: this.modelId,
        capabilities: {
          tools: true,
          vision: true,
          structuredOutput: true,
          maxContextTokens: 200000,
        },
        async generate(_req) {
          await Promise.resolve();
          return {
            content: [{ type: "text", text: `[Claude ${config.model.modelId}] Ready.` }],
            stopReason: "end_turn",
            usage: { inputTokens: 10, outputTokens: 10 },
            model: config.model.modelId,
          };
        },
        async *stream() {
          await Promise.resolve();
          yield { type: "text_delta", delta: `[Claude ${config.model.modelId}] Ready.` };
          yield {
            type: "done",
            response: {
              content: [{ type: "text", text: `[Claude ${config.model.modelId}] Ready.` }],
              stopReason: "end_turn",
              usage: { inputTokens: 10, outputTokens: 10 },
              model: config.model.modelId,
            },
          };
        },
        structuredOutput: async <T>() => {
          await Promise.resolve();
          return {} as unknown as T;
        },
        countTokens: async () => {
          await Promise.resolve();
          return 10;
        },
      };
    }
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
      throw new Error(`Claude session ${this.id} is closed`);
    }

    this.activeAbortController = new AbortController();
    const signal = this.activeAbortController.signal;

    // Append user message to conversation history for session resumption
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

export class ClaudeProviderDriver implements ProviderDriver {
  readonly id = "claude" as const;
  readonly displayName = "Anthropic Claude Agent SDK";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCall: true,
    imageInput: true,
    audioInput: false,
    contextHandoff: true,
    checkpointRollback: true,
    maxTokens: 64000,
    contextWindow: 200000,
  };

  private readonly injectedProvider: LLMProvider | undefined;

  constructor(injectedProvider?: LLMProvider) {
    this.injectedProvider = injectedProvider;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    await Promise.resolve();
    return CANONICAL_MODELS.filter((m) => m.provider === "claude");
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    await Promise.resolve();
    return new ClaudeProviderSession(config, this.injectedProvider);
  }

  async validateCredentials(
    credentials?: Record<string, string>,
  ): Promise<{ valid: boolean; error?: string }> {
    await Promise.resolve();
    const key = credentials?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key || key.trim().length === 0) {
      return { valid: false, error: "ANTHROPIC_API_KEY is not configured" };
    }
    if (!key.startsWith("sk-ant-") && !key.startsWith("mock-")) {
      return { valid: false, error: "Invalid Anthropic API key format (must start with sk-ant-)" };
    }
    return { valid: true };
  }
}
