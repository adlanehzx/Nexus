import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { readinessResponseSchema } from "@nexus/protocol";
import { checkDatabase } from "@nexus/database";
import { checkRedis } from "../../lib/redis.js";

/**
 * READINESS probe — `GET /api/v1/health`.
 *
 * Queries dependencies. This is the probe that decides whether to remove the instance
 * from load balancer rotation, not kill it.
 *
 * HTTP status follows health: 200 if everything responds, 503 if a dependency is
 * down. A healthcheck returning 200 with `status: "degraded"` in the body
 * is useless — no load balancer inspects response bodies.
 */
export const v1HealthRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "Readiness — can the service handle traffic?",
        response: { 200: readinessResponseSchema, 503: readinessResponseSchema },
      },
      config: { rateLimit: false },
    },
    async (_request, reply) => {
      // The two probes are independent: running them in parallel avoids
      // compounding their latencies (and timeouts).
      const [database, redis] = await Promise.all([
        checkDatabase(app.prisma),
        checkRedis(app.redis),
      ]);

      const healthy = database.status === "up" && redis.status === "up";

      return reply.status(healthy ? 200 : 503).send({
        status: healthy ? ("ok" as const) : ("degraded" as const),
        version: app.config.API_VERSION,
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
        dependencies: { database, redis },
      });
    },
  );

  done();
};
