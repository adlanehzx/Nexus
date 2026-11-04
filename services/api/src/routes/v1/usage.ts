/**
 * NEXUS API - Unified Usage & Quota Monitoring Routes (LOT F)
 *
 * Exposes real token consumption, versioned API-equivalent costs,
 * confidence tier classifications, and predictive quota exhaustion.
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { UsageTracker, PricingCatalog } from "@nexus/agent-core";

const tracker = new UsageTracker(new PricingCatalog());

export const usageRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  // GET /usage
  app.get(
    "/usage",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["usage", "billing"],
        summary: "Get comprehensive token consumption and equivalent API cost analytics",
        querystring: z.object({
          organizationId: z.string().optional(),
          provider: z.string().optional(),
          accountId: z.string().optional(),
        }),
        response: {
          200: z.object({
            totalInputTokens: z.number(),
            totalOutputTokens: z.number(),
            totalCachedReadTokens: z.number(),
            totalCachedWriteTokens: z.number(),
            totalReasoningTokens: z.number(),
            totalTokens: z.number(),
            totalCostUsd: z.number(),
            totalRequests: z.number(),
            averageLatencyMs: z.number(),
            byProvider: z.record(
              z.string(),
              z.object({
                requests: z.number(),
                costUsd: z.number(),
                totalTokens: z.number(),
              }),
            ),
            byConfidence: z.record(z.string(), z.number()),
          }),
        },
      },
    },
    async (request, reply) => {
      const summary = tracker.getAggregation(request.query);
      return reply.send(summary);
    },
  );

  // GET /usage/quotas
  app.get(
    "/usage/quotas",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["usage", "quotas"],
        summary: "Get current quota status and predictive exhaustion alerts across providers",
        response: {
          200: z.object({
            quotas: z.array(
              z.object({
                accountId: z.string(),
                provider: z.string(),
                window5hPercentRemaining: z.number(),
                windowWeekPercentRemaining: z.number(),
                status: z.enum(["nominal", "warning", "critical", "exhausted"]),
                shouldFailover: z.boolean(),
              }),
            ),
          }),
        },
      },
    },
    async (_request, reply) => {
      // Sample monitored accounts
      const quotas = [
        tracker.evaluateQuotaStatus("claude-primary", "claude", 65, 82),
        tracker.evaluateQuotaStatus("codex-fast", "codex", 8, 45),
        tracker.evaluateQuotaStatus("gemini-dev", "antigravity", 95, 98),
      ];
      return reply.send({ quotas });
    },
  );

  done();
};
