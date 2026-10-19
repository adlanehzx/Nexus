import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { assertOwnedBy, currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";
import { NotFoundError, type ConversationStore } from "../../services/stores.js";
import { DependencyError } from "@nexus/shared";
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
});

export const agentCoreRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

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
          message: "Agent Core ne dispose d'aucun fournisseur LLM actif.",
          userMessage: "Le moteur agent généraliste n'est pas disponible.",
        });
      }

      const result = await app.services.agentCore.run({
        userId,
        conversationId: conversation.id,
        message: request.body.message,
        correlationId: request.id,
      });
      // Le message courant est ajoute par AgentOrchestrator apres assemblage de
      // l'historique. Le persister avant `run()` le ferait apparaitre deux fois
      // dans le prompt (historique + message courant).
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
      if (record === undefined) throw new NotFoundError("Run agent", request.params.runId);
      assertOwnedBy(record.userId, userId, "Run agent");
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
      if (existing === undefined) throw new NotFoundError("Run agent", request.params.runId);
      assertOwnedBy(existing.userId, userId, "Run agent");
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
      if (existing === undefined) throw new NotFoundError("Run agent", request.params.runId);
      assertOwnedBy(existing.userId, userId, "Run agent");
      return ok(
        { cancelled: await app.services.agentCore!.cancel(request.params.runId) },
        request.id,
      );
    },
  );

  done();
};

function present(result: AgentRunResult) {
  return {
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
