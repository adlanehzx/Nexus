import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { homeActionSchema, routineInputSchema, sceneInputSchema } from "@nexus/devices";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";

/**
 * Lab 4 — Domotique.
 *
 * Every route is user-authenticated and owner-scoped: the caller's Home
 * Assistant, rooms, scenes and routines. The HA token is write-only: it can
 * be set or replaced, never read back.
 */

const haConfigBody = z.object({
  baseUrl: z.string().min(1).max(300),
  /** Long-lived access token. Omit to keep the stored one. */
  token: z.string().min(8).max(4096).optional(),
  enabled: z.boolean().optional(),
  sensitiveClasses: z
    .array(z.string().regex(/^[a-z_]{2,40}$/))
    .max(20)
    .optional(),
});

const devicePatch = z.object({
  roomId: z.string().uuid().nullable().optional(),
  sensitive: z.boolean().nullable().optional(),
  alias: z.string().trim().min(1).max(80).nullable().optional(),
  hidden: z.boolean().optional(),
});

const roomBody = z.object({ name: z.string().trim().min(1).max(60) });
const roomPatch = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

const idParams = z.object({ id: z.string().min(1).max(64) });
const anyOk = { 200: okSchema(z.unknown()) };

export const domotiqueRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const home = () => app.services.domotique;

  // ── Home Assistant link ────────────────────────────────────────────────

  app.get(
    "/domotique/home-assistant",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["domotique"],
        summary: "Home Assistant link and live connection status",
        response: anyOk,
      },
    },
    async (request) => ok(await home().status(currentUser(request).userId), request.id),
  );

  app.post(
    "/domotique/home-assistant",
    {
      preHandler: app.requireUser,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["domotique"],
        summary:
          "Configure Home Assistant URL / token (token is stored in the vault, never returned)",
        body: haConfigBody,
        response: anyOk,
      },
    },
    async (request) =>
      ok(await home().configure(currentUser(request).userId, request.body), request.id),
  );

  app.delete(
    "/domotique/home-assistant",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["domotique"],
        summary: "Unlink Home Assistant and delete its token",
        response: anyOk,
      },
    },
    async (request) => {
      await home().unlink(currentUser(request).userId);
      return ok({ unlinked: true }, request.id);
    },
  );

  app.post(
    "/domotique/home-assistant/test",
    {
      preHandler: app.requireUser,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["domotique"],
        summary: "Probe the configured Home Assistant",
        response: anyOk,
      },
    },
    async (request) => ok(await home().testConnection(currentUser(request).userId), request.id),
  );

  app.post(
    "/domotique/home-assistant/resync",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["domotique"],
        summary: "Re-read HA entities, areas and devices",
        response: anyOk,
      },
    },
    async (request) => {
      await home().resync(currentUser(request).userId);
      return ok({ resynced: true }, request.id);
    },
  );

  // ── Hands-free setup ───────────────────────────────────────────────────

  app.get(
    "/domotique/home-assistant/discover",
    {
      preHandler: app.requireUser,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["domotique"],
        summary:
          "Find Home Assistant on the LAN (mDNS + well-known addresses), with onboarding state",
        response: anyOk,
      },
    },
    async (request) => ok({ instances: await home().discoverHomeAssistant() }, request.id),
  );

  app.post(
    "/domotique/home-assistant/auto-setup",
    {
      preHandler: app.requireUser,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["domotique"],
        summary:
          "Onboard a fresh Home Assistant on the user's behalf and connect NEXUS to it. Generated HA owner credentials are returned once.",
        body: z.object({
          baseUrl: z.string().min(1).max(300),
          username: z.string().trim().min(3).max(40).optional(),
          password: z.string().min(8).max(200).optional(),
          language: z
            .string()
            .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
            .optional(),
        }),
        response: anyOk,
      },
    },
    async (request) => {
      const user = currentUser(request);
      const account = await app.services.users.findById(user.userId);
      return ok(
        await home().autoSetupHomeAssistant(user.userId, {
          baseUrl: request.body.baseUrl,
          ownerName: account?.displayName ?? "NEXUS",
          ...(request.body.username === undefined ? {} : { username: request.body.username }),
          ...(request.body.password === undefined ? {} : { password: request.body.password }),
          ...(request.body.language === undefined ? {} : { language: request.body.language }),
        }),
        request.id,
      );
    },
  );

  app.post(
    "/domotique/home-assistant/login",
    {
      preHandler: app.requireUser,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["domotique"],
        summary:
          "Connect to an existing Home Assistant with its username/password (used once, never stored); NEXUS creates its own long-lived token",
        body: z.object({
          baseUrl: z.string().min(1).max(300),
          username: z.string().min(1).max(100),
          password: z.string().min(1).max(200),
        }),
        response: anyOk,
      },
    },
    async (request) =>
      ok(await home().loginHomeAssistant(currentUser(request).userId, request.body), request.id),
  );

  app.get(
    "/domotique/home-assistant/discovered",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["domotique"],
        summary: "Devices and integrations Home Assistant discovered on the network",
        response: anyOk,
      },
    },
    async (request) =>
      ok(
        { integrations: await home().discoveredIntegrations(currentUser(request).userId) },
        request.id,
      ),
  );

  app.post(
    "/domotique/home-assistant/discovered/:flowId/accept",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["domotique"],
        params: z.object({ flowId: z.string().regex(/^[a-zA-Z0-9]{8,64}$/) }),
        response: anyOk,
      },
    },
    async (request) =>
      ok(
        await home().acceptIntegration(currentUser(request).userId, request.params.flowId),
        request.id,
      ),
  );

  // ── Android / Fire TV (ADB) ─────────────────────────────────────────────

  app.get(
    "/domotique/tvs",
    { preHandler: app.requireUser, schema: { tags: ["domotique"], response: anyOk } },
    async (request) => ok(await home().listTvs(currentUser(request).userId), request.id),
  );

  app.post(
    "/domotique/tvs",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["domotique"],
        body: z.object({
          serial: z.string().min(3).max(128),
          name: z.string().max(60).default("TV"),
        }),
        response: anyOk,
      },
    },
    async (request) =>
      ok(await home().addTv(currentUser(request).userId, request.body), request.id),
  );

  app.delete(
    "/domotique/tvs/:serial",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["domotique"],
        params: z.object({ serial: z.string().min(3).max(128) }),
        response: anyOk,
      },
    },
    async (request) => {
      await home().removeTv(currentUser(request).userId, request.params.serial);
      return ok({ deleted: true }, request.id);
    },
  );

  // ── Unified registry ───────────────────────────────────────────────────

  app.get(
    "/domotique/devices",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["domotique"],
        summary: "Every home device with room, capabilities and live state",
        response: anyOk,
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const [devices, rooms, status] = await Promise.all([
        home().listDevices(userId),
        home().listRooms(userId),
        home().status(userId),
      ]);
      return ok({ devices, rooms, homeAssistant: status }, request.id);
    },
  );

  app.patch(
    "/domotique/devices/:id",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["domotique"],
        summary: "Assign room, alias, sensitivity or visibility of a device",
        params: z.object({ id: z.string().min(1).max(200) }),
        body: devicePatch,
        response: anyOk,
      },
    },
    async (request) =>
      ok(
        await home().updateDevice(currentUser(request).userId, request.params.id, request.body),
        request.id,
      ),
  );

  app.post(
    "/devices/:deviceId/actions",
    {
      preHandler: app.requireUser,
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        tags: ["domotique"],
        summary:
          "Run an action on a home device, validated against its capabilities. Sensitive devices return 202 with a confirmation id.",
        params: z.object({ deviceId: z.string().min(1).max(200) }),
        body: homeActionSchema,
        response: { 200: okSchema(z.unknown()), 202: okSchema(z.unknown()) },
      },
    },
    async (request, reply) => {
      const outcome = await home().executeAction({
        ownerId: currentUser(request).userId,
        deviceId: request.params.deviceId,
        action: request.body,
        origin: "user",
        confirmed: false,
      });
      if (outcome.status === "pending_confirmation") reply.code(202);
      return ok(outcome, request.id);
    },
  );

  // ── Rooms ──────────────────────────────────────────────────────────────

  app.get(
    "/domotique/rooms",
    { preHandler: app.requireUser, schema: { tags: ["domotique"], response: anyOk } },
    async (request) => ok(await home().listRooms(currentUser(request).userId), request.id),
  );

  app.post(
    "/domotique/rooms",
    {
      preHandler: app.requireUser,
      schema: { tags: ["domotique"], body: roomBody, response: anyOk },
    },
    async (request) =>
      ok(await home().createRoom(currentUser(request).userId, request.body.name), request.id),
  );

  app.patch(
    "/domotique/rooms/:id",
    {
      preHandler: app.requireUser,
      schema: { tags: ["domotique"], params: idParams, body: roomPatch, response: anyOk },
    },
    async (request) =>
      ok(
        await home().updateRoom(currentUser(request).userId, request.params.id, request.body),
        request.id,
      ),
  );

  app.delete(
    "/domotique/rooms/:id",
    {
      preHandler: app.requireUser,
      schema: { tags: ["domotique"], params: idParams, response: anyOk },
    },
    async (request) => {
      await home().deleteRoom(currentUser(request).userId, request.params.id);
      return ok({ deleted: true }, request.id);
    },
  );

  // ── Scenes ─────────────────────────────────────────────────────────────

  app.get(
    "/domotique/scenes",
    { preHandler: app.requireUser, schema: { tags: ["domotique"], response: anyOk } },
    async (request) => ok(await home().listScenes(currentUser(request).userId), request.id),
  );

  app.post(
    "/domotique/scenes",
    {
      preHandler: app.requireUser,
      schema: { tags: ["domotique"], body: sceneInputSchema, response: anyOk },
    },
    async (request) =>
      ok(await home().saveScene(currentUser(request).userId, request.body), request.id),
  );

  app.patch(
    "/domotique/scenes/:id",
    {
      preHandler: app.requireUser,
      schema: { tags: ["domotique"], params: idParams, body: sceneInputSchema, response: anyOk },
    },
    async (request) =>
      ok(
        await home().saveScene(currentUser(request).userId, request.body, request.params.id),
        request.id,
      ),
  );

  app.delete(
    "/domotique/scenes/:id",
    {
      preHandler: app.requireUser,
      schema: { tags: ["domotique"], params: idParams, response: anyOk },
    },
    async (request) => {
      await home().deleteScene(currentUser(request).userId, request.params.id);
      return ok({ deleted: true }, request.id);
    },
  );

  app.post(
    "/domotique/scenes/:id/run",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["domotique"],
        params: idParams,
        response: { 200: okSchema(z.unknown()), 202: okSchema(z.unknown()) },
      },
    },
    async (request, reply) => {
      const result = await home().runScene({
        ownerId: currentUser(request).userId,
        sceneId: request.params.id,
        origin: "user",
        confirmed: false,
      });
      if (result.status === "pending_confirmation") reply.code(202);
      return ok(result, request.id);
    },
  );

  // ── Routines ───────────────────────────────────────────────────────────

  app.get(
    "/domotique/routines",
    { preHandler: app.requireUser, schema: { tags: ["domotique"], response: anyOk } },
    async (request) => ok(await home().listRoutines(currentUser(request).userId), request.id),
  );

  app.post(
    "/domotique/routines",
    {
      preHandler: app.requireUser,
      schema: { tags: ["domotique"], body: routineInputSchema, response: anyOk },
    },
    async (request) =>
      ok(await home().saveRoutine(currentUser(request).userId, request.body), request.id),
  );

  app.patch(
    "/domotique/routines/:id",
    {
      preHandler: app.requireUser,
      schema: { tags: ["domotique"], params: idParams, body: routineInputSchema, response: anyOk },
    },
    async (request) =>
      ok(
        await home().saveRoutine(currentUser(request).userId, request.body, request.params.id),
        request.id,
      ),
  );

  app.delete(
    "/domotique/routines/:id",
    {
      preHandler: app.requireUser,
      schema: { tags: ["domotique"], params: idParams, response: anyOk },
    },
    async (request) => {
      await home().deleteRoutine(currentUser(request).userId, request.params.id);
      return ok({ deleted: true }, request.id);
    },
  );

  app.post(
    "/domotique/routines/:id/run",
    {
      preHandler: app.requireUser,
      schema: { tags: ["domotique"], params: idParams, response: anyOk },
    },
    async (request) =>
      ok(
        await home().runRoutine(currentUser(request).userId, request.params.id, "manual"),
        request.id,
      ),
  );

  app.get(
    "/domotique/logs",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["domotique"],
        summary: "Execution log of actions, scenes and routines",
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
        response: anyOk,
      },
    },
    async (request) =>
      ok(await home().listLogs(currentUser(request).userId, request.query.limit), request.id),
  );

  // ── Voice satellites ───────────────────────────────────────────────────

  app.get(
    "/domotique/voice",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["domotique"],
        summary: "Voice pipeline engines and per-satellite voice links",
        response: anyOk,
      },
    },
    (request) => {
      const { userId } = currentUser(request);
      const gateway = app.services.satelliteVoice;
      const heartbeats = app.satellites
        .list()
        .filter((s) => app.satellites.isOwnedBy(s.deviceId, userId));
      const ids = new Set([
        ...heartbeats.map((s) => s.deviceId),
        ...gateway.connectedIds().filter((id) => app.satellites.isOwnedBy(id, userId)),
      ]);
      const satellites = [...ids].sort().map((id) => {
        const heartbeat = heartbeats.find((s) => s.deviceId === id);
        const details = gateway.details(id);
        return {
          name: heartbeat?.name ?? id,
          online: heartbeat?.online === true || details.connected,
          ...details,
        };
      });
      return ok(
        {
          engines: { stt: gateway.sttConfigured, tts: gateway.ttsConfigured },
          protocol: { path: "/ws/satellite", version: 1, mic: "pcm_s16le 16000 Hz mono" },
          satellites,
        },
        request.id,
      );
    },
  );

  done();
};
