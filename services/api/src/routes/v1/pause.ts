import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";

/**
 * Global pause: reading continues, actions halt.
 *
 * Only two routes, and the absence of a third is deliberate: there is no
 * "per-device pause" here. Pausing a subset would give the illusion of a halt
 * while another surface continues running, which is exactly what a kill switch must avoid.
 *
 * These routes **do not consult** pause state. If they did, a pause would prohibit
 * its own resumption.
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
        summary: "Whether NEXUS is paused, since when and why",
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
        summary: "Pauses NEXUS, or resumes it",
        body: z.object({
          paused: z.boolean(),
          /** Free-form and never enforced: 'nothing happens' is the costliest symptom
           * to diagnose, and a reason turns it into information. */
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
          ? `NEXUS paused${state.reason === null ? "" : ` : ${state.reason}`}`
          : "NEXUS resumed",
        context: { since: state.since },
      });

      return ok(state, request.id);
    },
  );

  done();
};
