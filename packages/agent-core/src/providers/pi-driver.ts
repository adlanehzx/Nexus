/**
 * NEXUS Unified Provider Architecture - Pi Provider Driver
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { LLMProvider, LlmMessage } from "@nexus/llm";
import type {
  ProviderDriver,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTurnStreamEvent,
  ModelDescriptor,
} from "./types.js";
import { CANONICAL_MODELS } from "./catalog.js";

export class PiProviderSession implements ProviderSession {
  readonly id: string;
  readonly providerType = "pi" as const;
  readonly modelId: string;
  private readonly config: ProviderSessionConfig;
  private readonly llm: LLMProvider;
  private readonly messages: LlmMessage[] = [];
  private activeAbortController: AbortController | null = null;
  private isClosed = false;

  constructor(config: ProviderSessionConfig, llm: LLMProvider) {
    this.config = config;
    this.id = config.sessionId;
    this.modelId = config.model.modelId;
    this.llm = llm;
  }

  async *sendPrompt(
    prompt: string,
    _attachments: string[] = [],
  ): AsyncIterable<ProviderTurnStreamEvent> {
    if (this.isClosed) {
      throw new Error(`Pi session ${this.id} is closed`);
    }

    this.activeAbortController = new AbortController();
    const signal = this.activeAbortController.signal;
    this.messages.push({ role: "user", content: prompt });

    try {
      const stream = this.llm.stream({
        messages: this.messages,
        model: this.modelId,
        signal,
      });

      let assistantText = "";
      for await (const chunk of stream) {
        if (signal.aborted) break;

        if (chunk.type === "text_delta" && chunk.delta) {
          assistantText += chunk.delta;
          yield { type: "text-delta", delta: chunk.delta };
        } else if (chunk.type === "tool_call" && chunk.call) {
          yield {
            type: "tool-call-start",
            callId: chunk.call.id,
            toolName: chunk.call.name,
            args: chunk.call.arguments as Record<string, unknown>,
          };
          yield {
            type: "tool-call-complete",
            callId: chunk.call.id,
            toolName: chunk.call.name,
            args: chunk.call.arguments as Record<string, unknown>,
          };
        }
      }

      if (assistantText.length > 0) {
        this.messages.push({ role: "assistant", content: assistantText });
      }

      yield { type: "turn-complete", stopReason: "end_turn" };
    } catch (err: unknown) {
      if (signal.aborted) {
        yield { type: "turn-complete", stopReason: "cancelled" };
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", message, recoverable: false };
    } finally {
      this.activeAbortController = null;
    }
  }

  async interrupt(): Promise<void> {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }

  async close(): Promise<void> {
    await this.interrupt();
    this.isClosed = true;
  }
}

export class PiProviderDriver implements ProviderDriver {
  readonly id = "pi" as const;
  readonly displayName = "Pi Inflection";
  readonly capabilities = {
    streaming: true,
    toolCall: false,
    imageInput: false,
    audioInput: false,
    contextHandoff: false,
    checkpointRollback: false,
    maxTokens: 4096,
    contextWindow: 16000,
  };

  private readonly injectedLlm: LLMProvider | undefined;

  constructor(injectedLlm?: LLMProvider) {
    this.injectedLlm = injectedLlm;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    await Promise.resolve();
    return CANONICAL_MODELS.filter((m) => m.provider === "pi");
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    await Promise.resolve();
    if (!this.injectedLlm) {
      throw new Error(
        `Cannot create Pi session '${config.sessionId}': no LLM provider injected or PI_API_KEY configured`,
      );
    }
    return new PiProviderSession(config, this.injectedLlm);
  }

  async validateCredentials(
    credentials?: Record<string, string>,
  ): Promise<{ valid: boolean; error?: string }> {
    await Promise.resolve();
    const key = credentials?.apiKey ?? process.env.PI_API_KEY;
    if (!key || key.trim().length === 0) {
      return { valid: false, error: "PI_API_KEY is not configured" };
    }
    if (key.trim().length < 8) {
      return { valid: false, error: "PI_API_KEY is too short" };
    }
    return { valid: true };
  }
}
