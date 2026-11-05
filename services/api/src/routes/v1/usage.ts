/** Usage telemetry is unavailable until a tenant-scoped production source is connected. */
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import { z } from "zod";

export const usageRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  for (const path of ["/usage", "/usage/quotas"]) {
    app.get(
      path,
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
  }
  done();
};
