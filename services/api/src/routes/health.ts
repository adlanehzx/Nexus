import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { livenessResponseSchema } from "@nexus/protocol";

/**
 * LIVENESS probe — `GET /health`.
 *
 * Deliberately does not touch any dependencies. This is the probe that decides
 * whether the orchestrator KILLS the container: if it queried PostgreSQL,
 * a momentarily slow database would restart a perfectly healthy process,
 * worsening an outage rather than recovering from it.
 */
export const healthRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "Liveness — is the process responding?",
        response: { 200: livenessResponseSchema },
      },
      // The probe is polled continuously by the orchestrator: counting it
      // against caller quotas would make no sense.
      config: { rateLimit: false },
    },
    () => ({
      status: "ok" as const,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    }),
  );

  done();
};
