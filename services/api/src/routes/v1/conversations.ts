import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { assertOwnedBy, currentUser } from "../../plugins/authentication.js";
import { ok, okSchema, listSchema, paginationQuerySchema } from "../../lib/response.js";
import { memoryKindSchema, storableLayerSchema, type MemoryRecord } from "@nexus/memory";
import { NotFoundError } from "../../services/stores.js";

/**
 * Conversations, messages, runs agent, mémoire, outils, notifications.
 *
 * Le regroupement suit une frontière réelle : ce sont toutes des ressources
 * **propres à l'utilisateur**, lues et écrites par ses clients, sans jamais
 * toucher un exécutant. Les tâches, elles, vivent ailleurs — parce qu'elles
 * franchissent cette frontière.
 */

const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.string(),
  content: z.string(),
  /**
   * Appareil d'où part le message.
   *
   * Conservé sur le message : c'est ce qui permet à l'iPhone d'afficher « posé
   * depuis le portable » et de ne pas resonner pour une réponse qu'on regarde
   * déjà ailleurs.
   */
  originClientDeviceId: z.string().nullable(),
  createdAt: z.date(),
});

export const conversationRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /** Charge une conversation en vérifiant qu'elle appartient à l'appelant. */
  async function load(conversationId: string, userId: string) {
    const conversation = await app.services.conversations.get(conversationId);
    if (conversation === undefined) throw new NotFoundError("Conversation", conversationId);

    assertOwnedBy(conversation.userId, userId, "Conversation");
    return conversation;
  }

  app.get(
    "/conversations",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["conversations"],
        querystring: paginationQuerySchema,
        response: { 200: listSchema(conversationSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const page = await app.services.conversations.listByUser(userId, request.query);

      return {
        data: page.items,
        meta: { requestId: request.id, nextCursor: page.nextCursor, total: page.total },
      };
    },
  );

  app.post(
    "/conversations",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["conversations"],
        body: z.object({ title: z.string().min(1).max(200) }),
        response: { 201: okSchema(conversationSchema) },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      const conversation = await app.services.conversations.create({
        userId,
        title: request.body.title,
      });

      return reply.code(201).send(ok(conversation, request.id));
    },
  );

  app.get(
    "/conversations/:conversationId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["conversations"],
        params: z.object({ conversationId: z.string().min(1) }),
        response: { 200: okSchema(conversationSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok(await load(request.params.conversationId, userId), request.id);
    },
  );

  app.post(
    "/conversations/:conversationId/archive",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["conversations"],
        params: z.object({ conversationId: z.string().min(1) }),
        response: { 200: okSchema(conversationSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      await load(request.params.conversationId, userId);

      return ok(
        await app.services.conversations.archive(request.params.conversationId),
        request.id,
      );
    },
  );

  app.get(
    "/conversations/:conversationId/messages",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["messages"],
        params: z.object({ conversationId: z.string().min(1) }),
        querystring: paginationQuerySchema,
        response: { 200: listSchema(messageSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      await load(request.params.conversationId, userId);

      const page = await app.services.conversations.listMessages(
        request.params.conversationId,
        request.query,
      );

      return {
        data: page.items,
        meta: { requestId: request.id, nextCursor: page.nextCursor, total: page.total },
      };
    },
  );

  app.post(
    "/conversations/:conversationId/messages",
    {
      preHandler: app.requireUser,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["messages"],
        summary: "Ajoute un message — le streaming de la réponse passe par le WebSocket",
        params: z.object({ conversationId: z.string().min(1) }),
        body: z.object({
          content: z.string().min(1).max(32_000),
          originClientDeviceId: z.string().min(1).optional(),
        }),
        response: { 201: okSchema(messageSchema) },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      await load(request.params.conversationId, userId);

      // L'appareil d'origine est vérifié comme appartenant à l'utilisateur : un
      // client ne se déclare pas au nom d'un autre appareil.
      const originClientDeviceId = request.body.originClientDeviceId ?? null;
      if (originClientDeviceId !== null) {
        const device = await app.services.deviceRegistry.getDevice(originClientDeviceId);
        if (device === undefined) throw new NotFoundError("Appareil", originClientDeviceId);
        assertOwnedBy(device.userId, userId, "Appareil");
      }

      const message = await app.services.conversations.appendMessage({
        conversationId: request.params.conversationId,
        role: "user",
        content: request.body.content,
        originClientDeviceId,
      });

      return reply.code(201).send(ok(message, request.id));
    },
  );
  done();
};

export const notificationRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const notificationSchema = z.object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    severity: z.string(),
    originClientDeviceId: z.string().nullable(),
    readAt: z.date().nullable(),
    createdAt: z.date(),
  });

  app.get(
    "/notifications",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["notifications"],
        querystring: paginationQuerySchema.extend({
          unreadOnly: z.coerce.boolean().default(false),
        }),
        response: { 200: listSchema(notificationSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const page = await app.services.notificationStore.listByUser(userId, request.query, {
        unreadOnly: request.query.unreadOnly,
      });

      return {
        data: page.items,
        meta: { requestId: request.id, nextCursor: page.nextCursor, total: page.total },
      };
    },
  );

  app.post(
    "/notifications/:notificationId/read",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["notifications"],
        summary: "Marque comme lue — l'état est partagé entre tous les clients",
        params: z.object({ notificationId: z.string().min(1) }),
        response: { 200: okSchema(notificationSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const notification = await app.services.notificationStore.get(request.params.notificationId);

      if (notification === undefined) {
        throw new NotFoundError("Notification", request.params.notificationId);
      }
      assertOwnedBy(notification.userId, userId, "Notification");

      // Lue sur l'iPhone, lue sur le portable : l'état vit au centre, ce qui est
      // toute la raison d'être de la synchronisation.
      return ok(
        await app.services.notificationStore.markRead(
          request.params.notificationId,
          app.services.now,
        ),
        request.id,
      );
    },
  );
  done();
};

/**
 * Mémoire.
 *
 * Toutes ces routes passent par `MemoryService`, jamais par le magasin nu. Le
 * magasin range ce qu'on lui donne ; le service est ce qui décide si on doit le
 * lui donner. Court-circuiter le service ici, « juste pour la route de
 * création », suffirait à contourner la règle du silence.
 *
 * La frontière entre utilisateurs n'est pas revérifiée route par route : chaque
 * appel porte `userId`, et le service l'applique. Une vérification recopiée dans
 * six routes finit toujours par manquer à la septième.
 */
const memoryRecordSchema = z.object({
  id: z.string(),
  content: z.string(),
  layer: z.string(),
  kind: z.string(),
  origin: z.string(),
  importance: z.number(),
  confidence: z.number(),
  tags: z.array(z.string()),
  sensitivity: z.string(),
  sensitiveCategories: z.array(z.string()),
  createdAt: z.string(),
  supersedesId: z.string().nullable(),
});

function presentMemory(record: MemoryRecord) {
  return {
    id: record.id,
    content: record.content,
    layer: record.layer,
    kind: record.kind,
    origin: record.origin,
    importance: record.importance,
    confidence: record.confidence,
    tags: record.tags,
    sensitivity: record.sensitivity,
    sensitiveCategories: record.sensitiveCategories,
    createdAt: record.validFrom.toISOString(),
    supersedesId: record.supersedesId,
  };
}

export const memoryRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/memory",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["memory"],
        summary: "Tout ce que NEXUS retient de l'utilisateur",
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(100),
          layer: storableLayerSchema.optional(),
        }),
        response: { 200: listSchema(memoryRecordSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const hits = await app.services.memoryService.list({
        userId,
        limit: request.query.limit,
        ...(request.query.layer === undefined ? {} : { layer: request.query.layer }),
      });

      return {
        data: hits.map((hit) => presentMemory(hit.record)),
        meta: { requestId: request.id, nextCursor: null, total: hits.length },
      };
    },
  );

  app.get(
    "/memory/search",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["memory"],
        summary: "Recherche dans la mémoire de l'utilisateur",
        querystring: z.object({
          q: z.string().min(1).max(1_000),
          limit: z.coerce.number().int().min(1).max(50).default(10),
          kinds: z
            .string()
            .optional()
            .transform((value) =>
              value === undefined ? undefined : value.split(",").map((kind) => kind.trim()),
            )
            .pipe(z.array(memoryKindSchema).optional()),
        }),
        response: {
          200: okSchema(
            z.object({
              hits: z.array(
                z.object({
                  id: z.string(),
                  content: z.string(),
                  kind: z.string(),
                  layer: z.string(),
                  origin: z.string(),
                  sensitivity: z.string(),
                  score: z.number(),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const hits = await app.services.memoryService.search({
        userId,
        query: request.query.q,
        limit: request.query.limit,
        ...(request.query.kinds === undefined ? {} : { kinds: request.query.kinds }),
      });

      return ok(
        {
          hits: hits.map((hit) => ({
            id: hit.record.id,
            content: hit.record.content,
            kind: hit.record.kind,
            layer: hit.record.layer,
            origin: hit.record.origin,
            sensitivity: hit.record.sensitivity,
            score: hit.score,
          })),
        },
        request.id,
      );
    },
  );

  app.post(
    "/memory",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["memory"],
        summary: "Enregistre un souvenir",
        body: z.object({
          content: z.string().min(1).max(8_000),
          kind: memoryKindSchema.default("SEMANTIC"),
          layer: storableLayerSchema.default("LONG_TERM"),
          tags: z.array(z.string().max(40)).max(16).default([]),
          importance: z.number().min(0).max(1).optional(),
          /**
           * L'utilisateur a vu la nature du contenu et l'a confirmé.
           *
           * Sans valeur par défaut à `true` : c'est ce qui donne son sens à la
           * règle. Un client qui l'envoie systématiquement la contourne, et
           * c'est un choix qu'il assume — le serveur ne peut pas savoir si la
           * question a été posée, seulement exiger qu'on la déclare.
           */
          acknowledgedSensitive: z.boolean().default(false),
        }),
        response: { 201: okSchema(memoryRecordSchema) },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      const stored = await app.services.memoryService.remember({
        userId,
        content: request.body.content,
        kind: request.body.kind,
        layer: request.body.layer,
        tags: request.body.tags,
        origin: "USER",
        acknowledgedSensitive: request.body.acknowledgedSensitive,
        ...(request.body.importance === undefined ? {} : { importance: request.body.importance }),
      });

      return reply.code(201).send(ok(presentMemory(stored), request.id));
    },
  );

  app.patch(
    "/memory/:memoryId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["memory"],
        summary: "Corrige un souvenir",
        params: z.object({ memoryId: z.string().min(1) }),
        body: z.object({
          content: z.string().min(1).max(8_000).optional(),
          importance: z.number().min(0).max(1).optional(),
          tags: z.array(z.string().max(40)).max(16).optional(),
          layer: storableLayerSchema.optional(),
          acknowledgedSensitive: z.boolean().default(false),
        }),
        response: { 200: okSchema(memoryRecordSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const updated = await app.services.memoryService.update({
        userId,
        id: request.params.memoryId,
        acknowledgedSensitive: request.body.acknowledgedSensitive,
        ...(request.body.content === undefined ? {} : { content: request.body.content }),
        ...(request.body.importance === undefined ? {} : { importance: request.body.importance }),
        ...(request.body.tags === undefined ? {} : { tags: request.body.tags }),
        ...(request.body.layer === undefined ? {} : { layer: request.body.layer }),
      });

      // Inconnu et « pas à vous » sont volontairement indiscernables : les
      // distinguer indiquerait à un curieux quels identifiants existent.
      if (updated === undefined) throw new NotFoundError("Souvenir", request.params.memoryId);
      return ok(presentMemory(updated), request.id);
    },
  );

  app.delete(
    "/memory/:memoryId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["memory"],
        summary: "Oublie un souvenir",
        params: z.object({ memoryId: z.string().min(1) }),
        response: { 200: okSchema(z.object({ forgotten: z.array(memoryRecordSchema) })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const result = await app.services.memoryService.forget({
        userId,
        id: request.params.memoryId,
      });

      if (result.forgotten.length === 0) {
        throw new NotFoundError("Souvenir", request.params.memoryId);
      }

      // On rend ce qui a disparu : l'interface peut l'afficher et proposer de
      // le redire, plutôt que de laisser l'utilisateur devant un vide.
      return ok({ forgotten: result.forgotten.map(presentMemory) }, request.id);
    },
  );

  app.post(
    "/memory/forget",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["memory"],
        summary: "Oublie par correspondance de texte, ou tout",
        body: z.object({
          match: z.string().min(1).max(1_000).optional(),
          all: z.boolean().default(false),
          /** Exigé pour un effacement total. Un souvenir se redit, pas une mémoire. */
          confirmed: z.boolean().default(false),
        }),
        response: {
          200: okSchema(
            z.object({
              forgotten: z.array(memoryRecordSchema),
              ambiguous: z.array(memoryRecordSchema),
              needsConfirmation: z.boolean(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const result = await app.services.memoryService.forget({
        userId,
        all: request.body.all,
        confirmed: request.body.confirmed,
        ...(request.body.match === undefined ? {} : { match: request.body.match }),
      });

      return ok(
        {
          forgotten: result.forgotten.map(presentMemory),
          ambiguous: result.ambiguous.map(presentMemory),
          needsConfirmation: result.needsConfirmation,
        },
        request.id,
      );
    },
  );

  app.post(
    "/memory/command",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["memory"],
        summary: "Exécute « Retiens que… » ou « Oublie… » s'il y en a une",
        body: z.object({
          text: z.string().min(1).max(8_000),
          acknowledgedSensitive: z.boolean().default(false),
          confirmedForgetAll: z.boolean().default(false),
        }),
        response: {
          200: okSchema(
            z.object({
              /** `false` quand le message n'est pas une commande — le cas normal. */
              recognized: z.boolean(),
              kind: z.enum(["remember", "forget"]).nullable(),
              message: z.string(),
              stored: memoryRecordSchema.nullable(),
              forgotten: z.array(memoryRecordSchema),
              ambiguous: z.array(memoryRecordSchema),
              needsConfirmation: z.boolean(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const outcome = await app.services.memoryService.handleCommand(userId, request.body.text, {
        acknowledgedSensitive: request.body.acknowledgedSensitive,
        confirmedForgetAll: request.body.confirmedForgetAll,
      });

      if (outcome === undefined) {
        return ok(
          {
            recognized: false,
            kind: null,
            message: "",
            stored: null,
            forgotten: [],
            ambiguous: [],
            needsConfirmation: false,
          },
          request.id,
        );
      }

      return ok(
        {
          recognized: true,
          kind: outcome.command.kind,
          message: outcome.message,
          stored: outcome.stored === undefined ? null : presentMemory(outcome.stored),
          forgotten: (outcome.forgotten?.forgotten ?? []).map(presentMemory),
          ambiguous: (outcome.forgotten?.ambiguous ?? []).map(presentMemory),
          needsConfirmation: outcome.forgotten?.needsConfirmation ?? false,
        },
        request.id,
      );
    },
  );

  done();
};

export const toolRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/tools",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["tools"],
        summary: "Outils exposés à l'agent, avec leur risque et leur disponibilité",
        response: {
          200: okSchema(
            z.object({
              tools: z.array(
                z.object({
                  name: z.string(),
                  description: z.string(),
                  riskLevel: z.string(),
                  requiredPermissions: z.array(z.string()),
                  requiresConfirmation: z.boolean(),
                  granted: z.boolean(),
                  /** Appareils capables de l'exécuter maintenant. */
                  availableOn: z.array(z.string()),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const granted = new Set(await app.services.permissionsFor(userId));
      const devices = await app.services.deviceRegistry.listDevices(userId);

      // La liste des outils est dérivée des capacités réellement présentes dans
      // la flotte, et non d'un catalogue statique : un outil qu'aucun appareil
      // ne sait exécuter n'a rien à faire dans une interface.
      const byCapability = new Map<string, string[]>();
      for (const device of devices) {
        for (const capability of device.capabilities) {
          if (!capability.enabled) continue;
          byCapability.set(capability.name, [
            ...(byCapability.get(capability.name) ?? []),
            device.id,
          ]);
        }
      }

      const tools = [...byCapability.entries()]
        .map(([capability, availableOn]) => {
          const risk =
            devices.flatMap((device) => device.capabilities).find((c) => c.name === capability)
              ?.metadata.risk ?? "MEDIUM";

          return {
            name: `device.${capability}`,
            description: `Capacité ${capability}, exercée sur un appareil de l'utilisateur.`,
            riskLevel: risk,
            requiredPermissions: [capability],
            requiresConfirmation: risk !== "SAFE" && risk !== "LOW",
            granted: granted.has(capability),
            availableOn,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      return ok({ tools }, request.id);
    },
  );
  done();
};
