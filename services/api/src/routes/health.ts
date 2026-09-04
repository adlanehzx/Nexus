import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { livenessResponseSchema } from "@nexus/protocol";

/**
 * Sonde de LIVENESS — `GET /health`.
 *
 * Ne touche aucune dépendance, délibérément. C'est la sonde sur laquelle
 * l'orchestrateur décide de TUER le conteneur : si elle interrogeait PostgreSQL,
 * une base momentanément lente ferait redémarrer un processus parfaitement sain,
 * ce qui aggrave la panne au lieu de la corriger.
 */
export const healthRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "Liveness — le processus répond-il ?",
        response: { 200: livenessResponseSchema },
      },
      // La sonde est appelée en boucle par l'orchestrateur : la compter dans le
      // quota de l'appelant n'aurait aucun sens.
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
