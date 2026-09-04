import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { readinessResponseSchema } from "@nexus/protocol";
import { checkDatabase } from "@nexus/database";
import { checkRedis } from "../../lib/redis.js";

/**
 * Sonde de READINESS — `GET /api/v1/health`.
 *
 * Interroge les dépendances. C'est la sonde qui décide de retirer l'instance de
 * la rotation du load balancer, pas de la tuer.
 *
 * Le statut HTTP suit l'état : 200 si tout répond, 503 si une dépendance est
 * tombée. Un healthcheck qui renvoie 200 avec `status: "degraded"` dans le corps
 * est inutile — aucun load balancer ne lit le corps.
 */
export const v1HealthRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "Readiness — le service peut-il traiter du trafic ?",
        response: { 200: readinessResponseSchema, 503: readinessResponseSchema },
      },
      config: { rateLimit: false },
    },
    async (_request, reply) => {
      // Les deux sondes sont indépendantes : les lancer en parallèle évite
      // d'additionner leurs latences (et leurs timeouts).
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
