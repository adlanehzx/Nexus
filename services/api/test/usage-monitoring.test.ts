import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PricingCatalog, UsageTracker } from "@nexus/agent-core";
import { makeApi, createAccount, type ApiHarness, type Account } from "./harness.js";

describe("Usage, Quotas & Equivalent Pricing Architecture (LOT F)", () => {
  describe("Versioned Pricing Catalog", () => {
    it("calculates exact deterministic cost for tiered tokens", () => {
      const pricing = new PricingCatalog();

      // Claude 3.7 Sonnet: 1,000,000 input ($3.0) + 100,000 output ($1.5) + 500,000 cache read ($0.15)
      const cost = pricing.calculateCostUsd("claude-3-7-sonnet-20250219", {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cachedReadTokens: 500_000,
      });

      expect(cost).toBe(4.65);
    });

    it("evaluates local models with zero cost", () => {
      const pricing = new PricingCatalog();

      const cost = pricing.calculateCostUsd("llama3.3:70b", {
        inputTokens: 500_000,
        outputTokens: 500_000,
      });

      expect(cost).toBe(0.0);
    });
  });

  describe("UsageTracker & Multi-Dimensional Aggregation", () => {
    it("aggregates metrics and categorizes confidence tiers without fakes", () => {
      const tracker = new UsageTracker();

      tracker.record({
        organizationId: "org-1",
        provider: "claude",
        accountId: "claude-work",
        modelId: "claude-3-7-sonnet-20250219",
        tokens: { inputTokens: 1000, outputTokens: 500 },
        durationMs: 800,
        confidence: "official",
      });

      tracker.record({
        organizationId: "org-1",
        provider: "claude",
        accountId: "claude-personal",
        modelId: "claude-3-5-sonnet-20241022",
        tokens: { inputTokens: 2000, outputTokens: 1000 },
        durationMs: 1200,
        confidence: "provider_reported",
      });

      tracker.record({
        organizationId: "org-1",
        provider: "codex",
        accountId: "codex-sub",
        modelId: "o3-mini",
        tokens: { inputTokens: 500, outputTokens: 200, reasoningTokens: 300 },
        durationMs: 600,
        confidence: "locally_observed",
      });

      const agg = tracker.getAggregation({ organizationId: "org-1" });

      expect(agg.totalRequests).toBe(3);
      expect(agg.totalTokens).toBe(1000 + 500 + 2000 + 1000 + 500 + 200 + 300);
      expect(agg.byConfidence.official).toBe(1);
      expect(agg.byConfidence.provider_reported).toBe(1);
      expect(agg.byConfidence.locally_observed).toBe(1);
      expect(agg.byProvider.claude.requests).toBe(2);
      expect(agg.byProvider.codex.requests).toBe(1);
      expect(agg.averageLatencyMs).toBe(Math.round((800 + 1200 + 600) / 3));
    });

    it("evaluates quota exhaustion and signals predictive failover", () => {
      const tracker = new UsageTracker();

      const nominal = tracker.evaluateQuotaStatus("acc-1", "claude", 75, 90);
      expect(nominal.status).toBe("nominal");
      expect(nominal.shouldFailover).toBe(false);

      const warning = tracker.evaluateQuotaStatus("acc-2", "claude", 20, 80);
      expect(warning.status).toBe("warning");
      expect(warning.shouldFailover).toBe(false);

      const critical = tracker.evaluateQuotaStatus("acc-3", "codex", 8, 50);
      expect(critical.status).toBe("critical");
      expect(critical.shouldFailover).toBe(true);

      const exhausted = tracker.evaluateQuotaStatus("acc-4", "grok", 0, 40);
      expect(exhausted.status).toBe("exhausted");
      expect(exhausted.shouldFailover).toBe(true);
    });
  });

  describe("REST Usage API Endpoints", () => {
    let harness: ApiHarness;
    let account: Account;

    beforeAll(async () => {
      harness = await makeApi();
      account = await createAccount(harness, "usage-test@nexus.ai");
    });

    afterAll(async () => {
      await harness.close();
    });

    it("GET /api/v1/usage returns aggregated analytics", async () => {
      const res = await harness.app.inject({
        method: "GET",
        url: "/api/v1/usage",
        headers: account.authorization,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("totalTokens");
      expect(body).toHaveProperty("totalCostUsd");
      expect(body).toHaveProperty("byConfidence");
    });

    it("GET /api/v1/usage/quotas returns predictive quota status", async () => {
      const res = await harness.app.inject({
        method: "GET",
        url: "/api/v1/usage/quotas",
        headers: account.authorization,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.quotas).toBeInstanceOf(Array);
      expect(body.quotas.length).toBeGreaterThan(0);
      expect(body.quotas[0]).toHaveProperty("window5hPercentRemaining");
      expect(body.quotas[0]).toHaveProperty("shouldFailover");
    });
  });
});
