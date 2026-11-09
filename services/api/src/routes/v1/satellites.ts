import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { SATELLITE_COMMANDS } from "../../services/satellite-service.js";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";
import { isPrivateAddress } from "../../services/domotique/satellite-enrollment.js";

const deviceIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,47}$/);
const capabilitySchema = z.object({ name: z.string().min(1).max(64) }).passthrough();
const heartbeatSchema = z.object({
  v: z.literal(1),
  deviceId: deviceIdSchema,
  name: z.string().min(1).max(63),
  health: z.record(z.string(), z.unknown()),
  capabilities: z.array(capabilitySchema).max(64),
});
const resultSchema = z.object({
  v: z.literal(1),
  type: z.literal("command.result"),
  correlationId: z.string().min(1).max(64),
  ok: z.boolean(),
  status: z.number().int(),
  message: z.string().max(256).optional(),
  data: z.unknown().optional(),
});
const enrollSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const enrollSchema = z.object({
  v: z.literal(1),
  deviceId: deviceIdSchema,
  name: z.string().trim().min(1).max(63),
  enrollSecret: enrollSecretSchema,
  firmware: z.string().max(64).optional(),
  capabilities: z
    .array(z.object({ name: z.string().min(1).max(64) }))
    .max(64)
    .default([]),
});
const enrollStatusSchema = z.object({
  v: z.literal(1),
  deviceId: deviceIdSchema,
  enrollSecret: enrollSecretSchema,
});
const approveSchema = z.object({
  verificationCode: z.string().regex(/^\d{6}$/),
  name: z.string().trim().min(1).max(63).optional(),
  roomId: z.string().uuid().nullable().optional(),
});

const commandSchema = z.object({
  command: z.enum(SATELLITE_COMMANDS),
  params: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().uuid().optional(),
});

export const satelliteRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const deviceParams = z.object({ deviceId: deviceIdSchema });

  const requireSatellite = (deviceId: string, authorization: string | undefined): boolean =>
    app.satellites.authenticate(deviceId, authorization);

  app.post(
    "/satellites/:deviceId/heartbeat",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: { params: deviceParams, body: heartbeatSchema },
    },
    async (request, reply) => {
      if (!requireSatellite(request.params.deviceId, request.headers.authorization)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      if (request.body.deviceId !== request.params.deviceId) {
        return reply.code(400).send({ error: "path/body device mismatch" });
      }
      app.satellites.heartbeat(request.body);
      return reply.send({ accepted: true });
    },
  );

  app.get(
    "/satellites/:deviceId/commands/next",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: { params: deviceParams },
    },
    async (request, reply) => {
      if (!requireSatellite(request.params.deviceId, request.headers.authorization)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const command = app.satellites.next(request.params.deviceId);
      return command === undefined ? reply.code(204).send() : reply.send(command);
    },
  );

  app.post(
    "/satellites/:deviceId/commands/result",
    { schema: { params: deviceParams, body: resultSchema } },
    async (request, reply) => {
      if (!requireSatellite(request.params.deviceId, request.headers.authorization)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      if (!app.satellites.acceptResult(request.params.deviceId, request.body)) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(202).send({ accepted: true });
    },
  );

  app.get(
    "/satellites",
    {
      preHandler: app.requireUser,
      schema: { response: { 200: okSchema(z.object({ satellites: z.array(z.unknown()) })) } },
    },
    (request) =>
      ok(
        {
          satellites: app.satellites
            .list()
            .filter((satellite) =>
              app.satellites.isOwnedBy(satellite.deviceId, currentUser(request).userId),
            ),
        },
        request.id,
      ),
  );

  app.post(
    "/satellites/:deviceId/commands",
    { preHandler: app.requireUser, schema: { params: deviceParams, body: commandSchema } },
    async (request, reply) => {
      if (!app.satellites.isOwnedBy(request.params.deviceId, currentUser(request).userId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const item = app.satellites.enqueue(
        request.params.deviceId,
        request.body.command,
        request.body.params,
        request.body.idempotencyKey,
      );
      return reply.code(202).send(ok(item, request.id));
    },
  );

  app.get(
    "/satellites/:deviceId/commands/:correlationId",
    {
      preHandler: app.requireUser,
      schema: { params: deviceParams.extend({ correlationId: z.string().uuid() }) },
    },
    async (request, reply) => {
      if (!app.satellites.isOwnedBy(request.params.deviceId, currentUser(request).userId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      const status = app.satellites.commandStatus(
        request.params.deviceId,
        request.params.correlationId,
      );
      if (!status) return reply.code(404).send({ error: "not_found" });
      return reply.send(ok(status, request.id));
    },
  );

  // ── Network enrolment (Lab 4) ───────────────────────────────────────────
  //
  // A satellite that has no token yet announces itself; a user approves it in
  // the dashboard after comparing the 6-digit code. Device endpoints accept
  // only private-network callers: enrolment is a LAN ceremony.

  const lanOnly = (ip: string) => isPrivateAddress(ip);

  app.post(
    "/satellites/enroll",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { tags: ["satellites"], body: enrollSchema },
    },
    async (request, reply) => {
      if (!lanOnly(request.ip)) return reply.code(403).send({ error: "lan_only" });
      const result = await app.services.satelliteEnrollment.announce({
        deviceId: request.body.deviceId,
        name: request.body.name,
        enrollSecret: request.body.enrollSecret,
        firmware: request.body.firmware,
        capabilities: request.body.capabilities,
        sourceIp: request.ip,
      });
      return reply.code(result.status === "pending" ? 202 : 200).send({ v: 1, ...result });
    },
  );

  app.post(
    "/satellites/enroll/status",
    {
      config: { rateLimit: { max: 40, timeWindow: "1 minute" } },
      schema: { tags: ["satellites"], body: enrollStatusSchema },
    },
    async (request, reply) => {
      if (!lanOnly(request.ip)) return reply.code(403).send({ error: "lan_only" });
      const result = await app.services.satelliteEnrollment.poll(request.body);
      return reply.code(result.status === "unknown" ? 404 : 200).send({ v: 1, ...result });
    },
  );

  app.get(
    "/satellites/enrollments",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["satellites"],
        summary:
          "Satellites waiting for approval on this NEXUS (codes are NOT returned: read them on the device) and the caller's enrolled satellites",
        response: { 200: okSchema(z.unknown()) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const enrollment = app.services.satelliteEnrollment;
      const live = new Map(app.satellites.list().map((s) => [s.deviceId, s]));
      const pending = (await enrollment.pending()).map((r) => ({
        deviceId: r.deviceId,
        name: r.name,
        firmware: r.firmware,
        capabilities: r.capabilities.map((c) => c.name),
        sourceIp: r.sourceIp,
        announcedAt: r.createdAt,
      }));
      const owned = (await enrollment.owned(userId)).map((r) => ({
        deviceId: r.deviceId,
        name: r.name,
        firmware: r.firmware,
        capabilities: r.capabilities.map((c) => c.name),
        approvedAt: r.approvedAt,
        tokenDelivered: r.tokenDelivered,
        online:
          live.get(r.deviceId)?.online === true ||
          app.services.satelliteVoice.status(r.deviceId)?.connected === true,
      }));
      return ok({ pending, owned }, request.id);
    },
  );

  app.post(
    "/satellites/enrollments/:deviceId/approve",
    {
      preHandler: app.requireUser,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["satellites"],
        params: deviceParams,
        body: approveSchema,
        response: { 200: okSchema(z.unknown()) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const record = await app.services.satelliteEnrollment.approve(
        userId,
        request.params.deviceId,
        {
          verificationCode: request.body.verificationCode,
          name: request.body.name,
        },
      );
      if (request.body.roomId !== undefined) {
        await app.services.domotique
          .updateDevice(userId, `sat:${record.deviceId}`, { roomId: request.body.roomId })
          .catch(() => undefined);
      }
      return ok(
        { deviceId: record.deviceId, name: record.name, status: record.status },
        request.id,
      );
    },
  );

  app.post(
    "/satellites/enrollments/:deviceId/reject",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["satellites"],
        params: deviceParams,
        response: { 200: okSchema(z.unknown()) },
      },
    },
    async (request) => {
      await app.services.satelliteEnrollment.reject(request.params.deviceId);
      return ok({ rejected: true }, request.id);
    },
  );

  app.delete(
    "/satellites/:deviceId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["satellites"],
        params: deviceParams,
        response: { 200: okSchema(z.unknown()) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      await app.services.satelliteEnrollment.remove(userId, request.params.deviceId);
      app.satellites.forget(request.params.deviceId);
      return ok({ removed: true }, request.id);
    },
  );

  done();
};
