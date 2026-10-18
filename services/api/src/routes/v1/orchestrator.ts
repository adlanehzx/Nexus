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
      status: z.enum([
        "available",
        "degraded",
        "cooldown",
        "quota_exhausted",
        "auth_required",
        "unknown",
      ]),
      cooldown_until: z.string().nullable(),
      remaining_5h_percent: z.number().int().min(0).max(100).nullable(),
      remaining_week_percent: z.number().int().min(0).max(100).nullable(),
      resets_5h_at: z.string().nullable(),
      resets_week_at: z.string().nullable(),
      usage_source: z.string(),
      consecutive_failures: z.number().int().nonnegative(),
      last_error_category: z.string().nullable(),
    }),
  ),
  available: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      agent_kind: z.string(),
      revision: z.number().int().nullable().optional(),
      registered_as: z.string().nullable().optional(),
      command: z.string(),
      args: z.array(z.string()),
      model: z.string().nullable(),
      permission_policy: z.literal("workspace"),
    }),
  ),
});

const runtimeSettingsViewSchema = z.object({
  task_timeout_seconds: z.number().int().min(10).max(86_400),
  max_attempts: z.number().int().min(1).max(10),
  retry_delay_seconds: z.number().int().min(1).max(3_600),
  context_budget_chars: z.number().int().min(4_000).max(400_000),
  quality_review: z.boolean(),
  research_priority: z.array(z.string().min(1)).min(1).max(20),
  review_priority: z.array(z.string().min(1)).min(1).max(20),
  synthesis_priority: z.array(z.string().min(1)).min(1).max(20),
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

  app.get(
    "/orchestrator/settings",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        response: { 200: okSchema(runtimeSettingsViewSchema) },
      },
    },
    async (request) => {
      if (missionControl === undefined) throw new Error("Le moteur ACP n'est pas configuré.");
      return ok(await missionControl.settings(), request.id);
    },
  );

  app.put(
    "/orchestrator/settings",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        body: runtimeSettingsViewSchema,
        response: { 200: okSchema(runtimeSettingsViewSchema) },
      },
    },
    async (request) => {
      if (missionControl === undefined) throw new Error("Le moteur ACP n'est pas configuré.");
      return ok(await missionControl.updateSettings(request.body), request.id);
    },
  );

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

  app.put(
    "/orchestrator/agents/profiles/:profileId",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        params: z.object({ profileId: z.string().min(1).max(128) }),
        body: z.object({
          name: z.string().trim().min(1).max(64),
          command: z.string().trim().min(1).max(4_096),
          args: z.array(z.string().max(4_096)).max(64),
          model: z.string().max(200).nullable().optional(),
        }),
        response: { 200: okSchema(agentRegistryViewSchema) },
      },
    },
    async (request) => {
      if (missionControl === undefined) throw new Error("Le moteur ACP n'est pas configuré.");
      return ok(
        await missionControl.updateAgentProfile(request.params.profileId, request.body),
        request.id,
      );
    },
  );

  app.delete(
    "/orchestrator/agents/:key",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        params: z.object({ key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) }),
        response: { 200: okSchema(agentRegistryViewSchema) },
      },
    },
    async (request) => {
      if (missionControl === undefined) throw new Error("Le moteur ACP n'est pas configuré.");
      return ok(await missionControl.disableAgent(request.params.key), request.id);
    },
  );

  app.post(
    "/orchestrator/agents/profiles/:profileId/test",
    {
      preHandler: app.requireAdmin,
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
      schema: {
        tags: ["orchestrator"],
        params: z.object({ profileId: z.string().min(1).max(128) }),
        body: z.object({
          workspace: z.string().trim().min(1).max(4_096),
          prompt: z.string().trim().min(1).max(8_000),
          timeout_seconds: z.number().int().min(10).max(600),
        }),
        response: {
          200: okSchema(z.object({ ok: z.literal(true), response: z.string() })),
        },
      },
    },
    async (request) => {
      if (missionControl === undefined) throw new Error("Le moteur ACP n'est pas configuré.");
      return ok(
        await missionControl.testAgentProfile(request.params.profileId, request.body),
        request.id,
      );
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

  app.patch(
    "/orchestrator/agents/:key/health",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        params: z.object({ key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) }),
        body: z.object({
          status: z.enum([
            "available",
            "degraded",
            "cooldown",
            "quota_exhausted",
            "auth_required",
            "unknown",
          ]),
          cooldown_until: z.string().datetime({ offset: true }).nullable().optional(),
          remaining_5h_percent: z.number().int().min(0).max(100).nullable().optional(),
          remaining_week_percent: z.number().int().min(0).max(100).nullable().optional(),
          resets_5h_at: z.string().datetime({ offset: true }).nullable().optional(),
          resets_week_at: z.string().datetime({ offset: true }).nullable().optional(),
          usage_source: z.string().max(64).optional(),
        }),
        response: { 200: okSchema(agentRegistryViewSchema) },
      },
    },
    async (request) => {
      if (missionControl === undefined) throw new Error("Le moteur ACP n'est pas configuré.");
      const registry = await missionControl.updateAgentHealth(request.params.key, request.body);
      return ok(registry, request.id);
    },
  );

  done();
};
