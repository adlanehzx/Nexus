/**
 * NEXUS Versioned Model Pricing Catalog (LOT F)
 *
 * Provides deterministic API-equivalent cost calculation across all providers,
 * including subscription-backed providers to quantify generated economic value.
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface ModelPricingTier {
  modelId: string;
  provider: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
  reasoningPerMillionUsd?: number;
}

export interface TokenBreakdown {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  reasoningTokens?: number;
}

export const CANONICAL_PRICING_CATALOG_V2026: readonly ModelPricingTier[] = [
  // Anthropic Claude
  {
    modelId: "claude-3-7-sonnet-20250219",
    provider: "claude",
    inputPerMillionUsd: 3.0,
    outputPerMillionUsd: 15.0,
    cacheReadPerMillionUsd: 0.3,
    cacheWritePerMillionUsd: 3.75,
    reasoningPerMillionUsd: 15.0,
  },
  {
    modelId: "claude-3-5-sonnet-20241022",
    provider: "claude",
    inputPerMillionUsd: 3.0,
    outputPerMillionUsd: 15.0,
    cacheReadPerMillionUsd: 0.3,
    cacheWritePerMillionUsd: 3.75,
  },
  {
    modelId: "claude-3-5-haiku-20241022",
    provider: "claude",
    inputPerMillionUsd: 0.8,
    outputPerMillionUsd: 4.0,
    cacheReadPerMillionUsd: 0.08,
    cacheWritePerMillionUsd: 1.0,
  },
  // OpenAI & Codex
  {
    modelId: "o3-mini",
    provider: "openai",
    inputPerMillionUsd: 1.1,
    outputPerMillionUsd: 4.4,
    cacheReadPerMillionUsd: 0.55,
    reasoningPerMillionUsd: 4.4,
  },
  {
    modelId: "gpt-4o",
    provider: "openai",
    inputPerMillionUsd: 2.5,
    outputPerMillionUsd: 10.0,
    cacheReadPerMillionUsd: 1.25,
  },
  {
    modelId: "codex-app-server-default",
    provider: "codex",
    inputPerMillionUsd: 2.5,
    outputPerMillionUsd: 10.0,
  },
  // Google Antigravity (Gemini)
  {
    modelId: "gemini-2.5-pro",
    provider: "antigravity",
    inputPerMillionUsd: 1.25,
    outputPerMillionUsd: 5.0,
    cacheReadPerMillionUsd: 0.31,
  },
  {
    modelId: "gemini-2.5-flash",
    provider: "antigravity",
    inputPerMillionUsd: 0.075,
    outputPerMillionUsd: 0.3,
    cacheReadPerMillionUsd: 0.01875,
  },
  // xAI Grok
  {
    modelId: "grok-2",
    provider: "grok",
    inputPerMillionUsd: 2.0,
    outputPerMillionUsd: 10.0,
  },
  // Local (Ollama, vLLM, llama.cpp)
  {
    modelId: "llama3.3:70b",
    provider: "ollama",
    inputPerMillionUsd: 0.0,
    outputPerMillionUsd: 0.0,
  },
  {
    modelId: "qwen2.5-coder:32b",
    provider: "local",
    inputPerMillionUsd: 0.0,
    outputPerMillionUsd: 0.0,
  },
];

export class PricingCatalog {
  readonly version = "2026.03";
  private readonly tiers = new Map<string, ModelPricingTier>();

  constructor(initialTiers: readonly ModelPricingTier[] = CANONICAL_PRICING_CATALOG_V2026) {
    for (const tier of initialTiers) {
      this.tiers.set(tier.modelId, tier);
    }
  }

  getPricing(modelId: string): ModelPricingTier | undefined {
    return this.tiers.get(modelId);
  }

  calculateCostUsd(modelId: string, tokens: TokenBreakdown): number {
    const tier = this.getPricing(modelId);
    if (!tier) {
      // Default to conservative estimate: $2/M in, $10/M out
      const defaultIn = (tokens.inputTokens / 1_000_000) * 2.0;
      const defaultOut = (tokens.outputTokens / 1_000_000) * 10.0;
      return Number((defaultIn + defaultOut).toFixed(6));
    }

    const inCost = (tokens.inputTokens / 1_000_000) * tier.inputPerMillionUsd;
    const outCost = (tokens.outputTokens / 1_000_000) * tier.outputPerMillionUsd;

    const cacheReadCost =
      tokens.cachedReadTokens && tier.cacheReadPerMillionUsd
        ? (tokens.cachedReadTokens / 1_000_000) * tier.cacheReadPerMillionUsd
        : 0;

    const cacheWriteCost =
      tokens.cachedWriteTokens && tier.cacheWritePerMillionUsd
        ? (tokens.cachedWriteTokens / 1_000_000) * tier.cacheWritePerMillionUsd
        : 0;

    const reasoningCost =
      tokens.reasoningTokens && tier.reasoningPerMillionUsd
        ? (tokens.reasoningTokens / 1_000_000) * tier.reasoningPerMillionUsd
        : 0;

    const total = inCost + outCost + cacheReadCost + cacheWriteCost + reasoningCost;
    return Number(total.toFixed(6));
  }
}
