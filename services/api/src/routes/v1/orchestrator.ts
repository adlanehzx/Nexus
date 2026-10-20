import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";
import { AcpOrchestrator } from "../../services/acp-orchestrator.js";
import { NotFoundError } from "../../services/stores.js";
import {
  createProviderAccountSchema,
  providerAccountSchema,
  updateProviderAccountSchema,
} from "../../services/provider-accounts.js";

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
      system_prompt: z.string(),
      reasoning_effort: z
        .enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
        .nullable(),
      additional_dirs: z.array(z.string()),
      config_options: z.record(z.string(), z.string()),
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
  const providerAccounts = app.services.providerAccounts;
  const agentRouter = app.services.agentRouter;
  const orchestrator =
    missionControl === undefined
      ? undefined
      : new AcpOrchestrator({
          missionControl,
          context: app.services.context,
          // Le service d'assertions signe **et** enregistre : l'orchestrateur ne
          // reçoit que la capacité de délivrer une portée de mission.
          grants: app.services.missionGrants,
          agentRouter,
          sharedArtifacts: app.services.sharedArtifacts,
          agentCollaboration: app.services.agentCollaboration,
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
        body: z.object({
          message: z.string().trim().min(1).max(32_000),
          timezone: z.string().trim().min(1).max(100).default("UTC"),
        }),
        response: { 202: okSchema(missionViewSchema) },
      },
    },
    async (request, reply) => {
      if (orchestrator === undefined) throw new Error("Le moteur ACP n'est pas configuré.");
      const { userId } = currentUser(request);
      const mission = await orchestrator.submit(
        userId,
        request.body.message,
        request.body.timezone,
      );
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
          system_prompt: z.string().max(32_000).optional(),
          reasoning_effort: z
            .enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
            .nullable()
            .optional(),
          additional_dirs: z.array(z.string().max(4_096)).max(32).optional(),
          config_options: z.record(z.string(), z.string()).optional(),
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

  app.get(
    "/orchestrator/accounts",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        response: { 200: okSchema(z.object({ accounts: z.array(providerAccountSchema) })) },
      },
    },
    async (request) => {
      if (providerAccounts === undefined) {
        throw new Error("Le gestionnaire multi-comptes n'est pas configuré.");
      }
      return ok({ accounts: await providerAccounts.listAccounts() }, request.id);
    },
  );

  app.post(
    "/orchestrator/accounts",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        body: createProviderAccountSchema,
        response: { 201: okSchema(providerAccountSchema) },
      },
    },
    async (request, reply) => {
      if (providerAccounts === undefined) {
        throw new Error("Le gestionnaire multi-comptes n'est pas configuré.");
      }
      const created = await providerAccounts.createAccount(request.body);
      return reply.code(201).send(ok(created, request.id));
    },
  );

  app.get(
    "/orchestrator/accounts/:id",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        params: z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) }),
        response: { 200: okSchema(providerAccountSchema) },
      },
    },
    async (request) => {
      if (providerAccounts === undefined) {
        throw new Error("Le gestionnaire multi-comptes n'est pas configuré.");
      }
      const account = await providerAccounts.getAccount(request.params.id);
      if (account === undefined) throw new NotFoundError("ProviderAccount", request.params.id);
      return ok(account, request.id);
    },
  );

  app.patch(
    "/orchestrator/accounts/:id",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        params: z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) }),
        body: updateProviderAccountSchema,
        response: { 200: okSchema(providerAccountSchema) },
      },
    },
    async (request) => {
      if (providerAccounts === undefined) {
        throw new Error("Le gestionnaire multi-comptes n'est pas configuré.");
      }
      const updated = await providerAccounts.updateAccount(request.params.id, request.body);
      if (updated === undefined) throw new NotFoundError("ProviderAccount", request.params.id);
      return ok(updated, request.id);
    },
  );

  app.delete(
    "/orchestrator/accounts/:id",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        params: z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) }),
        response: { 200: okSchema(z.object({ deleted: z.boolean() })) },
      },
    },
    async (request) => {
      if (providerAccounts === undefined) {
        throw new Error("Le gestionnaire multi-comptes n'est pas configuré.");
      }
      const deleted = await providerAccounts.deleteAccount(request.params.id);
      if (!deleted) throw new NotFoundError("ProviderAccount", request.params.id);
      return ok({ deleted: true }, request.id);
    },
  );

  app.post(
    "/orchestrator/accounts/:id/test",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        params: z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) }),
        response: { 200: okSchema(providerAccountSchema) },
      },
    },
    async (request) => {
      if (providerAccounts === undefined) {
        throw new Error("Le gestionnaire multi-comptes n'est pas configuré.");
      }
      const tested = await providerAccounts.probeAuth(request.params.id);
      if (tested === undefined) throw new NotFoundError("ProviderAccount", request.params.id);
      return ok(tested, request.id);
    },
  );

  app.post(
    "/orchestrator/accounts/:id/cooldown",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        params: z.object({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) }),
        body: z.object({
          active: z.boolean(),
          durationSeconds: z.number().int().min(1).max(86_400).optional(),
          reason: z.string().max(256).optional(),
        }),
        response: { 200: okSchema(providerAccountSchema) },
      },
    },
    async (request) => {
      if (providerAccounts === undefined) {
        throw new Error("Le gestionnaire multi-comptes n'est pas configuré.");
      }
      const updated = request.body.active
        ? await providerAccounts.setCooldown(
            request.params.id,
            request.body.durationSeconds ?? 300,
            request.body.reason ?? "Cooldown manuel",
          )
        : await providerAccounts.clearCooldown(request.params.id);
      if (updated === undefined) throw new NotFoundError("ProviderAccount", request.params.id);
      return ok(updated, request.id);
    },
  );

  app.get(
    "/orchestrator/routing/matrix",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        response: {
          200: okSchema(
            z.object({
              matrix: z.array(
                z.object({
                  key: z.string(),
                  categoryScores: z.record(z.string(), z.number()),
                  totalRuns: z.number(),
                  overallSuccessRate: z.number(),
                  avgDurationMs: z.number(),
                  healthStatus: z.string(),
                  authStatus: z.string(),
                  cooldownActive: z.boolean(),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => {
      const health = missionControl ? await missionControl.health() : { profiles: [] };
      const defaultProfiles = providerAccounts
        ? (await providerAccounts.listAccounts()).map((a) => a.id)
        : ["antigravity", "claude", "codex"];
      const profiles = health.profiles.length > 0 ? health.profiles : defaultProfiles;
      const matrix = await agentRouter.getRoutingMatrix(profiles);
      return ok({ matrix }, request.id);
    },
  );

  app.post(
    "/orchestrator/routing/evaluate",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        body: z.object({
          instruction: z.string().min(1).max(10_000),
          contextChars: z.number().int().nonnegative().optional(),
        }),
        response: {
          200: okSchema(
            z.object({
              classification: z.object({
                primaryCategory: z.string(),
                categoryWeights: z.record(z.string(), z.number()),
                requiresBrowser: z.boolean(),
                estimatedComplexity: z.string(),
                contextChars: z.number(),
              }),
              ranked: z.array(
                z.object({
                  key: z.string(),
                  totalScore: z.number(),
                  isAvailable: z.boolean(),
                  unavailabilityReason: z.string().optional(),
                  recommendedCategory: z.string(),
                  breakdown: z.object({
                    compatibility: z.number(),
                    authentication: z.number(),
                    quota: z.number(),
                    health: z.number(),
                    quality: z.number(),
                    performance: z.number(),
                    context: z.number(),
                  }),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => {
      const health = missionControl ? await missionControl.health() : { profiles: [] };
      const defaultProfiles = providerAccounts
        ? (await providerAccounts.listAccounts()).map((a) => a.id)
        : ["antigravity", "claude", "codex"];
      const profiles = health.profiles.length > 0 ? health.profiles : defaultProfiles;
      const classification = agentRouter.classifyTask(
        request.body.instruction,
        request.body.contextChars,
      );
      const ranked = await agentRouter.rankProfiles(
        profiles,
        request.body.instruction,
        request.body.contextChars !== undefined
          ? { contextChars: request.body.contextChars }
          : undefined,
      );
      return ok({ classification, ranked }, request.id);
    },
  );

  app.post(
    "/orchestrator/routing/reset",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["orchestrator"],
        response: { 200: okSchema(z.object({ reset: z.boolean() })) },
      },
    },
    async (request) => {
      await agentRouter.resetStats();
      return ok({ reset: true }, request.id);
    },
  );

  const artifactRecordSchema = z.object({
    id: z.string().uuid(),
    missionKey: z.string(),
    taskKey: z.string(),
    name: z.string(),
    relativePath: z.string(),
    uri: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number(),
    sha256: z.string(),
    description: z.string(),
    createdAt: z.string(),
  });

  app.get(
    "/orchestrator/missions/:missionId/artifacts",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["orchestrator"],
        params: z.object({ missionId: z.string().uuid() }),
        response: { 200: okSchema(z.object({ artifacts: z.array(artifactRecordSchema) })) },
      },
    },
    async (request) => {
      if (orchestrator === undefined) throw new Error("Le moteur ACP n'est pas configuré.");
      const artifacts = await orchestrator.getArtifacts(request.params.missionId);
      return ok({ artifacts }, request.id);
    },
  );

  app.get(
    "/orchestrator/missions/:missionId/artifacts/download",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["orchestrator"],
        params: z.object({ missionId: z.string().uuid() }),
        querystring: z.object({ uri: z.string().min(1).max(512) }),
      },
    },
    async (request, reply) => {
      if (orchestrator === undefined) throw new Error("Le moteur ACP n'est pas configuré.");
      const { record, content } = await orchestrator.readArtifact(
        request.params.missionId,
        request.query.uri,
      );
      return reply
        .header("Content-Type", record.mimeType)
        .header("Content-Disposition", `inline; filename="${record.name}"`)
        .header("ETag", `"${record.sha256}"`)
        .send(content);
    },
  );

  app.post(
    "/orchestrator/missions/:missionId/artifacts",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["orchestrator"],
        params: z.object({ missionId: z.string().uuid() }),
        body: z.object({
          taskKey: z.string().min(1).max(64),
          name: z.string().min(1).max(128),
          content: z.string().max(25 * 1024 * 1024),
          description: z.string().max(500).optional(),
          mimeType: z.string().max(64).optional(),
        }),
        response: { 201: okSchema(z.object({ artifact: artifactRecordSchema })) },
      },
    },
    async (request, reply) => {
      if (orchestrator === undefined) throw new Error("Le moteur ACP n'est pas configuré.");
      const artifact = await orchestrator.saveArtifact(request.params.missionId, {
        taskKey: request.body.taskKey,
        name: request.body.name,
        content: request.body.content,
        description: request.body.description,
        mimeType: request.body.mimeType,
      });
      return reply.code(201).send(ok({ artifact }, request.id));
    },
  );

  app.get(
    "/orchestrator/missions/:missionId/collaboration",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["orchestrator"],
        params: z.object({ missionId: z.string().uuid() }),
        response: {
          200: okSchema(
            z.object({
              missionId: z.string(),
              workspace: z.string(),
              tasks: z.array(
                z.object({
                  taskKey: z.string(),
                  profileKey: z.string(),
                  state: z.string(),
                  structuredOutput: z.object({
                    summary: z.string(),
                    payloadType: z.string(),
                    confidenceScore: z.number(),
                    assumptions: z.array(z.string()),
                    openQuestions: z.array(z.string()),
                    proposedSubtasks: z.array(
                      z.object({
                        key: z.string(),
                        title: z.string(),
                        instruction: z.string(),
                        reason: z.string(),
                        priority: z.string(),
                        profile: z.string().optional(),
                        depends_on: z.array(z.string()).optional(),
                      }),
                    ),
                    artifacts: z.array(z.any()),
                  }),
                  artifacts: z.array(artifactRecordSchema),
                }),
              ),
              artifacts: z.array(artifactRecordSchema),
              debates: z.array(
                z.object({
                  id: z.string(),
                  taskA: z.object({
                    key: z.string(),
                    profile: z.string(),
                    summary: z.string(),
                    confidence: z.number(),
                  }),
                  taskB: z.object({
                    key: z.string(),
                    profile: z.string(),
                    summary: z.string(),
                    confidence: z.number(),
                  }),
                  issue: z.string(),
                  severity: z.string(),
                  recommendation: z.string(),
                }),
              ),
              proposedSubtasks: z.array(
                z.object({
                  key: z.string(),
                  title: z.string(),
                  instruction: z.string(),
                  reason: z.string(),
                  priority: z.string(),
                  profile: z.string().optional(),
                  depends_on: z.array(z.string()).optional(),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => {
      if (orchestrator === undefined) throw new Error("Le moteur ACP n'est pas configuré.");
      const view = await orchestrator.getCollaborationView(request.params.missionId);
      return ok(view, request.id);
    },
  );

  done();
};
