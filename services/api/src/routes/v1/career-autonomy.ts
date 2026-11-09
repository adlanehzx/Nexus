import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  careerAutonomySettingsPatchSchema,
  confirmationView,
  applicationView,
  eventView,
} from "@nexus/career";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";

const idParamsSchema = z.object({ id: z.string().uuid() });
const emptyBodySchema = z
  .union([z.record(z.string(), z.unknown()), z.undefined(), z.null()])
  .optional();

/**
 * Lab 1 — configurable autonomy of the career pipeline.
 *
 * Settings are per user. The run, the queue and the one-click actions only
 * ever call the ordinary career paths, so every lifecycle, approval-hash and
 * idempotency check still applies (a replayed submission is a 409).
 */
export const careerAutonomyRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/career/autonomy/settings",
    {
      preHandler: [app.requireUser],
      schema: { tags: ["career"], response: { 200: okSchema(z.any()) } },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok(await app.services.careerAutonomy.settingsView(userId), request.id);
    },
  );

  app.put(
    "/career/autonomy/settings",
    {
      preHandler: [app.requireUser],
      schema: {
        tags: ["career"],
        body: careerAutonomySettingsPatchSchema,
        response: { 200: okSchema(z.any()) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok(await app.services.careerAutonomy.updateSettings(userId, request.body), request.id);
    },
  );

  app.post(
    "/career/autonomy/run",
    {
      preHandler: [app.requireUser],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { tags: ["career"], body: emptyBodySchema, response: { 200: okSchema(z.any()) } },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok(await app.services.careerAutonomy.run(userId), request.id);
    },
  );

  app.get(
    "/career/autonomy/queue",
    {
      preHandler: [app.requireUser],
      schema: { tags: ["career"], response: { 200: okSchema(z.any()) } },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok(await app.services.careerAutonomy.queue(userId), request.id);
    },
  );

  app.post(
    "/career/autonomy/applications/:id/validate-documents",
    {
      preHandler: [app.requireUser],
      schema: {
        tags: ["career"],
        params: idParamsSchema,
        body: emptyBodySchema,
        response: { 200: okSchema(z.any()) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const result = await app.services.careerAutonomy.validateDocuments(userId, request.params.id);
      return ok(
        {
          confirmation: confirmationView(result.confirmation),
          application: applicationView(result.application),
        },
        request.id,
      );
    },
  );

  app.post(
    "/career/autonomy/confirmations/:id/approve-and-submit",
    {
      preHandler: [app.requireUser],
      schema: {
        tags: ["career"],
        params: idParamsSchema,
        body: emptyBodySchema,
        response: { 200: okSchema(z.any()) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok(
        await app.services.careerAutonomy.approveAndSubmit(userId, request.params.id),
        request.id,
      );
    },
  );

  app.get(
    "/career/autonomy/audit",
    {
      preHandler: [app.requireUser],
      schema: {
        tags: ["career"],
        querystring: z.object({
          actor: z.string().min(1).max(32).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        response: { 200: okSchema(z.any()) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const events = await app.services.careerAutonomy.audit(userId, {
        ...(request.query.actor === undefined ? {} : { actor: request.query.actor }),
        limit: request.query.limit,
      });
      return ok({ events: events.map(eventView) }, request.id);
    },
  );

  done();
};
