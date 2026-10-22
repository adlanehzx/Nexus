import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { assertOwnedBy, currentUser } from "../../plugins/authentication.js";
import { ok, okSchema, listSchema, paginationQuerySchema } from "../../lib/response.js";
import { memoryKindSchema, storableLayerSchema, type MemoryRecord } from "@nexus/memory";
import { NotFoundError } from "../../services/stores.js";

/**
 * Conversations, messages, agent runs, memory, tools, notifications.
 *
 * The grouping follows a real boundary: these are all resources
 * **specific to the user**, read and written by their clients, without ever
 * touching an executor. Tasks, on the other hand, live elsewhere — because
 * they cross that boundary.
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
   * Device from which the message originated.
   *
   * Preserved on the message: allows the iPhone to display "sent from laptop"
   * and avoid chiming again for a response already viewed elsewhere.
   */
  originClientDeviceId: z.string().nullable(),
  createdAt: z.date(),
});

export const conversationRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /** Loads a conversation, verifying that it belongs to the caller. */
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
        summary: "Appends a message — response streaming occurs via WebSocket",
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

      // The origin device is verified to belong to the user:
      // a client cannot claim to act on behalf of another device.
      const originClientDeviceId = request.body.originClientDeviceId ?? null;
      if (originClientDeviceId !== null) {
        const device = await app.services.deviceRegistry.getDevice(originClientDeviceId);
        if (device === undefined) throw new NotFoundError("Device", originClientDeviceId);
        assertOwnedBy(device.userId, userId, "Device");
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
        summary: "Marks as read — state is shared across all clients",
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

      // Read on iPhone, read on laptop: state lives centrally, which is
      // the entire purpose of synchronization.
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
 * Memory.
 *
 * All these routes pass through `MemoryService`, never through the raw store.
 * The store saves what it is given; the service decides whether it should be given.
 * Short-circuiting the service here, "just for the creation route", would suffice
 * to bypass the silence rule.
 *
 * The user boundary is not re-checked route by route: each call carries `userId`,
 * and the service enforces it. A check duplicated across six routes inevitably
 * ends up missing on the seventh.
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
        summary: "Everything NEXUS remembers about the user",
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
        summary: "Search user memory",
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
        summary: "Saves a memory",
        body: z.object({
          content: z.string().min(1).max(8_000),
          kind: memoryKindSchema.default("SEMANTIC"),
          layer: storableLayerSchema.default("LONG_TERM"),
          tags: z.array(z.string().max(40)).max(16).default([]),
          importance: z.number().min(0).max(1).optional(),
          /**
           * The user acknowledged the sensitive nature of the content and confirmed it.
           *
           * No default value of `true`: that is what gives meaning to the rule.
           * A client sending it systematically bypasses it, and that is a deliberate choice
           * on its part — the server cannot know if the prompt was shown, only require its declaration.
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
        summary: "Updates a memory",
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

      // Unknown and "not yours" are intentionally indistinguishable:
      // distinguishing them would reveal to an attacker which IDs exist.
      if (updated === undefined) throw new NotFoundError("Memory", request.params.memoryId);
      return ok(presentMemory(updated), request.id);
    },
  );

  app.delete(
    "/memory/:memoryId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["memory"],
        summary: "Forgets a memory",
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
        throw new NotFoundError("Memory", request.params.memoryId);
      }

      // Return what was deleted: the UI can display it and offer to
      // restate it, rather than leaving the user with an empty screen.
      return ok({ forgotten: result.forgotten.map(presentMemory) }, request.id);
    },
  );

  app.post(
    "/memory/forget",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["memory"],
        summary: "Forgets by text match, or all",
        body: z.object({
          match: z.string().min(1).max(1_000).optional(),
          all: z.boolean().default(false),
          /** Required for total erasure. A single memory can be restated; an entire memory bank cannot. */
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
        summary: "Executes 'Remember that...' or 'Forget...' if present",
        body: z.object({
          text: z.string().min(1).max(8_000),
          acknowledgedSensitive: z.boolean().default(false),
          confirmedForgetAll: z.boolean().default(false),
        }),
        response: {
          200: okSchema(
            z.object({
              /** `false` when the message is not a command — the normal case. */
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
        summary: "Tools exposed to the agent, with risk level and availability",
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
                  /** Devices capable of executing it now. */
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

      // The tool list is derived from capabilities actually present in
      // the fleet, not a static catalog: a tool that no device can execute
      // has no place in a UI.
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
            description: `Capability ${capability}, executed on a user device.`,
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
