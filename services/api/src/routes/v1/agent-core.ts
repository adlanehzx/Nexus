import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  assertMissionScope,
  assertOwnedBy,
  currentMission,
  currentUser,
} from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";
import { ConflictError, NotFoundError, type ConversationStore } from "../../services/stores.js";
import { AuthenticationError, DependencyError } from "@nexus/shared";
import type { IssuedMissionGrant } from "../../services/mission-grants.js";
import type { AgentRunResult } from "@nexus/agent-core";

const runSchema = z.object({
  runId: z.string(),
  conversationId: z.string(),
  status: z.string(),
  stopReason: z.string().nullable(),
  response: z.string().nullable(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  model: z.string(),
  confirmation: z
    .object({
      id: z.string(),
      toolName: z.string(),
      riskLevel: z.string(),
      expiresAt: z.date(),
    })
    .nullable(),
  /**
   * Renewed grant, when the presented one nears expiration.
   *
   * Rotation travels in the response of an already-authenticated call: no
   * second entry point, no second identifier to protect, and it occurs
   * while the old grant is still valid. Absent the rest of the time —
   * the engine need not rewrite anything then.
   */
  renewedAssertion: z
    .object({ assertion: z.string(), expiresAt: z.string() })
    .nullable()
    .optional(),
});

export const agentCoreRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /**
   * Exchanges a durable schedule delegation for a short grant,
   * strictly bounded to the occurrence. The opaque secret is never returned
   * and the signing key never leaves the API.
   */
  app.post(
    "/agent-core/schedule-grants/exchange",
    {
      schema: {
        tags: ["agent-core"],
        body: z.object({
          scheduleId: z.string().uuid(),
          scheduledFor: z.string().datetime({ offset: true }),
          missionExternalKey: z.string().min(1).max(128),
        }),
        response: {
          200: okSchema(
            z.object({
              userId: z.string().uuid(),
              assertion: z.string(),
              expiresAt: z.string(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const exchanged = await app.services.scheduleGrants.exchange({
        token: opaqueBearer(request.headers.authorization),
        scheduleId: request.body.scheduleId,
        scheduledFor: request.body.scheduledFor,
        missionExternalKey: request.body.missionExternalKey,
      });
      return ok(
        {
          userId: exchanged.owner.userId,
          assertion: exchanged.token,
          expiresAt: exchanged.expiresAt.toISOString(),
        },
        request.id,
      );
    },
  );

  app.post(
    "/agent-core/runs",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["agent-core"],
        body: z.object({
          conversationId: z.string().uuid(),
          message: z.string().min(1).max(32_000),
        }),
        response: { 200: okSchema(runSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const conversation = await app.services.conversations.get(request.body.conversationId);
      if (conversation === undefined) {
        throw new NotFoundError("Conversation", request.body.conversationId);
      }
      assertOwnedBy(conversation.userId, userId, "Conversation");
      if (app.services.agentCore === undefined) {
        throw new DependencyError({
          message: "Agent Core has no active LLM provider.",
          userMessage: "The general-purpose agent engine is not available.",
        });
      }

      const result = await app.services.agentCore.run({
        userId,
        conversationId: conversation.id,
        message: request.body.message,
        correlationId: request.id,
      });
      // Current message is added by AgentOrchestrator after assembling history.
      // Persisting it before `run()` would make it appear twice in the prompt.
      await app.services.conversations.appendMessage({
        conversationId: conversation.id,
        role: "user",
        content: request.body.message,
        originClientDeviceId: null,
      });
      await persistResponse(app.services.conversations, conversation.id, result.record.response);
      return ok(present(result), request.id);
    },
  );

  /**
   * Mission Engine → Agent Core bridge.
   *
   * Surface reserved for internal services, separate from `/agent-core/runs` because
   * it authenticates differently and authorizes different scopes. The engine chooses
   * neither the user — derived from signature — nor the mission: it can only work within
   * what was entrusted to it.
   *
   * **Uniqueness per attempt.** An Agent Core run easily lasts longer than a thirty-second lease.
   * If the lease expires during the call, a second worker reassigns the task and would request another run:
   * two executions for the same work, and an action executed twice whenever a tool has an external effect.
   * The route therefore reserves `(mission, task, attempt)` in a unique-constrained table,
   * and a second request on the same attempt returns the already reserved run instead of launching a new one.
   *
   * Granularity is the attempt, and that is what counts: two workers contesting the same attempt converge,
   * whereas a genuine retry after failure — new attempt, new ID — gets a fresh run.
   */
  app.post(
    "/agent-core/mission-runs",
    {
      preHandler: app.requireMissionGrant,
      schema: {
        tags: ["agent-core"],
        body: z.object({
          missionExternalKey: z.string().min(1).max(128),
          taskKey: z.string().min(1).max(128),
          instruction: z.string().min(1).max(100_000),
          /**
           * Conversation to reuse. Absent on first call, then returned
           * by the engine on every new attempt: ensures an agent retains memory
           * across steps of the same mission.
           */
          conversationId: z.string().uuid().optional(),
          /**
           * Engine attempt.
           *
           * Optional to avoid breaking older callers, but its absence disables
           * uniqueness guarantees — logged explicitly rather than failing silently.
           */
          attemptId: z.string().min(1).max(128).optional(),
        }),
        response: { 200: okSchema(runSchema) },
      },
    },
    async (request) => {
      const mission = currentMission(request);
      assertMissionScope(mission.missionExternalKey, request.body.missionExternalKey);

      if (app.services.agentCore === undefined) {
        throw new DependencyError({
          message: "Agent Core has no active LLM provider.",
          userMessage: "The general-purpose agent engine is not available.",
        });
      }

      const { attemptId } = request.body;

      // The identifier is chosen **before** reservation, because it is recorded
      // by it: this makes the operation atomic. Generating it afterward,
      // or letting the orchestrator produce it, would require two-step reservation
      // — and an incident in between would leave a reservation without a run.
      const reservedRunId = randomUUID();

      // Reservation before any execution. If another request already holds
      // this attempt, its run is returned — without calling the model again,
      // which is the entire point: a second run would cost tokens and
      // replay side-effects of its tools.
      if (attemptId !== undefined) {
        const reserved = await app.services.agentRunClaims.claim({
          missionExternalKey: mission.missionExternalKey,
          taskKey: request.body.taskKey,
          attemptId,
          runId: reservedRunId,
          userId: mission.userId,
        });

        if (!reserved.claimed) {
          const existing = await app.services.agentCore.getRun(reserved.existing.runId);
          if (existing !== undefined) {
            assertOwnedBy(existing.userId, mission.userId, "Agent run");
            request.log.info(
              {
                grantId: mission.grantId,
                missionExternalKey: mission.missionExternalKey,
                taskKey: request.body.taskKey,
                attemptId,
                runId: existing.runId,
              },
              "attempt already reserved: existing run returned without restarting Agent Core",
            );
            return ok(present({ record: existing }), request.id);
          }
          // Reservation claimed but run not found: the previous caller is
          // between the two, or failed before first save. A conflict tells
          // the engine to retry later; inventing a second run would void the guarantee.
          throw new ConflictError(
            `Attempt ${attemptId} currently starting`,
            "This task is already starting.",
          );
        }
      }

      const conversation = await resolveMissionConversation(app.services.conversations, {
        conversationId: request.body.conversationId,
        userId: mission.userId,
        missionExternalKey: mission.missionExternalKey,
        taskKey: request.body.taskKey,
      });

      request.log.info(
        {
          service: mission.service,
          grantId: mission.grantId,
          missionExternalKey: mission.missionExternalKey,
          taskKey: request.body.taskKey,
          attemptId: attemptId ?? null,
          conversationId: conversation.id,
        },
        attemptId === undefined
          ? "Agent Core run requested without attempt: uniqueness not guaranteed"
          : "Agent Core run requested by service on behalf of mission owner",
      );

      const result = await app.services.agentCore.run({
        userId: mission.userId,
        conversationId: conversation.id,
        message: request.body.instruction,
        correlationId: request.id,
        // Recorded on the run: allows reading it later under this grant,
        // and only under this grant.
        missionExternalKey: mission.missionExternalKey,
        // That of the reservation, otherwise it would designate a run that
        // does not exist and void uniqueness guarantees.
        ...(attemptId === undefined ? {} : { runId: reservedRunId }),
      });
      await app.services.conversations.appendMessage({
        conversationId: conversation.id,
        role: "user",
        content: request.body.instruction,
        originClientDeviceId: null,
      });
      await persistResponse(app.services.conversations, conversation.id, result.record.response);
      // Rotation is calculated after work, not before: if the run fails,
      // there is no justification for issuing another grant.
      const renewed = await app.services.missionGrants.renewById(mission.grantId);
      if (renewed !== undefined) {
        request.log.info(
          { grantId: mission.grantId, replacedBy: renewed.grantId },
          "mission grant renewed before expiration",
        );
      }
      return ok(present(result, renewed), request.id);
    },
  );

  /**
   * Reading a run by the engine, to inspect confirmation progress.
   *
   * This is the "engine polls" half of durable suspension: nothing
   * is pushed to the engine, so nothing new is exposed on its port.
   * It queries, and the state it reads comes from the database.
   *
   * Scope is verified **twice**: the owner, like everywhere, and
   * the mission. The second is not redundant — without it, a grant
   * would also open runs from private account conversations.
   */
  app.get(
    "/agent-core/mission-runs/:runId",
    {
      preHandler: app.requireMissionGrant,
      schema: {
        tags: ["agent-core"],
        params: z.object({ runId: z.string().uuid() }),
        response: { 200: okSchema(runSchema) },
      },
    },
    async (request) => {
      const mission = currentMission(request);
      const record = await app.services.agentCore?.getRun(request.params.runId);
      if (record === undefined) throw new NotFoundError("Agent run", request.params.runId);
      assertOwnedBy(record.userId, mission.userId, "Agent run");
      // `null` for a user-initiated run: a grant must not be able to read it,
      // and `assertMissionScope` rejects an empty key.
      assertMissionScope(mission.missionExternalKey, record.missionExternalKey ?? "");
      // The most critical path for rotation: a mission suspended on
      // confirmation passes only through here, and risks exceeding
      // its grant lifespan.
      const renewed = await app.services.missionGrants.renewById(mission.grantId);
      return ok(present({ record }, renewed), request.id);
    },
  );

  /**
   * Revocation of grants for a completed mission.
   *
   * The engine calls this with the grant it wants to revoke: a self-revocation.
   * Nothing is safer here — presenting a valid grant to revoke it grants no extra power,
   * whereas an entry point capable of revoking *others* would give one.
   *
   * Idempotent: filtering on active grants ensures a second call rewrites nothing.
   * The engine can therefore retry revocation if its first attempt failed on the network.
   */
  app.post(
    "/agent-core/mission-grants/retire",
    {
      preHandler: app.requireMissionGrant,
      schema: {
        tags: ["agent-core"],
        body: z.object({
          missionExternalKey: z.string().min(1).max(128),
          /**
           * Retirement reason. `completed` is the normal path — the mission
           * finished; `revoked` is the incident path. Distinguishing them enables
           * answering later 'what had to be revoked in emergency'.
           */
          reason: z.enum(["completed", "revoked"]).default("completed"),
        }),
        response: {
          200: okSchema(z.object({ retired: z.number().int().nonnegative() })),
        },
      },
    },
    async (request) => {
      const mission = currentMission(request);
      assertMissionScope(mission.missionExternalKey, request.body.missionExternalKey);

      const retired = await app.services.missionGrants.retire(
        mission.missionExternalKey,
        request.body.reason === "revoked" ? "REVOKED" : "COMPLETED",
      );
      request.log.info(
        {
          missionExternalKey: mission.missionExternalKey,
          reason: request.body.reason,
          retired,
        },
        "mission grants revoked",
      );
      return ok({ retired }, request.id);
    },
  );

  app.get(
    "/agent-core/runs/:runId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["agent-core"],
        params: z.object({ runId: z.string().uuid() }),
        response: { 200: okSchema(runSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const record = await app.services.agentCore?.getRun(request.params.runId);
      if (record === undefined) throw new NotFoundError("Agent run", request.params.runId);
      assertOwnedBy(record.userId, userId, "Agent run");
      return ok(present({ record }), request.id);
    },
  );

  app.post(
    "/agent-core/runs/:runId/confirmation",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["agent-core"],
        params: z.object({ runId: z.string().uuid() }),
        body: z.object({
          decision: z.enum(["approved", "rejected"]),
          confirmationId: z.string().uuid().optional(),
        }),
        response: { 200: okSchema(runSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const existing = await app.services.agentCore?.getRun(request.params.runId);
      if (existing === undefined) throw new NotFoundError("Agent run", request.params.runId);
      assertOwnedBy(existing.userId, userId, "Agent run");
      const result = await app.services.agentCore!.resume(
        request.params.runId,
        request.body.decision,
        request.body.confirmationId === undefined
          ? {}
          : { confirmationId: request.body.confirmationId },
      );
      await persistResponse(
        app.services.conversations,
        result.record.conversationId,
        result.record.response,
      );
      return ok(present(result), request.id);
    },
  );

  app.post(
    "/agent-core/runs/:runId/cancel",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["agent-core"],
        params: z.object({ runId: z.string().uuid() }),
        response: { 200: okSchema(z.object({ cancelled: z.boolean() })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const existing = await app.services.agentCore?.getRun(request.params.runId);
      if (existing === undefined) throw new NotFoundError("Agent run", request.params.runId);
      assertOwnedBy(existing.userId, userId, "Agent run");
      return ok(
        { cancelled: await app.services.agentCore!.cancel(request.params.runId) },
        request.id,
      );
    },
  );

  done();
};

function opaqueBearer(header: string | undefined): string {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    throw new AuthenticationError({ message: "Schedule delegation missing" });
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token.startsWith("nsg_") || token.length > 512) {
    throw new AuthenticationError({ message: "Malformed schedule delegation" });
  }
  return token;
}

function present(result: AgentRunResult, renewed?: IssuedMissionGrant) {
  return {
    renewedAssertion:
      renewed === undefined
        ? null
        : { assertion: renewed.token, expiresAt: renewed.expiresAt.toISOString() },
    runId: result.record.runId,
    conversationId: result.record.conversationId,
    status: result.record.status,
    stopReason: result.record.stopReason,
    response: result.record.response,
    usage: result.record.usage,
    model: result.record.model,
    confirmation:
      result.confirmation === undefined
        ? null
        : {
            id: result.confirmation.id,
            toolName: result.confirmation.tool,
            riskLevel: result.confirmation.riskLevel,
            expiresAt: result.confirmation.expiresAt,
          },
  };
}

/**
 * Conversation of a mission task.
 *
 * The engine cannot create conversations: they belong to a user in PostgreSQL,
 * and the engine only has a scope. It therefore receives the identifier on the first call
 * and returns it subsequently. Ownership verification remains necessary despite the signature:
 * the identifier comes from the request body, and nothing would prevent naming another user's conversation.
 */
async function resolveMissionConversation(
  conversations: ConversationStore,
  input: {
    conversationId: string | undefined;
    userId: string;
    missionExternalKey: string;
    taskKey: string;
  },
) {
  if (input.conversationId === undefined) {
    return conversations.create({
      userId: input.userId,
      title: `Mission ${input.missionExternalKey} · ${input.taskKey}`,
    });
  }

  const existing = await conversations.get(input.conversationId);
  if (existing === undefined) throw new NotFoundError("Conversation", input.conversationId);
  assertOwnedBy(existing.userId, input.userId, "Conversation");
  return existing;
}

async function persistResponse(
  conversations: ConversationStore,
  conversationId: string,
  response: string | null,
): Promise<void> {
  if (response === null) return;
  await conversations.appendMessage({
    conversationId,
    role: "assistant",
    content: response,
    originClientDeviceId: null,
  });
}
