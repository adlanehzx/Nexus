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
   * Assertion renouvelée, quand celle présentée approche de son terme.
   *
   * La rotation voyage dans la réponse d'un appel déjà authentifié : pas de
   * second point d'entrée, pas de second identifiant à protéger, et elle se
   * produit tant que l'ancienne assertion est encore valide. Absente le reste
   * du temps — le moteur ne doit alors rien réécrire.
   */
  renewedAssertion: z
    .object({ assertion: z.string(), expiresAt: z.string() })
    .nullable()
    .optional(),
});

export const agentCoreRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /**
   * Échange une délégation durable de calendrier contre une assertion
   * courte, strictement bornée à l'occurrence. Le secret opaque n'est jamais
   * renvoyé et la clé de signature ne quitte jamais l'API.
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
          message: "Agent Core ne dispose d'aucun fournisseur LLM actif.",
          userMessage: "The general-purpose agent engine is not available.",
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
          userMessage: "The general-purpose agent engine is not available.",
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
      // La rotation est calculée après le travail, pas avant : si le run échoue,
      // rien ne justifie d'avoir émis une assertion de plus.
      const renewed = await app.services.missionGrants.renewById(mission.grantId);
      if (renewed !== undefined) {
        request.log.info(
          { grantId: mission.grantId, replacedBy: renewed.grantId },
          "assertion de mission renouvelée avant son terme",
        );
      }
      return ok(present(result, renewed), request.id);
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
      // Le chemin le plus important pour la rotation : une mission suspendue sur
      // une confirmation ne passe plus que par ici, et c'est elle qui risque de
      // dépasser la durée de vie de son assertion.
      const renewed = await app.services.missionGrants.renewById(mission.grantId);
      return ok(present({ record }, renewed), request.id);
    },
  );

  /**
   * Retrait des assertions d'une mission terminée.
   *
   * C'est le moteur qui l'appelle, avec l'assertion qu'il veut justement
   * retirer : une auto-révocation. Rien n'est plus sûr que ça ici — présenter
   * une assertion valide pour la retirer ne donne aucun pouvoir
   * supplémentaire, alors qu'un point d'entrée capable de révoquer *autrui*
   * en donnerait un.
   *
   * Idempotent : le filtre sur les assertions actives fait qu'un second appel
   * ne réécrit rien. Le moteur peut donc redemander le retrait si sa première
   * tentative a échoué sur le réseau.
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
           * Motif du retrait. `completed` est le chemin normal — la mission est
           * finie ; `revoked` est le chemin d'incident. Les distinguer permet de
           * répondre plus tard à « qu'a-t-on dû retirer en urgence ».
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
        "assertions de mission retirées",
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

function opaqueBearer(header: string | undefined): string {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    throw new AuthenticationError({ message: "Délégation de calendrier absente" });
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token.startsWith("nsg_") || token.length > 512) {
    throw new AuthenticationError({ message: "Délégation de calendrier mal formée" });
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
