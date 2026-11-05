/** Observed usage from existing run records; provider billing is a separate source. */
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";

export const usageRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.get(
    "/usage",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["usage"],
        querystring: z
          .object({ days: z.coerce.number().int().min(1).max(366).default(30) })
          .strict(),
        response: {
          200: okSchema(
            z.object({
              source: z.literal("agent_run_records"),
              days: z.number(),
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
      const cutoff = Date.now() - request.query.days * 86_400_000;
      const runs = (await app.services.runStore.listAll())
        .filter(({ record }) => record.userId === userId && Date.parse(record.startTime) >= cutoff)
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
    "/usage/quotas",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["usage"],
        response: { 503: z.object({ code: z.string(), message: z.string() }) },
      },
    },
    async (_request, reply) =>
      reply.code(503).send({
        code: "USAGE_TELEMETRY_UNAVAILABLE",
        message: "Production usage and quota telemetry is not connected.",
      }),
  );
  done();
};
