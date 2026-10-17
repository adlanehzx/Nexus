import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";
import { AcpOrchestrator } from "../../services/acp-orchestrator.js";
import { NotFoundError } from "../../services/stores.js";

const missionViewSchema = z.object({
  missionId: z.string().uuid(),
  title: z.string(),
  state: z.string(),
  profiles: z.array(z.string()),
  completedTasks: z.number().int().nonnegative(),
  totalTasks: z.number().int().positive(),
  response: z.string().nullable(),
  error: z.string().nullable(),
});

export const orchestratorRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const missionControl = app.services.missionControl;
  const orchestrator =
    missionControl === undefined
      ? undefined
      : new AcpOrchestrator({
          missionControl,
          ...(app.services.llmProvider === undefined ? {} : { llm: app.services.llmProvider }),
        });

  app.post(
    "/orchestrator/messages",
    {
      preHandler: app.requireUser,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["orchestrator"],
        body: z.object({ message: z.string().trim().min(1).max(32_000) }),
        response: { 202: okSchema(missionViewSchema) },
      },
    },
    async (request, reply) => {
      if (orchestrator === undefined) throw new Error("Le moteur ACP n'est pas configuré.");
      const { userId } = currentUser(request);
      const mission = await orchestrator.submit(userId, request.body.message);
      return reply.code(202).send(ok(mission, request.id));
    },
  );

  app.get(
    "/orchestrator/missions/:missionId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["orchestrator"],
        params: z.object({ missionId: z.string().uuid() }),
        response: { 200: okSchema(missionViewSchema) },
      },
    },
    async (request) => {
      if (orchestrator === undefined) throw new Error("Le moteur ACP n'est pas configuré.");
      const { userId } = currentUser(request);
      const mission = await orchestrator.status(userId, request.params.missionId);
      if (mission === undefined) throw new NotFoundError("Mission", request.params.missionId);
      return ok(mission, request.id);
    },
  );

  done();
};
