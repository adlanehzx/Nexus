/**
 * NEXUS Unified Provider Architecture - Provider Types & Contracts
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ProviderType, ProviderCapabilities, ModelSelection } from "@nexus/protocol";

export interface ModelDescriptor {
  id: string;
  provider: ProviderType;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsToolCalling: boolean;
  supportsImages: boolean;
  isDefault?: boolean;
}

export interface ProviderSessionConfig {
  sessionId: string;
  threadId: string;
  model:
    | ModelSelection
    | (Omit<ModelSelection, "reasoningEffort" | "temperature"> & {
        reasoningEffort?: ModelSelection["reasoningEffort"];
        temperature?: number;
      });
  workspaceRoot: string;
  environment?: Record<string, string>;
  authSecret?: string;
  systemPrompt?: string;
}

export type ProviderTurnStreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call-start"; callId: string; toolName: string; args?: Record<string, unknown> }
  | { type: "tool-call-delta"; callId: string; argsDelta: string }
  | {
      type: "tool-call-complete";
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      result?: unknown;
    }
  | { type: "checkpoint"; checkpointId: string; turnNumber: number }
  | { type: "error"; message: string; code?: string; recoverable: boolean }
  | { type: "turn-complete"; stopReason: "tool_use" | "end_turn" | "max_tokens" | "cancelled" };

export interface ProviderSession {
  readonly id: string;
  readonly providerType: ProviderType;
  readonly modelId: string;
  sendPrompt(prompt: string, attachments?: string[]): AsyncIterable<ProviderTurnStreamEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface ProviderDriver {
  readonly id: ProviderType;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  listModels(): Promise<ModelDescriptor[]>;
  createSession(config: ProviderSessionConfig): Promise<ProviderSession>;
  validateCredentials(
    credentials?: Record<string, string>,
  ): Promise<{ valid: boolean; error?: string }>;
}
