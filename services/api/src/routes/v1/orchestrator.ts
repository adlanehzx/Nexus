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

const agentRegistryViewSchema = z.object({
  worker_enabled: z.boolean(),
  configured: z.array(
    z.object({
      key: z.string(),
      agent_profile_id: z.string(),
      running_tasks: z.number().int().nonnegative(),
      queued_tasks: z.number().int().nonnegative(),
      last_task_state: z.string().nullable(),
    }),
  ),
  available: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      agent_kind: z.string(),
      revision: z.number().int().nullable().optional(),
      registered_as: z.string().nullable().optional(),
    }),
  ),
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

  app.get(
    "/orchestrator/agents",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        response: { 200: okSchema(agentRegistryViewSchema) },
      },
    },
    async (request) => {
      if (missionControl === undefined) throw new Error("Le moteur ACP n'est pas configuré.");
      return ok(await missionControl.agents(), request.id);
    },
  );

  app.post(
    "/orchestrator/agents",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        body: z.object({
          key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          agent_profile_id: z.string().min(1).max(128),
        }),
        response: { 201: okSchema(agentRegistryViewSchema) },
      },
    },
    async (request, reply) => {
      if (missionControl === undefined) throw new Error("Le moteur ACP n'est pas configuré.");
      const registry = await missionControl.registerAgent(request.body);
      return reply.code(201).send(ok(registry, request.id));
    },
  );

  app.post(
    "/orchestrator/agents/create",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        body: z.object({
          key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
          template_profile_id: z.string().min(1).max(128),
          model: z.string().max(200).nullable().optional(),
        }),
        response: { 201: okSchema(agentRegistryViewSchema) },
      },
    },
    async (request, reply) => {
      if (missionControl === undefined) throw new Error("Le moteur ACP n'est pas configuré.");
      const registry = await missionControl.createAgent(request.body);
      return reply.code(201).send(ok(registry, request.id));
    },
  );

  done();
};
