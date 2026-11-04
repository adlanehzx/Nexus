/**
 * NEXUS Unified Usage & Quota Tracker (LOT F)
 *
 * Implements strict confidence level classification, quota exhaustion detection,
 * and multi-dimensional aggregation across providers, accounts, and projects.
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { uuidv7 } from "@nexus/shared";
import { PricingCatalog, type TokenBreakdown } from "./pricing-catalog.js";

export type ConfidenceLevel =
  | "official"
  | "provider_reported"
  | "locally_observed"
  | "estimated"
  | "unavailable";

export interface TokenUsageRecord {
  id?: string;
  organizationId: string;
  workspaceId?: string;
  projectId?: string;
  agentId?: string;
  provider: string;
  accountId: string;
  modelId: string;
  tokens: TokenBreakdown;
  costUsd?: number;
  durationMs: number;
  confidence: ConfidenceLevel;
  timestamp?: string;
}

export interface UsageAggregation {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedReadTokens: number;
  totalCachedWriteTokens: number;
  totalReasoningTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  totalRequests: number;
  averageLatencyMs: number;
  byProvider: Record<string, { requests: number; costUsd: number; totalTokens: number }>;
  byConfidence: Record<ConfidenceLevel, number>;
}

export interface QuotaWindowStatus {
  accountId: string;
  provider: string;
  window5hPercentRemaining: number;
  windowWeekPercentRemaining: number;
  status: "nominal" | "warning" | "critical" | "exhausted";
  shouldFailover: boolean;
}

export class UsageTracker {
  private readonly records: TokenUsageRecord[] = [];
  private readonly pricing: PricingCatalog;

  constructor(pricingCatalog?: PricingCatalog) {
    this.pricing = pricingCatalog ?? new PricingCatalog();
  }

  record(input: TokenUsageRecord): TokenUsageRecord {
    const record: TokenUsageRecord = {
      ...input,
      id: input.id ?? uuidv7(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      costUsd:
        input.costUsd ?? this.pricing.calculateCostUsd(input.modelId, input.tokens),
    };
    this.records.push(record);
    return record;
  }

  getAggregation(filter?: {
    organizationId?: string | undefined;
    provider?: string | undefined;
    accountId?: string | undefined;
  }): UsageAggregation {
    let list = this.records;

    if (filter?.organizationId) {
      list = list.filter((r) => r.organizationId === filter.organizationId);
    }
    if (filter?.provider) {
      list = list.filter((r) => r.provider === filter.provider);
    }
    if (filter?.accountId) {
      list = list.filter((r) => r.accountId === filter.accountId);
    }

    let totalInput = 0;
    let totalOutput = 0;
    let totalCachedRead = 0;
    let totalCachedWrite = 0;
    let totalReasoning = 0;
    let totalCost = 0;
    let totalLatency = 0;

    const byProvider: UsageAggregation["byProvider"] = {};
    const byConfidence: UsageAggregation["byConfidence"] = {
      official: 0,
      provider_reported: 0,
      locally_observed: 0,
      estimated: 0,
      unavailable: 0,
    };

    for (const r of list) {
      totalInput += r.tokens.inputTokens;
      totalOutput += r.tokens.outputTokens;
      totalCachedRead += r.tokens.cachedReadTokens ?? 0;
      totalCachedWrite += r.tokens.cachedWriteTokens ?? 0;
      totalReasoning += r.tokens.reasoningTokens ?? 0;
      totalCost += r.costUsd ?? 0;
      totalLatency += r.durationMs;

      byConfidence[r.confidence]++;

      const prov = (byProvider[r.provider] ??= { requests: 0, costUsd: 0, totalTokens: 0 });
      prov.requests++;
      prov.costUsd += r.costUsd ?? 0;
      prov.totalTokens +=
        r.tokens.inputTokens +
        r.tokens.outputTokens +
        (r.tokens.reasoningTokens ?? 0);
    }

    const totalRequests = list.length;
    const totalTokens = totalInput + totalOutput + totalReasoning;
    const averageLatencyMs = totalRequests > 0 ? Math.round(totalLatency / totalRequests) : 0;

    return {
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCachedReadTokens: totalCachedRead,
      totalCachedWriteTokens: totalCachedWrite,
      totalReasoningTokens: totalReasoning,
      totalTokens,
      totalCostUsd: Number(totalCost.toFixed(6)),
      totalRequests,
      averageLatencyMs,
      byProvider,
      byConfidence,
    };
  }

  evaluateQuotaStatus(
    accountId: string,
    provider: string,
    remaining5hPercent: number,
    remainingWeekPercent: number,
  ): QuotaWindowStatus {
    const minRemaining = Math.min(remaining5hPercent, remainingWeekPercent);

    let status: QuotaWindowStatus["status"] = "nominal";
    if (minRemaining <= 0) {
      status = "exhausted";
    } else if (minRemaining <= 10) {
      status = "critical";
    } else if (minRemaining <= 25) {
      status = "warning";
    }

    return {
      accountId,
      provider,
      window5hPercentRemaining: remaining5hPercent,
      windowWeekPercentRemaining: remainingWeekPercent,
      status,
      shouldFailover: minRemaining <= 10,
    };
  }
}
