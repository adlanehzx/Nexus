/** Observed usage from existing run records; provider billing is a separate source. */
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { PricingCatalog, type RunUsageBucket } from "@nexus/agent-core";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";
import { syncUserMissionsToRunStore } from "../../services/acp-orchestrator.js";

const pricing = new PricingCatalog();

/** API-equivalent list price. Never a billed amount; calculates deterministic cost from pricing catalog. */
function estimateApiCostUsd(bucket: RunUsageBucket): number {
  const tier = pricing.getPricing(bucket.model);
  const cost = pricing.calculateCostUsd(tier ? tier.modelId : bucket.model, {
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    ...(bucket.cacheReadTokens === null ? {} : { cachedReadTokens: bucket.cacheReadTokens }),
    ...(bucket.cacheWriteTokens === null ? {} : { cachedWriteTokens: bucket.cacheWriteTokens }),
  });
  return Number(cost.toFixed(4));
}

export const usageRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.get(
    "/usage",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["usage"],
        querystring: z
          .object({
            days: z.coerce.number().int().min(1).max(366).default(30),
            offset: z.coerce.number().int().min(0).max(100000).default(0),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          })
          .strict(),
        response: {
          200: okSchema(
            z.object({
              source: z.literal("agent_run_records"),
              days: z.number(),
              nextOffset: z.number().nullable(),
              runs: z.array(
                z.object({
                  runId: z.string(),
                  model: z.string(),
                  startedAt: z.string(),
                  status: z.string(),
                  inputTokens: z.number(),
                  outputTokens: z.number(),
                  cacheReadTokens: z.number().nullable(),
                  cacheWriteTokens: z.number().nullable(),
                }),
              ),
              billedCostUsd: z.null(),
              providerQuota: z.null(),
            }),
          ),
        },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      if (app.services.missionControl && app.services.runStore) {
        await syncUserMissionsToRunStore(userId, app.services.missionControl, app.services.runStore);
      }
      const cutoff = Date.now() - request.query.days * 86_400_000;
      const page = await app.services.runStore.listForUser(
        userId,
        new Date(cutoff),
        request.query.offset,
        request.query.limit + 1,
      );
      const runs = page
        .slice(0, request.query.limit)
        .map(({ record }) => ({
          runId: record.runId,
          model: record.model,
          startedAt: record.startTime,
          status: record.status,
          inputTokens: record.usage.inputTokens,
          outputTokens: record.usage.outputTokens,
          cacheReadTokens: record.usage.cacheReadTokens ?? null,
          cacheWriteTokens: record.usage.cacheWriteTokens ?? null,
        }))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return reply.send(
        ok(
          {
            source: "agent_run_records" as const,
            days: request.query.days,
            nextOffset:
              page.length > request.query.limit ? request.query.offset + request.query.limit : null,
            runs,
            billedCostUsd: null,
            providerQuota: null,
          },
          request.id,
        ),
      );
    },
  );
  app.get(
    "/usage/summary",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["usage"],
        summary: "Observed token counters per day and model for the signed-in account",
        querystring: z
          .object({ days: z.coerce.number().int().min(1).max(366).default(30) })
          .strict(),
        response: {
          200: okSchema(
            z.object({
              source: z.literal("agent_run_records"),
              days: z.number(),
              buckets: z.array(
                z.object({
                  day: z.string(),
                  model: z.string(),
                  runs: z.number(),
                  failedRuns: z.number(),
                  inputTokens: z.number(),
                  outputTokens: z.number(),
                  cacheReadTokens: z.number().nullable(),
                  cacheWriteTokens: z.number().nullable(),
                  estimatedApiCostUsd: z.number().nullable(),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      if (app.services.missionControl && app.services.runStore) {
        await syncUserMissionsToRunStore(userId, app.services.missionControl, app.services.runStore);
      }
      const since = new Date(Date.now() - request.query.days * 86_400_000);
      const buckets = await app.services.runStore.summarizeForUser(userId, since);
      return ok(
        {
          source: "agent_run_records" as const,
          days: request.query.days,
          buckets: buckets.map((bucket) => ({
            ...bucket,
            estimatedApiCostUsd: estimateApiCostUsd(bucket),
          })),
        },
        request.id,
      );
    },
  );
  app.get(
    "/usage/quotas",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["usage"],
        summary: "Quota windows reported for each provider account of this installation",
        response: {
          200: okSchema(
            z.object({
              accounts: z.array(
                z.object({
                  id: z.string(),
                  provider: z.string(),
                  name: z.string(),
                  authStatus: z.string(),
                  lastCheckedAt: z.string().nullable(),
                  remaining5hPercent: z.number().nullable(),
                  remainingWeekPercent: z.number().nullable(),
                  resets5hAt: z.string().nullable(),
                  resetsWeekAt: z.string().nullable(),
                  exhausted: z.boolean(),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => {
      const accounts = (await app.services.providerAccounts?.listAccounts()) ?? [];
      return ok(
        {
          accounts: accounts.map((account) => ({
            id: account.id,
            provider: account.provider,
            name: account.name,
            authStatus: account.authStatus,
            lastCheckedAt: account.lastCheckedAt,
            ...account.quotas,
          })),
        },
        request.id,
      );
    },
  );
  done();
};
