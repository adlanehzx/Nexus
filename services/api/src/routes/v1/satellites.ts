import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { SATELLITE_COMMANDS } from "../../services/satellite-service.js";
import { ok, okSchema } from "../../lib/response.js";

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
const commandSchema = z.object({
  command: z.enum(SATELLITE_COMMANDS),
  params: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().uuid().optional(),
});

export const satelliteRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const deviceParams = z.object({ deviceId: deviceIdSchema });

  const requireSatellite = (
    deviceId: string,
    authorization: string | undefined,
  ): boolean => app.satellites.authenticate(deviceId, authorization);

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
      app.satellites.acceptResult(request.body);
      return reply.code(202).send({ accepted: true });
    },
  );

  app.get(
    "/satellites",
    {
      preHandler: app.requireUser,
      schema: { response: { 200: okSchema(z.object({ satellites: z.array(z.unknown()) })) } },
    },
    (request) => ok({ satellites: app.satellites.list() }, request.id),
  );

  app.post(
    "/satellites/:deviceId/commands",
    { preHandler: app.requireUser, schema: { params: deviceParams, body: commandSchema } },
    async (request, reply) => {
      const item = app.satellites.enqueue(
        request.params.deviceId,
        request.body.command,
        request.body.params,
        request.body.idempotencyKey,
      );
      return reply.code(202).send(ok(item, request.id));
    },
  );

  done();
};
