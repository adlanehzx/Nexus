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
 * Task plans, executions, confirmations.
 *
 * This is the operational core of the API: this is where words turn into
 * action on a real machine. Three gates succeed each other, in this order,
 * and **none is optional**:
 *
 *  1. The user owns the declared origin device;
 *  2. Effective permissions cover all requested capabilities;
 *  3. The coordinator re-checks at each step, selects, and confirms if
 *     the risk demands it.
 *
 * A client never specifies the executor. It declares **required capabilities**;
 * the selector chooses. This is what prevents "send this to desktop"
 * from becoming a directed execution path from a phone.
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
      // `retryable` is relevant to the server, not UI display.
      error: step.error === null ? null : { code: step.error.code, message: step.error.message },
    })),
  };
}

export const taskRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /**
   * Verifies that a task request is legitimate before execution.
   *
   * Extracted rather than duplicated: creation and replay pass through
   * the same checks, and a check written once cannot be forgotten in one branch.
   */
  async function authorize(userId: string, originClientDeviceId: string, capabilities: string[]) {
    const origin = await app.services.deviceRegistry.getDevice(originClientDeviceId);
    if (origin === undefined) throw new NotFoundError("Device", originClientDeviceId);
    assertOwnedBy(origin.userId, userId, "Device");

    const granted = new Set(await app.services.permissionsFor(userId));
    const missing = capabilities.filter((capability) => !granted.has(capability));

    if (missing.length > 0) {
      // Rejection before any dispatch. The worker will re-verify on its end,
      // but relying solely on that second check would base security on executor behavior.
      throw new AuthorizationError({
        message: `Capabilities not granted: ${missing.join(", ")}`,
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
        summary: "Creates and executes a task plan",
        body: z.object({
          title: z.string().min(1).max(200),
          /** Origin device for the request. The routing thread for everything that follows. */
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
      // A device task does not traverse the agent permission layer:
      // it is submitted directly. The circuit breaker must therefore be checked
      // here as well, otherwise pause would only cover half the system.
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

      // Execution is not awaited: a plan may take minutes, and an HTTP request
      // waiting for it would time out. The client tracks progress via the real-time channel.
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
        summary: "Plans and executes a task from a natural language instruction",
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
        throw new Error("LLMProvider service is not configured");
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

      if (plan === undefined) throw new NotFoundError("Task", request.params.taskId);
      assertOwnedBy(plan.userId, userId, "Task");

      return ok(presentPlan(plan), request.id);
    },
  );

  app.post(
    "/tasks/:taskId/cancel",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["tasks"],
        summary: "Cancels an in-flight task",
        params: z.object({ taskId: z.string().min(1) }),
        body: z.object({ reason: z.string().max(256).default("cancelled by user") }),
        response: { 200: okSchema(z.object({ cancelled: z.boolean() })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const plan = await app.services.taskStore.get(request.params.taskId);

      if (plan === undefined) throw new NotFoundError("Task", request.params.taskId);
      assertOwnedBy(plan.userId, userId, "Task");

      // `false` is not an error: the task may have already finished.
      // The client wanted it stopped, and it is stopped.
      const cancelled = app.services.supervisor.cancel(request.params.taskId, userId);
      request.log.info(
        { taskId: request.params.taskId, reason: request.body.reason, cancelled },
        "task cancellation requested",
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
        summary: "Execution log of a task",
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
              /** Redacted arguments. The execution log is an audit trail. */
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

      if (plan === undefined) throw new NotFoundError("Task", request.params.taskId);
      assertOwnedBy(plan.userId, userId, "Task");

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
        summary: "Approves or rejects — from any device belonging to the user",
        params: z.object({ confirmationId: z.string().min(1) }),
        body: z.object({ decision: z.enum(["approved", "rejected"]) }),
        response: { 200: okSchema(z.object({ accepted: z.boolean() })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      // Ownership is verified **by the broker**, which alone knows it in all cases:
      // a request issued by the coordinator only lives there initially, and a check
      // done only here would let precisely those through — i.e. dangerous ones.
      const accepted = await app.services.confirmationBroker.respondAndRecord(
        request.params.confirmationId,
        request.body.decision,
        userId,
      );

      // `false` is not an error: two clients may have responded almost simultaneously,
      // or the request expired between display and user action.
      return ok({ accepted }, request.id);
    },
  );
  done();
};
