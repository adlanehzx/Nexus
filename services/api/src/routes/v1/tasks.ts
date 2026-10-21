import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { AuthorizationError } from "@nexus/shared";
import { riskLevelSchema } from "@nexus/tools";
import { createTaskPlan, type TaskStepInput } from "@nexus/devices";
import { assertOwnedBy, currentUser } from "../../plugins/authentication.js";
import { ok, okSchema, listSchema, paginationQuerySchema } from "../../lib/response.js";
import { NotFoundError, paginate } from "../../services/stores.js";
import { TaskPlanner } from "../../services/task-planner.js";

/**
 * Plans de tâches, exécutions, confirmations.
 *
 * Le point le plus sensible de l'API : c'est ici qu'une demande devient une
 * action sur une machine réelle. Trois barrières s'y succèdent, dans cet ordre,
 * et **aucune n'est facultative** :
 *
 *  1. l'utilisateur possède l'appareil d'origine qu'il déclare ;
 *  2. les permissions effectives couvrent toutes les capacités demandées ;
 *  3. le coordinateur revérifie à chaque étape, sélectionne, et confirme si le
 *     risque l'exige.
 *
 * Un client ne désigne jamais l'exécutant. Il déclare des **capacités
 * requises** ; le sélecteur choisit. C'est ce qui empêche « envoie ça au poste
 * fixe » de devenir un chemin d'exécution dirigé depuis un téléphone.
 */

const stepSchema = z.object({
  id: z.string(),
  description: z.string(),
  requiredCapabilities: z.array(z.string()),
  tool: z.string(),
  status: z.string(),
  selectedDeviceId: z.string().nullable(),
  riskLevel: z.string(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

const planSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  originClientDeviceId: z.string(),
  correlationId: z.string(),
  steps: z.array(stepSchema),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

function presentPlan(plan: {
  id: string;
  title: string;
  status: string;
  originClientDeviceId: string;
  correlationId: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  steps: {
    id: string;
    description: string;
    requiredCapabilities: string[];
    tool: string;
    status: string;
    selectedDeviceId: string | null;
    riskLevel: string;
    error: { code: string; message: string; retryable: boolean } | null;
  }[];
}) {
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    originClientDeviceId: plan.originClientDeviceId,
    correlationId: plan.correlationId,
    createdAt: plan.createdAt,
    startedAt: plan.startedAt,
    completedAt: plan.completedAt,
    steps: plan.steps.map((step) => ({
      id: step.id,
      description: step.description,
      requiredCapabilities: step.requiredCapabilities,
      tool: step.tool,
      status: step.status,
      selectedDeviceId: step.selectedDeviceId,
      riskLevel: step.riskLevel,
      // `retryable` intéresse le serveur, pas l'affichage.
      error: step.error === null ? null : { code: step.error.code, message: step.error.message },
    })),
  };
}

export const taskRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /**
   * Vérifie qu'une demande de tâche est légitime avant de l'exécuter.
   *
   * Extrait plutôt qu'inséré deux fois : la création et la relance passent par
   * les mêmes contrôles, et un contrôle qu'on n'écrit qu'une fois ne peut pas
   * être oublié dans l'une des deux branches.
   */
  async function authorize(userId: string, originClientDeviceId: string, capabilities: string[]) {
    const origin = await app.services.deviceRegistry.getDevice(originClientDeviceId);
    if (origin === undefined) throw new NotFoundError("Appareil", originClientDeviceId);
    assertOwnedBy(origin.userId, userId, "Appareil");

    const granted = new Set(await app.services.permissionsFor(userId));
    const missing = capabilities.filter((capability) => !granted.has(capability));

    if (missing.length > 0) {
      // Refus avant tout dispatch. Le worker revérifiera de son côté, mais un
      // système qui compterait sur cette seconde vérification ferait reposer sa
      // sécurité sur le bon comportement de l'exécutant.
      throw new AuthorizationError({
        message: `Capacités non accordées : ${missing.join(", ")}`,
        userMessage: `You have not granted: ${missing.join(", ")}.`,
        context: { missing },
      });
    }
  }

  app.post(
    "/tasks",
    {
      preHandler: app.requireUser,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["tasks"],
        summary: "Crée et exécute un plan de tâche",
        body: z.object({
          title: z.string().min(1).max(200),
          /** L'appareil d'où part la demande. Le fil de routage de tout le reste. */
          originClientDeviceId: z.string().min(1),
          conversationId: z.string().min(1).optional(),
          steps: z
            .array(
              z.object({
                id: z.string().min(1).optional(),
                description: z.string().min(1).max(500),
                requiredCapabilities: z.array(z.string().min(1)).min(1).max(8),
                tool: z.string().min(1),
                arguments: z.unknown().optional(),
                dependsOn: z.array(z.string()).max(16).default([]),
                riskLevel: riskLevelSchema.optional(),
                timeoutMs: z.number().int().min(1_000).max(1_800_000).optional(),
              }),
            )
            .min(1)
            .max(32),
        }),
        response: { 202: okSchema(planSchema) },
      },
    },
    async (request, reply) => {
      // Une tâche d'appareil n'emprunte pas la couche de permissions de l'agent :
      // elle est soumise directement. Le coupe-circuit doit donc être vérifié
      // ici aussi, sans quoi la pause ne couvrirait qu'une moitié du système.
      app.services.pause.assertRunning();
      const { userId } = currentUser(request);
      const capabilities = request.body.steps.flatMap((step) => step.requiredCapabilities);

      await authorize(userId, request.body.originClientDeviceId, capabilities);

      const plan = createTaskPlan({
        userId,
        title: request.body.title,
        originClientDeviceId: request.body.originClientDeviceId,
        correlationId: request.id,
        ...(request.body.conversationId === undefined
          ? {}
          : { conversationId: request.body.conversationId }),
        steps: request.body.steps as TaskStepInput[],
      });

      // L'exécution n'est pas attendue : un plan peut durer des minutes, et une
      // requête HTTP qui l'attendrait expirerait. Le client suit la suite par le
      // canal temps réel — c'est précisément à cela qu'il sert.
      app.services.supervisor.start(plan, await app.services.permissionsFor(userId));

      return reply.code(202).send(ok(presentPlan(plan), request.id));
    },
  );

  app.post(
    "/tasks/instruct",
    {
      preHandler: app.requireUser,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["tasks"],
        summary: "Planifie et exécute une tâche à partir d'une instruction en langage naturel",
        body: z.object({
          instruction: z.string().min(1).max(2000),
          originClientDeviceId: z.string().min(1),
          conversationId: z.string().min(1).optional(),
        }),
        response: { 202: okSchema(planSchema) },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      const originClientDeviceId = request.body.originClientDeviceId;

      if (!app.services.llmProvider) {
        throw new Error("Le service LLMProvider n'est pas configuré");
      }

      app.services.pause.assertRunning();
      const availableCapabilities = await app.services.permissionsFor(userId);

      const planner = new TaskPlanner({
        llm: app.services.llmProvider,
        availableCapabilities,
      });

      const { planInput } = await planner.plan({
        instruction: request.body.instruction,
        userId,
        originClientDeviceId,
        correlationId: request.id,
      });

      if (request.body.conversationId !== undefined) {
        planInput.conversationId = request.body.conversationId;
      }

      const capabilities = planInput.steps.flatMap((step) => step.requiredCapabilities);
      await authorize(userId, originClientDeviceId, capabilities);

      const plan = createTaskPlan(planInput);
      app.services.supervisor.start(plan, availableCapabilities);

      return reply.code(202).send(ok(presentPlan(plan), request.id));
    },
  );

  app.get(
    "/tasks/:taskId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["tasks"],
        params: z.object({ taskId: z.string().min(1) }),
        response: { 200: okSchema(planSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const plan = await app.services.taskStore.get(request.params.taskId);

      if (plan === undefined) throw new NotFoundError("Tâche", request.params.taskId);
      assertOwnedBy(plan.userId, userId, "Tâche");

      return ok(presentPlan(plan), request.id);
    },
  );

  app.post(
    "/tasks/:taskId/cancel",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["tasks"],
        summary: "Annule une tâche en cours",
        params: z.object({ taskId: z.string().min(1) }),
        body: z.object({ reason: z.string().max(256).default("annulé par l'utilisateur") }),
        response: { 200: okSchema(z.object({ cancelled: z.boolean() })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const plan = await app.services.taskStore.get(request.params.taskId);

      if (plan === undefined) throw new NotFoundError("Tâche", request.params.taskId);
      assertOwnedBy(plan.userId, userId, "Tâche");

      // `false` n'est pas une erreur : la tâche est peut-être déjà terminée.
      // Le client voulait qu'elle s'arrête, et elle est arrêtée.
      const cancelled = app.services.supervisor.cancel(request.params.taskId, userId);
      request.log.info(
        { taskId: request.params.taskId, reason: request.body.reason, cancelled },
        "annulation de tâche demandée",
      );

      return ok({ cancelled }, request.id);
    },
  );

  app.get(
    "/tasks/:taskId/executions",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["tasks"],
        summary: "Journal d'exécution d'une tâche",
        params: z.object({ taskId: z.string().min(1) }),
        querystring: paginationQuerySchema,
        response: {
          200: listSchema(
            z.object({
              id: z.string(),
              stepId: z.string(),
              deviceId: z.string(),
              attempt: z.number(),
              status: z.string(),
              startedAt: z.string(),
              completedAt: z.string().nullable(),
              durationMs: z.number().nullable(),
              /** Arguments **rédigés**. Le journal d'exécution est un audit. */
              input: z.unknown(),
              error: z.object({ code: z.string(), message: z.string() }).nullable(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const plan = await app.services.taskStore.get(request.params.taskId);

      if (plan === undefined) throw new NotFoundError("Tâche", request.params.taskId);
      assertOwnedBy(plan.userId, userId, "Tâche");

      const executions = await app.services.taskStore.listExecutions(request.params.taskId);
      const page = paginate(
        executions.map((execution) => ({
          id: execution.id,
          stepId: execution.stepId,
          deviceId: execution.deviceId,
          attempt: execution.attempt,
          status: execution.status,
          startedAt: execution.startedAt,
          completedAt: execution.completedAt,
          durationMs: execution.durationMs,
          input: execution.input,
          error:
            execution.error === null
              ? null
              : { code: execution.error.code, message: execution.error.message },
        })),
        request.query,
        (execution) => execution.id,
      );

      return {
        data: page.items,
        meta: { requestId: request.id, nextCursor: page.nextCursor, total: page.total },
      };
    },
  );
  done();
};

export const confirmationRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/confirmations/:confirmationId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["confirmations"],
        params: z.object({ confirmationId: z.string().min(1) }),
        response: {
          200: okSchema(
            z.object({
              id: z.string(),
              action: z.string(),
              description: z.string(),
              riskLevel: z.string(),
              status: z.string(),
              expiresAt: z.date(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const confirmation = await app.services.confirmations.get(request.params.confirmationId);

      if (confirmation === undefined) {
        throw new NotFoundError("Confirmation", request.params.confirmationId);
      }
      assertOwnedBy(confirmation.userId, userId, "Confirmation");

      return ok(
        {
          id: confirmation.id,
          action: confirmation.action,
          description: confirmation.description,
          riskLevel: confirmation.riskLevel,
          status: confirmation.status,
          expiresAt: confirmation.expiresAt,
        },
        request.id,
      );
    },
  );

  app.post(
    "/confirmations/:confirmationId/respond",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["confirmations"],
        summary: "Approuve ou refuse — depuis n'importe quel appareil de l'utilisateur",
        params: z.object({ confirmationId: z.string().min(1) }),
        body: z.object({ decision: z.enum(["approved", "rejected"]) }),
        response: { 200: okSchema(z.object({ accepted: z.boolean() })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      // La propriété est vérifiée **par le courtier**, qui est le seul à la
      // connaître dans tous les cas : une demande émise par le coordinateur ne
      // vit d'abord que chez lui, et une vérification faite ici seulement
      // laissait passer exactement celles-là — c'est-à-dire les dangereuses.
      const accepted = await app.services.confirmationBroker.respondAndRecord(
        request.params.confirmationId,
        request.body.decision,
        userId,
      );

      // `false` n'est pas une erreur : deux clients ont pu répondre presque en
      // même temps, ou la demande a expiré entre l'affichage et le geste.
      return ok({ accepted }, request.id);
    },
  );
  done();
};
