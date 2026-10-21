import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";

/**
 * Pause globale : lire continue, agir s'arrête.
 *
 * Deux routes seulement, et l'absence d'une troisième est volontaire : il n'y a
 * pas de « pause par appareil » ici. Mettre en pause un sous-ensemble ferait
 * croire à un arrêt alors qu'une autre surface continuerait, et c'est
 * exactement ce qu'un bouton d'arrêt ne doit pas faire.
 *
 * Ces routes **ne consultent pas** la pause. Si elles le faisaient, une pause
 * interdirait sa propre levée.
 */

const pauseViewSchema = z.object({
  paused: z.boolean(),
  reason: z.string().nullable(),
  since: z.string().datetime().nullable(),
});

export const pauseRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/pause",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["system"],
        summary: "NEXUS est-il en pause, depuis quand et pourquoi",
        response: { 200: okSchema(pauseViewSchema) },
      },
    },
    (request) => ok(app.services.pause.state, request.id),
  );

  app.post(
    "/pause",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["system"],
        summary: "Met NEXUS en pause, ou le reprend",
        body: z.object({
          paused: z.boolean(),
          /** Libre, et jamais imposé : « rien ne se passe » est le symptôme le
           * plus coûteux à diagnostiquer, et un motif le transforme en
           * information. */
          reason: z.string().min(1).max(200).optional(),
        }),
        response: { 200: okSchema(pauseViewSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const state = await app.services.pause.set(request.body.paused, request.body.reason);

      app.services.securityLog.record({
        kind: state.paused ? "system.paused" : "system.resumed",
        userId,
        summary: state.paused
          ? `NEXUS mis en pause${state.reason === null ? "" : ` : ${state.reason}`}`
          : "NEXUS repris",
        context: { since: state.since },
      });

      return ok(state, request.id);
    },
  );

  done();
};
