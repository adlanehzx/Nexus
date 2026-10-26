import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { linkedInRuntimeConfigSchema } from "../../services/runtime-configuration.js";
import { ok, okSchema } from "../../lib/response.js";

const statusSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  tools: z.array(z.string()),
});

export const linkedInRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = () => {
    if (app.services.linkedin === undefined)
      throw new Error("LinkedIn integration is unavailable.");
    return app.services.linkedin;
  };

  app.get(
    "/linkedin/status",
    {
      preHandler: app.requireAdmin,
      schema: { tags: ["linkedin"], response: { 200: okSchema(statusSchema) } },
    },
    async (request) => ok(await service().status(), request.id),
  );

  app.post(
    "/linkedin/oauth/start",
    {
      preHandler: app.requireAdmin,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["linkedin"],
        body: linkedInRuntimeConfigSchema,
        response: { 200: okSchema(z.object({ authorizationUrl: z.string().url() })) },
      },
    },
    async (request) => ok(await service().start(request.body), request.id),
  );

  app.get(
    "/linkedin/oauth/callback",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["linkedin"],
        querystring: z.object({
          code: z.string().min(1).max(4096),
          state: z.string().min(32).max(256),
        }),
      },
    },
    async (request, reply) => {
      const destination = await service().complete(request.query);
      return reply.redirect(destination);
    },
  );

  app.post(
    "/linkedin/disconnect",
    {
      preHandler: app.requireAdmin,
      schema: { tags: ["linkedin"], response: { 200: okSchema(statusSchema) } },
    },
    async (request) => {
      await service().disconnect();
      return ok(await service().status(), request.id);
    },
  );

  done();
};
