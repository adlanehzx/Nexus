import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";
import { organizationRoleSchema, identityProtocolSchema } from "../../services/tenant-platform.js";

const organizationSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  mode: z.enum(["LOCAL", "HOSTED"]),
});
const organizationParams = z.object({ organizationId: z.string().uuid() });

export const organizationRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = app.services.tenantPlatform;
  const requireService = () => {
    if (service === undefined) throw new Error("Hosted organization services are not configured.");
    return service;
  };

  app.post(
    "/organizations",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        body: z.object({ name: z.string().min(1).max(200), slug: z.string().min(2).max(63) }),
        response: { 201: okSchema(z.object({ organization: organizationSchema })) },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      const organization = await requireService().createOrganization(userId, request.body);
      return reply.code(201).send(ok({ organization }, request.id));
    },
  );

  app.get(
    "/organizations/:organizationId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams,
        response: { 200: okSchema(z.object({ organization: organizationSchema })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok(
        {
          organization: await requireService().getOrganization(
            request.params.organizationId,
            userId,
          ),
        },
        request.id,
      );
    },
  );

  app.put(
    "/organizations/:organizationId/members/:userId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams.extend({ userId: z.string().uuid() }),
        body: z.object({ role: organizationRoleSchema }),
        response: { 200: okSchema(z.object({ updated: z.literal(true) })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      await requireService().addMember(request.params.organizationId, userId, {
        userId: request.params.userId,
        role: request.body.role,
      });
      return ok({ updated: true as const }, request.id);
    },
  );

  app.post(
    "/organizations/:organizationId/teams",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams,
        body: z.object({ name: z.string().min(1).max(200) }),
        response: {
          201: okSchema(z.object({ team: z.object({ id: z.string().uuid(), name: z.string() }) })),
        },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      const team = await requireService().createTeam(
        request.params.organizationId,
        userId,
        request.body.name,
      );
      return reply.code(201).send(ok({ team }, request.id));
    },
  );

  app.put(
    "/organizations/:organizationId/teams/:teamId/members/:userId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams.extend({ teamId: z.string().uuid(), userId: z.string().uuid() }),
        response: { 200: okSchema(z.object({ updated: z.literal(true) })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      await requireService().addTeamMember(
        request.params.organizationId,
        userId,
        request.params.teamId,
        request.params.userId,
      );
      return ok({ updated: true as const }, request.id);
    },
  );

  app.put(
    "/organizations/:organizationId/identity",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams,
        body: z.object({
          protocol: identityProtocolSchema,
          issuer: z.url(),
          clientId: z.string().min(1).max(500),
          metadata: z.record(z.string(), z.unknown()).optional(),
          enabled: z.boolean().optional(),
        }),
        response: { 200: okSchema(z.object({ identityId: z.string().uuid() })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const identity = await requireService().configureIdentity(
        request.params.organizationId,
        userId,
        request.body,
      );
      return ok({ identityId: identity.id }, request.id);
    },
  );

  app.put(
    "/organizations/:organizationId/quotas/:key",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams.extend({ key: z.string().min(1).max(100) }),
        body: z.object({ limit: z.string().regex(/^\d+$/) }),
        response: { 200: okSchema(z.object({ updated: z.literal(true) })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      await requireService().setQuota(
        request.params.organizationId,
        userId,
        request.params.key,
        BigInt(request.body.limit),
      );
      return ok({ updated: true as const }, request.id);
    },
  );

  app.get(
    "/organizations/:organizationId/quotas/:key",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams.extend({ key: z.string().min(1).max(100) }),
        response: {
          200: okSchema(
            z.object({
              quota: z
                .object({ limit: z.string(), used: z.string() })
                .nullable()
                .describe("null means unknown, never unlimited"),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const quota = await requireService().quota(
        request.params.organizationId,
        userId,
        request.params.key,
      );
      return ok(
        {
          quota:
            quota === undefined ? null : { limit: String(quota.limit), used: String(quota.used) },
        },
        request.id,
      );
    },
  );

  app.post(
    "/organizations/:organizationId/mission-shares",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams,
        body: z.object({
          missionId: z.string().min(1).max(200),
          principalType: z.enum(["USER", "TEAM"]),
          principalId: z.string().min(1).max(200),
          permission: z.enum(["VIEW", "COMMENT", "EDIT"]),
        }),
        response: { 201: okSchema(z.object({ grantId: z.string().uuid() })) },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      const grantId = await requireService().shareMission(
        request.params.organizationId,
        userId,
        request.body,
      );
      return reply.code(201).send(ok({ grantId }, request.id));
    },
  );

  app.post(
    "/organizations/:organizationId/usage",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams,
        body: z.object({
          provider: z.string().min(1).max(100),
          metric: z.string().min(1).max(100),
          quantity: z.string().regex(/^\d+$/),
          costMicrounits: z.string().regex(/^\d+$/).nullable(),
          official: z.boolean(),
          occurredAt: z.iso.datetime({ offset: true }),
        }),
        response: { 201: okSchema(z.object({ usageId: z.string().uuid() })) },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      const usageId = await requireService().recordUsage(request.params.organizationId, userId, {
        ...request.body,
        quantity: BigInt(request.body.quantity),
        costMicrounits:
          request.body.costMicrounits === null ? null : BigInt(request.body.costMicrounits),
        occurredAt: new Date(request.body.occurredAt),
      });
      return reply.code(201).send(ok({ usageId }, request.id));
    },
  );

  app.get(
    "/organizations/:organizationId/usage",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams,
        response: {
          200: okSchema(
            z.object({
              usage: z.array(
                z.object({
                  provider: z.string(),
                  metric: z.string(),
                  quantity: z.string(),
                  costMicrounits: z.string().nullable(),
                  official: z.boolean(),
                  occurredAt: z.string(),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const usage = (await requireService().listUsage(request.params.organizationId, userId)).map(
        (item) => ({
          ...item,
          quantity: String(item.quantity),
          costMicrounits: item.costMicrounits === null ? null : String(item.costMicrounits),
          occurredAt: item.occurredAt.toISOString(),
        }),
      );
      return ok({ usage }, request.id);
    },
  );

  app.put(
    "/organizations/:organizationId/fleet/:installationId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams.extend({ installationId: z.string().min(1).max(200) }),
        body: z.object({
          displayName: z.string().min(1).max(200),
          status: z.enum(["ONLINE", "OFFLINE", "DEGRADED"]),
          capabilities: z.array(z.string().min(1).max(100)).max(100),
          lastSeenAt: z.iso.datetime({ offset: true }),
        }),
        response: { 200: okSchema(z.object({ installationId: z.string().uuid() })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const installationId = await requireService().registerFleetInstallation(
        request.params.organizationId,
        userId,
        {
          installationId: request.params.installationId,
          ...request.body,
          lastSeenAt: new Date(request.body.lastSeenAt),
        },
      );
      return ok({ installationId }, request.id);
    },
  );

  app.get(
    "/organizations/:organizationId/fleet",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams,
        response: {
          200: okSchema(
            z.object({
              installations: z.array(z.object({ installationId: z.string(), status: z.string() })),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok(
        { installations: await requireService().listFleet(request.params.organizationId, userId) },
        request.id,
      );
    },
  );

  app.post(
    "/organizations/:organizationId/collaboration/:channelId/events",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams.extend({ channelId: z.string().min(1).max(200) }),
        body: z.object({
          kind: z.string().min(1).max(100),
          payload: z.record(z.string(), z.unknown()),
        }),
        response: {
          201: okSchema(z.object({ id: z.string().uuid(), sequence: z.number().int() })),
        },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      const event = await requireService().appendCollaborationEvent(
        request.params.organizationId,
        userId,
        { channelId: request.params.channelId, ...request.body },
      );
      app.services.tenantRealtime.publish(
        request.params.organizationId,
        request.params.channelId,
        event,
      );
      return reply.code(201).send(ok(event, request.id));
    },
  );

  app.get(
    "/organizations/:organizationId/collaboration/:channelId/events",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams.extend({ channelId: z.string().min(1).max(200) }),
        querystring: z.object({ after: z.coerce.number().int().nonnegative().default(0) }),
        response: { 200: okSchema(z.object({ events: z.array(z.any()) })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok(
        {
          events: await requireService().collaborationEvents(
            request.params.organizationId,
            userId,
            request.params.channelId,
            request.query.after,
          ),
        },
        request.id,
      );
    },
  );

  app.get(
    "/organizations/:organizationId/collaboration/:channelId/stream",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams.extend({ channelId: z.string().min(1).max(200) }),
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      // An empty scoped query performs authorization before the connection is hijacked.
      await requireService().collaborationEvents(
        request.params.organizationId,
        userId,
        request.params.channelId,
        Number.MAX_SAFE_INTEGER,
      );
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      reply.raw.write("event: ready\ndata: {}\n\n");
      const unsubscribe = app.services.tenantRealtime.subscribe(
        request.params.organizationId,
        request.params.channelId,
        (event) => reply.raw.write(`event: collaboration\ndata: ${JSON.stringify(event)}\n\n`),
      );
      request.raw.once("close", unsubscribe);
      return reply;
    },
  );

  app.post(
    "/organizations/:organizationId/artifacts",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams,
        body: z.object({
          missionId: z.string().min(1).max(200),
          artifactKey: z.string().min(1).max(200),
          uri: z.string().min(1).max(2_000),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
        response: { 201: okSchema(z.object({ artifactId: z.string().uuid() })) },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      const artifactId = await requireService().registerArtifact(
        request.params.organizationId,
        userId,
        request.body,
      );
      return reply.code(201).send(ok({ artifactId }, request.id));
    },
  );

  app.get(
    "/organizations/:organizationId/artifacts",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["organizations"],
        params: organizationParams,
        querystring: z.object({ missionId: z.string().min(1).max(200) }),
        response: { 200: okSchema(z.object({ artifacts: z.array(z.any()) })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok(
        {
          artifacts: await requireService().listArtifacts(
            request.params.organizationId,
            userId,
            request.query.missionId,
          ),
        },
        request.id,
      );
    },
  );

  done();
};
