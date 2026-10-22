import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CAPABILITIES,
  SUGGESTED_CAPABILITIES,
  deviceCapabilitySchema,
  encodePairingPayload,
  updateAdvice,
} from "@nexus/devices";
import { assertOwnedBy, currentUser } from "../../plugins/authentication.js";
import { ok, okSchema, listSchema, paginationQuerySchema } from "../../lib/response.js";
import { NotFoundError, paginate } from "../../services/stores.js";

/**
 * Devices, device sessions, capabilities.
 *
 * All these routes require a **user**, never a device. A device
 * does not register itself, does not approve itself, and does not grant itself
 * permissions: it requests a challenge and executes what is assigned to it.
 *
 * The only entry point where a device communicates is the worker WebSocket channel,
 * and it only does what the protocol permits.
 */

const deviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  platform: z.string(),
  role: z.string(),
  status: z.string(),
  trust: z.string(),
  capabilities: z.array(z.string()),
  grantedPermissions: z.array(z.string()),
  health: z
    .object({
      activeTasks: z.number(),
      maxConcurrentTasks: z.number(),
      batteryPercent: z.number().optional(),
      onBattery: z.boolean().optional(),
    })
    .passthrough(),
  lastSeenAt: z.string().datetime().nullable(),
  authenticated: z.boolean(),
  /** Version reported by the worker, and its evaluation status. */
  agentVersion: z.string().nullable(),
  update: z.object({
    status: z.enum(["a-jour", "en-retard", "en-avance", "inconnu"]),
    expected: z.string().nullable(),
    /** Action to take, or `null`. It is always **local**. */
    action: z.string().nullable(),
  }),
});

/** What a device exposes to the client. The pairing secret is not included. */
function present(
  device: {
    id: string;
    name: string;
    type: string;
    platform: string;
    role: string;
    status: string;
    trust: string;
    capabilities: { name: string; enabled: boolean }[];
    grantedPermissions: string[];
    health: Record<string, unknown>;
    lastSeenAt: Date | null;
    authenticated: boolean;
    agentVersion: string | null;
  },
  expectedWorkerVersion?: string,
) {
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    platform: device.platform,
    role: device.role,
    status: device.status,
    trust: device.trust,
    capabilities: device.capabilities.filter((c) => c.enabled).map((c) => c.name),
    grantedPermissions: device.grantedPermissions,
    health: device.health as never,
    lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
    agentVersion: device.agentVersion,
    // The evaluation is calculated by core, which is the only component aware of
    // the expected version. The worker itself receives no instructions: there is
    // no channel to send them.
    update: (() => {
      const advice = updateAdvice(device.agentVersion, expectedWorkerVersion);
      return { status: advice.status, expected: advice.expected, action: advice.action };
    })(),
    authenticated: device.authenticated ?? false,
  };
}

export const deviceRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/devices",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["devices"],
        summary: "User devices",
        querystring: paginationQuerySchema.extend({
          role: z.enum(["CLIENT", "WORKER", "BOTH"]).optional(),
        }),
        response: { 200: listSchema(deviceSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const all = await app.services.deviceRegistry.listDevices(userId);
      const filtered =
        request.query.role === undefined
          ? all
          : all.filter((device) => device.role === request.query.role);

      const page = paginate(
        filtered.map((device) => present(device, app.services.expectedWorkerVersion)),
        request.query,
        (device) => device.id,
      );
      return {
        data: page.items,
        meta: { requestId: request.id, nextCursor: page.nextCursor, total: page.total },
      };
    },
  );

  app.post(
    "/devices",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["devices"],
        summary: "Register a device — it arrives offline and unapproved",
        body: z
          .object({
            name: z.string().min(1).max(120),
            type: z.enum(["IPHONE", "ANDROID", "WINDOWS_PC", "MAC", "LINUX", "BROWSER_WORKER"]),
            platform: z.enum(["WINDOWS", "MACOS", "LINUX", "IOS", "ANDROID", "WEB"]),
            role: z.enum(["CLIENT", "WORKER", "BOTH"]),
            /**
             * Device public key. Ed25519 in PEM, or ECDSA P-256 on Android.
             *
             * Optional **in syntax only**: the refinement below
             * makes it mandatory as soon as the device requests execution capability. A
             * `WORKER` or `BOTH` role without a key would be an executor whose
             * signature cannot be verified — allowing this would defeat the
             * worker handshake.
             */
            publicKeyPem: z.string().min(1).max(4_096).optional(),
            grantedPermissions: z.array(z.string()).max(64).default([]),
          })
          /**
           * An executor signs; a client does not sign.
           *
           * iPhone is a pure `CLIENT`: it authenticates via JWT, and core
           * already verifies that the device belongs to the token bearer.
           * Requiring a hardware key would add no guarantees and
           * would simply prevent registration.
           *
           * `WORKER` and `BOTH` receive commands and open the
           * `/ws/worker` channel by signing a challenge. Without a registered
           * public key, this challenge cannot be verified: the requirement remains intact,
           * and it is placed here rather than in domain code so no caller can
           * omit it.
           */
          .refine((body) => body.role === "CLIENT" || body.publicKeyPem !== undefined, {
            path: ["publicKeyPem"],
            message:
              "A public key is required for an executor device (WORKER or BOTH).",
          }),
        response: { 201: okSchema(deviceSchema) },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);

      const device = await app.services.deviceRegistry.registerDevice({
        userId,
        name: request.body.name,
        type: request.body.type,
        platform: request.body.platform,
        role: request.body.role,
        grantedPermissions: request.body.grantedPermissions,
      });

      // The public key is stored separately: it has its own lifecycle
      // — rotation, revocation — distinct from the device itself.
      // Pure CLIENTs (iPhone) do not send one: they authenticate via JWT.
      if (request.body.publicKeyPem !== undefined) {
        await app.services.deviceCredentials.set(device.id, request.body.publicKeyPem);
      }

      app.services.securityLog.record({
        kind: "device.registered",
        userId,
        summary: `Device "${device.name}" registered (${device.role}, not approved)`,
        context: { deviceId: device.id, type: device.type, platform: device.platform },
      });

      return reply
        .code(201)
        .send(ok(present(device, app.services.expectedWorkerVersion), request.id));
    },
  );

  // ── QR Pairing ──────────────────────────────────────────────────────────
  //
  // Two routes, and their asymmetry *is* the security mechanism. The first requires
  // an authenticated user: it generates the proof. The second requires
  // nothing other than the ticket, because the scanning device does not yet
  // have any identity — which is precisely what it comes to obtain.
  app.post(
    "/devices/pairing-tickets",
    {
      preHandler: app.requireUser,
      // One ticket per issuance, no flooding: each ticket is a 5-minute
      // window, and issuing a hundred would open a hundred.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["devices"],
        summary: "Issue a single-use pairing ticket to display as a QR code",
        body: z.object({ label: z.string().min(1).max(120).optional() }),
        response: {
          201: okSchema(
            z.object({
              id: z.string(),
              /**
               * Plaintext code, returned **only once**.
               *
               * Named `token` in the response: the `@nexus/shared` redaction
               * masks by key name, and `token` is included. A field named `code`
               * would leak in plaintext if response bodies were ever logged.
               */
              token: z.string(),
              /** Payload ready to encode into QR. */
              payload: z.string(),
              expiresAt: z.string().datetime(),
            }),
          ),
        },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      const apiUrl = app.services.publicApiUrl;
      if (apiUrl === undefined) {
        // Reject rather than guess: a QR with the wrong address
        // fails on the phone, far from the root cause.
        throw new Error(
          "QR pairing requires PUBLIC_API_URL: the address your devices can reach.",
        );
      }
      const { ticket, code } = await app.services.pairing.issue({
        userId,
        ...(request.body.label === undefined ? {} : { label: request.body.label }),
      });

      app.services.securityLog.record({
        kind: "device.pairing_ticket_issued",
        userId,
        summary: "Pairing ticket issued (valid for 5 minutes, single use)",
        // Never the code, nor its fingerprint: the identifier is enough to link
        // this entry to the subsequent pairing.
        context: { ticketId: ticket.id },
      });

      return reply.code(201).send(
        ok(
          {
            id: ticket.id,
            token: code,
            payload: encodePairingPayload({ apiUrl, token: code }),
            expiresAt: ticket.expiresAt.toISOString(),
          },
          request.id,
        ),
      );
    },
  );

  app.get(
    "/devices/pairing-tickets",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["devices"],
        summary: "Recent pairing tickets — without their code, which is no longer readable",
        response: {
          200: listSchema(
            z.object({
              id: z.string(),
              status: z.enum(["pending", "consumed", "expired"]),
              label: z.string().nullable(),
              deviceId: z.string().nullable(),
              createdAt: z.string().datetime(),
              expiresAt: z.string().datetime(),
              consumedAt: z.string().datetime().nullable(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const tickets = await app.services.pairing.list(userId);
      return {
        data: tickets.map((ticket) => ({
          id: ticket.id,
          status: ticket.status,
          label: ticket.label,
          deviceId: ticket.deviceId,
          createdAt: ticket.createdAt.toISOString(),
          expiresAt: ticket.expiresAt.toISOString(),
          consumedAt: ticket.consumedAt === null ? null : ticket.consumedAt.toISOString(),
        })),
        meta: { requestId: request.id, nextCursor: null, total: tickets.length },
      };
    },
  );

  app.post(
    "/devices/pair",
    {
      // No `preHandler`: the device has no identity yet. The ticket
      // is its sole claim, and it is single-use — but a code is still a code,
      // so rate limiting here is a security measure rather than a convenience:
      // it makes brute-forcing infeasible.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["devices"],
        summary: "Pair a device using a ticket — it arrives unapproved",
        body: z
          .object({
            token: z.string().min(16).max(256),
            name: z.string().min(1).max(120),
            type: z.enum(["IPHONE", "ANDROID", "WINDOWS_PC", "MAC", "LINUX", "BROWSER_WORKER"]),
            platform: z.enum(["WINDOWS", "MACOS", "LINUX", "IOS", "ANDROID", "WEB"]),
            role: z.enum(["CLIENT", "WORKER", "BOTH"]),
            publicKeyPem: z.string().min(1).max(4_096).optional(),
          })
          // The same refinement as manual registration, and for the same
          // reason: an executor without a public key would be an executor whose
          // signature cannot be verified. The ticket changes the transport,
          // not the rules.
          .refine(
            (body) => body.role === "CLIENT" || body.publicKeyPem !== undefined,
            "A WORKER or BOTH device must provide its public key.",
          ),
        response: { 201: okSchema(deviceSchema) },
      },
    },
    async (request, reply) => {
      const ticket = await app.services.pairing.redeem(request.body.token);

      // The owner comes from the ticket, never from the request body:
      // this prevents a bearer of a code from attaching the device
      // to someone else.
      const device = await app.services.deviceRegistry.registerDevice({
        userId: ticket.userId,
        name: request.body.name,
        type: request.body.type,
        platform: request.body.platform,
        role: request.body.role,
      });

      if (request.body.publicKeyPem !== undefined) {
        await app.services.deviceCredentials.set(device.id, request.body.publicKeyPem);
      }

      await app.services.pairing.complete(ticket, device.id);

      app.services.securityLog.record({
        kind: "device.paired",
        userId: ticket.userId,
        summary: `Device "${device.name}" paired via QR (${device.role}, not approved)`,
        context: { deviceId: device.id, ticketId: ticket.id, type: device.type },
      });

      return reply
        .code(201)
        .send(ok(present(device, app.services.expectedWorkerVersion), request.id));
    },
  );

  app.get(
    "/devices/:deviceId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["devices"],
        params: z.object({ deviceId: z.string().min(1) }),
        response: { 200: okSchema(deviceSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const device = await app.services.deviceRegistry.getDevice(request.params.deviceId);

      if (device === undefined) throw new NotFoundError("Device", request.params.deviceId);
      assertOwnedBy(device.userId, userId, "Device");

      return ok(present(device, app.services.expectedWorkerVersion), request.id);
    },
  );

  app.post(
    "/devices/:deviceId/trust",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["devices"],
        summary: "Approve a device — it becomes selectable",
        params: z.object({ deviceId: z.string().min(1) }),
        response: { 200: okSchema(deviceSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const device = await app.services.deviceRegistry.requireDevice(request.params.deviceId);
      assertOwnedBy(device.userId, userId, "Device");

      const trusted = await app.services.deviceRegistry.trustDevice(device.id);
      app.services.securityLog.record({
        kind: "device.trusted",
        userId,
        summary: `Device "${trusted.name}" approved`,
        context: { deviceId: trusted.id },
      });

      return ok(present(trusted, app.services.expectedWorkerVersion), request.id);
    },
  );

  app.post(
    "/devices/:deviceId/revoke",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["devices"],
        summary: "Revoke a device — permanent, and its sessions are closed",
        params: z.object({ deviceId: z.string().min(1) }),
        response: { 200: okSchema(deviceSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const device = await app.services.deviceRegistry.requireDevice(request.params.deviceId);
      assertOwnedBy(device.userId, userId, "Device");

      const revoked = await app.services.deviceRegistry.revokeDevice(device.id);
      app.services.securityLog.record({
        kind: "device.revoked",
        userId,
        summary: `Device "${revoked.name}" revoked`,
        context: { deviceId: revoked.id },
      });
      // A revocation that left sessions open would revoke nothing
      // before their expiration.
      await app.services.deviceSessions.revokeAllForDevice(device.id);
      await app.services.gateway.detach(device.id, "device revoked");
      // And the key goes with it. This is not the primary barrier — revoked
      // trust suffices — but it is the defense-in-depth if a future path forgets
      // to check trust: without a key, the handshake cannot be verified and is
      // therefore impossible, regardless of any overlooked rule.
      await app.services.deviceCredentials.revoke(device.id);

      return ok(present(revoked, app.services.expectedWorkerVersion), request.id);
    },
  );

  app.patch(
    "/devices/:deviceId/permissions",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["devices"],
        summary: "Modify permissions granted to this device",
        params: z.object({ deviceId: z.string().min(1) }),
        body: z.object({ grantedPermissions: z.array(z.string()).max(64) }),
        response: { 200: okSchema(deviceSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const device = await app.services.deviceRegistry.requireDevice(request.params.deviceId);
      assertOwnedBy(device.userId, userId, "Device");

      const updated = await app.services.deviceRegistry.updateDevice(device.id, {
        grantedPermissions: request.body.grantedPermissions,
      });
      return ok(present(updated, app.services.expectedWorkerVersion), request.id);
    },
  );

  // ── Device sessions ───────────────────────────────────────────────────

  app.post(
    "/devices/:deviceId/challenge",
    {
      // No guard: this is the entry point for a device that does not yet
      // have a session. It grants nothing — a challenge is a public nonce, and
      // the service refuses to issue one for a revoked device.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["device-sessions"],
        summary: "Issue a challenge to sign",
        params: z.object({ deviceId: z.string().min(1) }),
        response: {
          200: okSchema(z.object({ nonce: z.string(), expiresAt: z.date() })),
        },
      },
    },
    async (request) => {
      const challenge = await app.services.deviceSessions.createChallenge(request.params.deviceId);
      return ok({ nonce: challenge.nonce, expiresAt: challenge.expiresAt }, request.id);
    },
  );

  app.post(
    "/devices/:deviceId/sessions",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["device-sessions"],
        summary: "Open a device session on a signed challenge",
        params: z.object({ deviceId: z.string().min(1) }),
        body: z.object({
          nonce: z.string().min(1),
          signature: z.string().min(1).max(2_048),
          capabilities: z.array(z.string()).max(64).default([]),
        }),
        response: {
          201: okSchema(
            z.object({
              sessionId: z.string(),
              token: z.string(),
              expiresAt: z.date(),
              capabilities: z.array(z.string()),
            }),
          ),
        },
      },
    },
    async (request, reply) => {
      const publicKey = await app.services.deviceCredentials.publicKeyFor(request.params.deviceId);
      if (publicKey === undefined) {
        throw new NotFoundError("Device key", request.params.deviceId);
      }

      const { session, token } = await app.services.deviceSessions.authenticate(
        {
          deviceId: request.params.deviceId,
          nonce: request.body.nonce,
          signature: request.body.signature,
          capabilities: request.body.capabilities,
        },
        publicKey,
      );

      return reply.code(201).send(
        ok(
          {
            sessionId: session.id,
            // The token is returned only here, once. Only its hash is
            // retained on the server.
            token,
            expiresAt: session.expiresAt,
            capabilities: session.capabilities,
          },
          request.id,
        ),
      );
    },
  );

  app.delete(
    "/devices/:deviceId/sessions",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["device-sessions"],
        summary: "Close all sessions for a device",
        params: z.object({ deviceId: z.string().min(1) }),
        response: { 200: okSchema(z.object({ closed: z.number().int().nonnegative() })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const device = await app.services.deviceRegistry.requireDevice(request.params.deviceId);
      assertOwnedBy(device.userId, userId, "Device");

      const closed = await app.services.deviceSessions.revokeAllForDevice(device.id);
      await app.services.gateway.detach(device.id, "sessions closed");

      return ok({ closed }, request.id);
    },
  );
  done();
};

export const capabilityRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/capabilities",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["capabilities"],
        summary: "Known catalogue capabilities, and who provides them",
        response: {
          200: okSchema(
            z.object({
              catalogue: z.array(z.string()),
              suggested: z.record(z.string(), z.array(z.string())),
              available: z.array(
                z.object({
                  name: z.string(),
                  devices: z.array(z.object({ id: z.string(), name: z.string() })),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const devices = await app.services.deviceRegistry.listDevices(userId);

      // What the fleet can actually perform right now. Distinct from
      // the catalogue, which documents what exists.
      const byCapability = new Map<string, { id: string; name: string }[]>();
      for (const device of devices) {
        for (const capability of device.capabilities) {
          if (!capability.enabled) continue;
          const holders = byCapability.get(capability.name) ?? [];
          holders.push({ id: device.id, name: device.name });
          byCapability.set(capability.name, holders);
        }
      }

      return ok(
        {
          catalogue: Object.values(CAPABILITIES).sort(),
          suggested: SUGGESTED_CAPABILITIES as unknown as Record<string, string[]>,
          available: [...byCapability.entries()]
            .map(([name, holders]) => ({ name, devices: holders }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        },
        request.id,
      );
    },
  );

  app.put(
    "/devices/:deviceId/capabilities",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["capabilities"],
        summary: "Replace declared capabilities for a device",
        params: z.object({ deviceId: z.string().min(1) }),
        body: z.object({ capabilities: z.array(deviceCapabilitySchema).max(128) }),
        response: { 200: okSchema(z.object({ capabilities: z.array(z.string()) })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const device = await app.services.deviceRegistry.requireDevice(request.params.deviceId);
      assertOwnedBy(device.userId, userId, "Device");

      const updated = await app.services.deviceRegistry.updateCapabilities(
        device.id,
        request.body.capabilities,
      );

      return ok({ capabilities: updated.capabilities.map((c) => c.name) }, request.id);
    },
  );
  done();
};
