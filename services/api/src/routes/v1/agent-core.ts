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

  /**
   * Pont Mission Engine → Agent Core.
   *
   * Surface réservée aux services internes, séparée de `/agent-core/runs` parce
   * qu'elle ne s'authentifie pas de la même façon et n'autorise pas la même
   * chose. Le moteur n'y choisit ni l'utilisateur — il vient de la signature —
   * ni la mission : il ne peut que travailler dans celle qui lui a été confiée.
   *
   * **Unicité par tentative.** Un run Agent Core dure facilement plus longtemps
   * qu'un bail de trente secondes. Si le bail expire pendant l'appel, un second
   * worker reprend la tâche et redemanderait un run : deux exécutions pour un
   * même travail, et une action faite deux fois dès qu'un outil a un effet
   * externe. La route réserve donc `(mission, tâche, tentative)` dans une table
   * à contrainte unique, et une seconde demande sur la même tentative rend le
   * run déjà réservé au lieu d'en lancer un nouveau.
   *
   * La granularité est la tentative, et c'est ce qui compte : deux workers qui
   * se disputent la même tentative convergent, alors qu'un vrai réessai après
   * échec — nouvelle tentative, nouvel identifiant — obtient bien un run neuf.
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
           * Conversation à réutiliser. Absente au premier appel, puis renvoyée
           * par le moteur à chaque nouvelle tentative : c'est ce qui fait qu'un
           * retry prolonge l'historique au lieu d'en ouvrir un second.
           */
          conversationId: z.string().uuid().optional(),
          /**
           * Tentative du moteur.
           *
           * Facultative pour ne pas casser un appelant plus ancien, mais son
           * absence désactive la garantie d'unicité — c'est dit dans le journal
           * plutôt que silencieux.
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
          message: "Agent Core ne dispose d'aucun fournisseur LLM actif.",
          userMessage: "Le moteur agent généraliste n'est pas disponible.",
        });
      }

      const { attemptId } = request.body;

      // L'identifiant est choisi **avant** la réservation, parce que c'est lui
      // qu'elle inscrit : c'est ce qui rend l'opération atomique. Le générer
      // après, ou laisser l'orchestrateur le produire, obligerait à réserver
      // puis à compléter en deux temps — et un incident entre les deux
      // laisserait une réservation sans run.
      const reservedRunId = randomUUID();

      // Réservation avant toute exécution. Si une autre requête détient déjà
      // cette tentative, c'est son run qu'on rend — sans rappeler le modèle, ce
      // qui est tout l'intérêt : un second run coûterait des jetons et
      // rejouerait les effets de bord de ses outils.
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
            assertOwnedBy(existing.userId, mission.userId, "Run agent");
            request.log.info(
              {
                grantId: mission.grantId,
                missionExternalKey: mission.missionExternalKey,
                taskKey: request.body.taskKey,
                attemptId,
                runId: existing.runId,
              },
              "tentative déjà réservée : run existant rendu sans relancer Agent Core",
            );
            return ok(present({ record: existing }), request.id);
          }
          // Réservation prise mais run introuvable : l'appelant précédent est
          // entre les deux, ou il a échoué avant la première sauvegarde. Un
          // conflit dit au moteur de réessayer plus tard ; inventer un second
          // run annulerait la garantie qu'on vient d'établir.
          throw new ConflictError(
            `Tentative ${attemptId} en cours de démarrage`,
            "Cette tâche est déjà en train de démarrer.",
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
          ? "run Agent Core demandé sans tentative : unicité non garantie"
          : "run Agent Core demandé par un service pour le compte du propriétaire de la mission",
      );

      const result = await app.services.agentCore.run({
        userId: mission.userId,
        conversationId: conversation.id,
        message: request.body.instruction,
        correlationId: request.id,
        // Inscrit sur le run : c'est ce qui permet plus tard de le relire sous
        // cette assertion, et uniquement sous celle-ci.
        missionExternalKey: mission.missionExternalKey,
        // Celui de la réservation, sans quoi elle désignerait un run qui
        // n'existe pas et la garantie d'unicité ne vaudrait rien.
        ...(attemptId === undefined ? {} : { runId: reservedRunId }),
      });
      await app.services.conversations.appendMessage({
        conversationId: conversation.id,
        role: "user",
        content: request.body.instruction,
        originClientDeviceId: null,
      });
      await persistResponse(app.services.conversations, conversation.id, result.record.response);
      return ok(present(result), request.id);
    },
  );

  /**
   * Lecture d'un run par le moteur, pour savoir où en est une confirmation.
   *
   * C'est la moitié « le moteur interroge » de la suspension durable : rien
   * n'est notifié au moteur, donc rien de nouveau n'est joignable sur son port.
   * Il redemande, et l'état qu'il lit vient de la base.
   *
   * La portée est vérifiée **deux fois** : le propriétaire, comme partout, et
   * la mission. La seconde n'est pas redondante — sans elle, une assertion
   * ouvrirait aussi les runs issus des conversations privées du compte.
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
      if (record === undefined) throw new NotFoundError("Run agent", request.params.runId);
      assertOwnedBy(record.userId, mission.userId, "Run agent");
      // `null` pour un run lancé par une personne : une assertion ne doit pas
      // pouvoir le lire, et `assertMissionScope` le refuse sur une clé vide.
      assertMissionScope(mission.missionExternalKey, record.missionExternalKey ?? "");
      return ok(present({ record }), request.id);
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

/**
 * Conversation d'une tâche de mission.
 *
 * Le moteur ne peut pas créer de conversation : elles appartiennent à un
 * utilisateur, dans PostgreSQL, et lui n'a qu'une portée. Il reçoit donc
 * l'identifiant au premier appel et le rend ensuite. La vérification de
 * propriété reste nécessaire malgré la signature : l'identifiant, lui, vient du
 * corps de la requête, et rien n'empêcherait d'y nommer la conversation d'un
 * autre compte.
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
