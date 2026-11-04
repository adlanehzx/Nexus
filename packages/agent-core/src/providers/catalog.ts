/**
 * NEXUS Unified Provider Architecture - Canonical Model Catalog
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * Portions derived from T3 Code (c) 2026 T3 Tools Inc. under MIT License.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ModelDescriptor } from "./types.js";

export const CANONICAL_MODELS: readonly ModelDescriptor[] = [
  // Anthropic Claude
  {
    id: "claude-3-7-sonnet-20250219",
    provider: "claude",
    displayName: "Claude 3.7 Sonnet (Hybrid Reasoning)",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsImages: true,
    isDefault: true,
  },
  {
    id: "claude-3-5-sonnet-20241022",
    provider: "claude",
    displayName: "Claude 3.5 Sonnet",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsImages: true,
  },
  {
    id: "claude-3-5-haiku-20241022",
    provider: "claude",
    displayName: "Claude 3.5 Haiku",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsImages: true,
  },
  // OpenAI & Codex
  {
    id: "o3-mini",
    provider: "openai",
    displayName: "OpenAI o3-mini",
    contextWindow: 200000,
    maxOutputTokens: 100000,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsImages: false,
  },
  {
    id: "gpt-4o",
    provider: "openai",
    displayName: "OpenAI GPT-4o",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsImages: true,
  },
  {
    id: "codex-app-server-default",
    provider: "codex",
    displayName: "Codex Agent Server",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsImages: true,
  },
  // Cursor
  {
    id: "cursor-fast",
    provider: "cursor",
    displayName: "Cursor Fast Agent",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsImages: false,
  },
  // Grok
  {
    id: "grok-2",
    provider: "grok",
    displayName: "xAI Grok-2",
    contextWindow: 131072,
    maxOutputTokens: 8192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsImages: true,
  },
  // OpenCode & ACP
  {
    id: "opencode-local",
    provider: "opencode",
    displayName: "OpenCode Local Runner",
    contextWindow: 65536,
    maxOutputTokens: 8192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsImages: false,
  },
  {
    id: "acp-generic-server",
    provider: "acp",
    displayName: "ACP Generic Agent Protocol",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsImages: true,
  },
  // Google Antigravity
  {
    id: "gemini-2.5-pro",
    provider: "antigravity",
    displayName: "Google Gemini 2.5 Pro (Antigravity)",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsImages: true,
  },
  {
    id: "gemini-2.5-flash",
    provider: "antigravity",
    displayName: "Google Gemini 2.5 Flash",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsImages: true,
  },
  // Pi Inflection
  {
    id: "pi-inflection-2.5",
    provider: "pi",
    displayName: "Inflection Pi 2.5",
    contextWindow: 16000,
    maxOutputTokens: 4096,
    supportsStreaming: true,
    supportsToolCalling: false,
    supportsImages: false,
  },
  // Ollama & Local
  {
    id: "llama3.3:70b",
    provider: "ollama",
    displayName: "Ollama Llama 3.3 70B (Local)",
    contextWindow: 131072,
    maxOutputTokens: 8192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsImages: false,
  },
  {
    id: "qwen2.5-coder:32b",
    provider: "local",
    displayName: "Local Qwen 2.5 Coder 32B (vLLM / llama.cpp)",
    contextWindow: 32768,
    maxOutputTokens: 8192,
    supportsStreaming: true,
    supportsToolCalling: true,
    supportsImages: false,
  },
] as const;

export class ModelCatalog {
  private readonly models = new Map<string, ModelDescriptor>();

  constructor(initialModels: readonly ModelDescriptor[] = CANONICAL_MODELS) {
    for (const m of initialModels) {
      this.models.set(`${m.provider}:${m.id}`, m);
    }
  }

  get(provider: string, modelId: string): ModelDescriptor | undefined {
    return this.models.get(`${provider}:${modelId}`);
  }

  listByProvider(provider: string): ModelDescriptor[] {
    return Array.from(this.models.values()).filter((m) => m.provider === provider);
  }

  listAll(): ModelDescriptor[] {
    return Array.from(this.models.values());
  }

  listModels(provider?: string): ModelDescriptor[] {
    return provider ? this.listByProvider(provider) : this.listAll();
  }

  registerCustomModel(model: ModelDescriptor): void {
    this.models.set(`${model.provider}:${model.id}`, model);
  }

  getDefault(provider?: string): ModelDescriptor | undefined {
    if (provider) {
      const providerModels = this.listByProvider(provider);
      return providerModels.find((m) => m.isDefault) ?? providerModels[0];
    }
    return Array.from(this.models.values()).find((m) => m.isDefault);
  }
}
