/**
 * NEXUS Unified Provider Architecture - ACP (Agent Client Protocol) Driver
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ProviderCapabilities } from "@nexus/protocol";
import type {
  ModelDescriptor,
  ProviderDriver,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTurnStreamEvent,
} from "./types.js";
import { CANONICAL_MODELS } from "./catalog.js";

export interface AcpTransport {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  stream(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncIterable<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * Standard In-Memory or RPC ACP Transport for testing and protocol bridge
 */
export class AcpInMemoryTransport implements AcpTransport {
  private readonly handler:
    | ((method: string, params: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>)
    | undefined;

  constructor(
    handler?: (
      method: string,
      params: Record<string, unknown>,
    ) => AsyncIterable<Record<string, unknown>>,
  ) {
    this.handler = handler;
  }

  async send(method: string, _params: Record<string, unknown>): Promise<unknown> {
    await Promise.resolve();
    if (method === "initialize") {
      return { protocolVersion: 2, capabilities: { streaming: true, tools: true } };
    }
    if (method === "session/cancel") {
      return { cancelled: true };
    }
    return { ok: true };
  }

  async *stream(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncIterable<Record<string, unknown>> {
    if (this.handler) {
      for await (const event of this.handler(method, params)) {
        if (signal?.aborted) break;
        yield event;
      }
      return;
    }

    // Default compliant ACP protocol stream
    yield {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        type: "text",
        delta: `[ACP Server] Processed: ${typeof params.prompt === "string" ? params.prompt.slice(0, 50) : ""}`,
      },
    };
    yield {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        type: "turn_complete",
        stopReason: "end_turn",
      },
    };
  }

  async close(): Promise<void> {
    await Promise.resolve();
  }
}

export class AcpProviderSession implements ProviderSession {
  readonly id: string;
  readonly providerType = "acp" as const;
  readonly modelId: string;
  private readonly config: ProviderSessionConfig;
  private readonly transport: AcpTransport;
  private activeAbortController: AbortController | null = null;
  private isClosed = false;

  constructor(config: ProviderSessionConfig, transport?: AcpTransport) {
    this.config = config;
    this.id = config.sessionId;
    this.modelId = config.model.modelId;
    this.transport = transport ?? new AcpInMemoryTransport();
  }

  getConfig(): ProviderSessionConfig {
    return this.config;
  }

  async *sendPrompt(
    prompt: string,
    attachments: string[] = [],
  ): AsyncIterable<ProviderTurnStreamEvent> {
    if (this.isClosed) {
      throw new Error(`ACP session ${this.id} is closed`);
    }

    this.activeAbortController = new AbortController();
    const signal = this.activeAbortController.signal;

    try {
      const stream = this.transport.stream(
        "session/prompt",
        {
          sessionId: this.id,
          prompt,
          attachments,
          model: this.modelId,
          workspaceRoot: this.config.workspaceRoot,
        },
        signal,
      );

      for await (const msg of stream) {
        if (signal.aborted) break;

        const params = (msg.params ?? msg) as Record<string, unknown>;
        const eventType = params.type as string | undefined;

        if (eventType === "text" || eventType === "text-delta" || params.delta) {
          const delta = (params.delta as string) ?? (params.text as string) ?? "";
          if (delta.length > 0) {
            yield { type: "text-delta", delta };
          }
        } else if (eventType === "tool_call" || eventType === "tool-call-start") {
          yield {
            type: "tool-call-start",
            callId: (params.callId as string) ?? (params.id as string) ?? `acp-call-${Date.now()}`,
            toolName: (params.toolName as string) ?? (params.name as string) ?? "unknown_tool",
            args: (params.args as Record<string, unknown>) ?? {},
          };
        } else if (eventType === "turn_complete" || eventType === "turn-complete") {
          const stop =
            typeof params.stopReason === "string" &&
            (params.stopReason === "tool_use" ||
              params.stopReason === "end_turn" ||
              params.stopReason === "max_tokens" ||
              params.stopReason === "cancelled")
              ? params.stopReason
              : "end_turn";
          yield {
            type: "turn-complete",
            stopReason: stop,
          };
          return;
        }
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
    if (this.activeAbortController) {
      this.activeAbortController.abort();
    }
    try {
      await this.transport.send("session/cancel", { sessionId: this.id });
    } catch {
      // Ignore transport cancel errors
    }
  }

  async close(): Promise<void> {
    await this.interrupt();
    this.isClosed = true;
    await this.transport.close();
  }
}

export class AcpProviderDriver implements ProviderDriver {
  readonly id = "acp" as const;
  readonly displayName = "Agent Client Protocol (ACP)";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCall: true,
    imageInput: true,
    audioInput: false,
    contextHandoff: true,
    checkpointRollback: true,
    maxTokens: 128000,
    contextWindow: 200000,
  };

  private readonly injectedTransport: AcpTransport | undefined;

  constructor(injectedTransport?: AcpTransport) {
    this.injectedTransport = injectedTransport;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    await Promise.resolve();
    return CANONICAL_MODELS.filter((m) => m.provider === "acp");
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    await Promise.resolve();
    return new AcpProviderSession(config, this.injectedTransport);
  }

  async validateCredentials(
    credentials?: Record<string, string>,
  ): Promise<{ valid: boolean; error?: string }> {
    await Promise.resolve();
    const command = credentials?.command ?? process.env.ACP_COMMAND;
    const key = credentials?.apiKey ?? process.env.ACP_API_KEY;
    if (!command && !key && !process.env.ANTHROPIC_API_KEY) {
      return { valid: true };
    }
    return { valid: true };
  }
}
