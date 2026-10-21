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
 * Appareils, sessions d'appareil, capacités.
 *
 * Toutes ces routes exigent un **utilisateur**, jamais un appareil. Un appareil
 * ne s'enregistre pas lui-même, ne s'approuve pas lui-même, et ne se donne pas
 * de permissions : il demande un challenge et exécute ce qu'on lui confie.
 *
 * Le seul point d'entrée où un appareil parle est le canal WebSocket worker, et
 * il n'y fait que ce que le protocole permet.
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
  /** Version annoncée par l'exécutant, et ce qu'il faut en penser. */
  agentVersion: z.string().nullable(),
  update: z.object({
    status: z.enum(["a-jour", "en-retard", "en-avance", "inconnu"]),
    expected: z.string().nullable(),
    /** Le geste à faire, ou `null`. Il est toujours **local**. */
    action: z.string().nullable(),
  }),
});

/** Ce qu'un appareil expose au client. Le secret d'appairage n'y figure pas. */
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
    // L'avis est calculé par le cœur, qui est le seul à connaître la version
    // attendue. Le worker, lui, ne reçoit aucune instruction : il n'y a pas de
    // canal pour lui en donner.
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
        summary: "Appareils de l'utilisateur",
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
        summary: "Enregistre un appareil — il arrive hors ligne et non approuvé",
        body: z
          .object({
            name: z.string().min(1).max(120),
            type: z.enum(["IPHONE", "ANDROID", "WINDOWS_PC", "MAC", "LINUX", "BROWSER_WORKER"]),
            platform: z.enum(["WINDOWS", "MACOS", "LINUX", "IOS", "ANDROID", "WEB"]),
            role: z.enum(["CLIENT", "WORKER", "BOTH"]),
            /**
             * Clé publique de l'appareil. Ed25519 en PEM, ou ECDSA P-256 sur Android.
             *
             * Facultative **dans la forme seulement** : le raffinement ci-dessous
             * la rend obligatoire dès que l'appareil demande à exécuter. Un rôle
             * `WORKER` ou `BOTH` sans clé serait un exécutant dont on ne peut
             * vérifier aucune signature — l'ouvrir reviendrait à supprimer la
             * poignée de main worker.
             */
            publicKeyPem: z.string().min(1).max(4_096).optional(),
            grantedPermissions: z.array(z.string()).max(64).default([]),
          })
          /**
           * Un exécutant signe ; un client ne signe pas.
           *
           * L'iPhone est un `CLIENT` pur : il s'authentifie par JWT, et le cœur
           * vérifie déjà que l'appareil appartient au porteur du jeton. Lui
           * réclamer une clé matérielle n'ajouterait aucune garantie et
           * l'empêchait simplement de s'enregistrer.
           *
           * `WORKER` et `BOTH`, eux, reçoivent des commandes et ouvrent le canal
           * `/ws/worker` en signant un challenge. Sans clé publique enregistrée,
           * ce challenge est invérifiable : l'exigence reste entière, et elle est
           * posée ici plutôt que dans le code métier pour qu'aucun appelant ne
           * puisse l'oublier.
           */
          .refine((body) => body.role === "CLIENT" || body.publicKeyPem !== undefined, {
            path: ["publicKeyPem"],
            message:
              "Une clé publique est obligatoire pour un appareil exécutant (WORKER ou BOTH).",
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

      // La clé publique est enregistrée séparément : elle a un cycle de vie
      // propre — rotation, révocation — distinct de celui de l'appareil.
      // Les CLIENT purs (iPhone) n'en envoient pas : ils s'authentifient par JWT.
      if (request.body.publicKeyPem !== undefined) {
        await app.services.deviceCredentials.set(device.id, request.body.publicKeyPem);
      }

      app.services.securityLog.record({
        kind: "device.registered",
        userId,
        summary: `Appareil « ${device.name} » enregistré (${device.role}, non approuvé)`,
        context: { deviceId: device.id, type: device.type, platform: device.platform },
      });

      return reply
        .code(201)
        .send(ok(present(device, app.services.expectedWorkerVersion), request.id));
    },
  );

  // ── Appairage par QR ─────────────────────────────────────────────────────
  //
  // Deux routes, et leur asymétrie *est* le dispositif. La première exige un
  // utilisateur authentifié : c'est elle qui fabrique la preuve. La seconde
  // n'exige rien d'autre que le ticket, parce que l'appareil qui scanne ne
  // possède encore aucune identité — c'est précisément ce qu'il vient
  // chercher.
  app.post(
    "/devices/pairing-tickets",
    {
      preHandler: app.requireUser,
      // Un ticket par émission, et pas d'inondation : chaque ticket est une
      // fenêtre de cinq minutes, et en ouvrir cent en ouvrirait cent.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["devices"],
        summary: "Émet un ticket d'appairage à usage unique, à afficher en QR",
        body: z.object({ label: z.string().min(1).max(120).optional() }),
        response: {
          201: okSchema(
            z.object({
              id: z.string(),
              /**
               * Le code en clair, rendu **une seule fois**.
               *
               * Nommé `token` jusque dans la réponse : la rédaction de
               * `@nexus/shared` masque par nom de clé, et `token` en fait
               * partie. Un champ nommé `code` traverserait les journaux en
               * clair le jour où quelqu'un journalise un corps de réponse.
               */
              token: z.string(),
              /** Charge utile prête à encoder en QR. */
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
        // Refuser plutôt que deviner : un QR qui porte la mauvaise adresse
        // échoue sur le téléphone, loin de sa cause.
        throw new Error(
          "L'appairage par QR exige PUBLIC_API_URL : l'adresse que vos appareils peuvent joindre.",
        );
      }
      const { ticket, code } = await app.services.pairing.issue({
        userId,
        ...(request.body.label === undefined ? {} : { label: request.body.label }),
      });

      app.services.securityLog.record({
        kind: "device.pairing_ticket_issued",
        userId,
        summary: "Ticket d'appairage émis (valable 5 minutes, usage unique)",
        // Jamais le code, ni son empreinte : l'identifiant suffit à relier
        // cette ligne à l'appairage qui suivra.
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
        summary: "Tickets d'appairage récents — sans leur code, qui n'est plus lisible",
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
      // Pas de `preHandler` : l'appareil n'a pas encore d'identité. Le ticket
      // est son unique titre, et il est à usage unique — mais un code reste un
      // code, donc la limite de débit est ici une mesure de sécurité et non de
      // confort : elle est ce qui rend le tâtonnement inutile.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["devices"],
        summary: "Appaire un appareil avec un ticket — il arrive non approuvé",
        body: z
          .object({
            token: z.string().min(16).max(256),
            name: z.string().min(1).max(120),
            type: z.enum(["IPHONE", "ANDROID", "WINDOWS_PC", "MAC", "LINUX", "BROWSER_WORKER"]),
            platform: z.enum(["WINDOWS", "MACOS", "LINUX", "IOS", "ANDROID", "WEB"]),
            role: z.enum(["CLIENT", "WORKER", "BOTH"]),
            publicKeyPem: z.string().min(1).max(4_096).optional(),
          })
          // Le même raffinement que l'enregistrement manuel, et pour la même
          // raison : un exécutant sans clé publique serait un exécutant dont
          // aucune signature n'est vérifiable. Le ticket change le transport,
          // pas les règles.
          .refine(
            (body) => body.role === "CLIENT" || body.publicKeyPem !== undefined,
            "Un appareil WORKER ou BOTH doit fournir sa clé publique.",
          ),
        response: { 201: okSchema(deviceSchema) },
      },
    },
    async (request, reply) => {
      const ticket = await app.services.pairing.redeem(request.body.token);

      // Le propriétaire vient du ticket, jamais du corps de la requête : c'est
      // ce qui interdit au porteur d'un code de rattacher l'appareil à
      // quelqu'un d'autre.
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
        summary: `Appareil « ${device.name} » appairé par QR (${device.role}, non approuvé)`,
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

      if (device === undefined) throw new NotFoundError("Appareil", request.params.deviceId);
      assertOwnedBy(device.userId, userId, "Appareil");

      return ok(present(device, app.services.expectedWorkerVersion), request.id);
    },
  );

  app.post(
    "/devices/:deviceId/trust",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["devices"],
        summary: "Approuve un appareil — il devient sélectionnable",
        params: z.object({ deviceId: z.string().min(1) }),
        response: { 200: okSchema(deviceSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const device = await app.services.deviceRegistry.requireDevice(request.params.deviceId);
      assertOwnedBy(device.userId, userId, "Appareil");

      const trusted = await app.services.deviceRegistry.trustDevice(device.id);
      app.services.securityLog.record({
        kind: "device.trusted",
        userId,
        summary: `Appareil « ${trusted.name} » approuvé`,
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
        summary: "Révoque un appareil — définitif, et ses sessions sont fermées",
        params: z.object({ deviceId: z.string().min(1) }),
        response: { 200: okSchema(deviceSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const device = await app.services.deviceRegistry.requireDevice(request.params.deviceId);
      assertOwnedBy(device.userId, userId, "Appareil");

      const revoked = await app.services.deviceRegistry.revokeDevice(device.id);
      app.services.securityLog.record({
        kind: "device.revoked",
        userId,
        summary: `Appareil « ${revoked.name} » révoqué`,
        context: { deviceId: revoked.id },
      });
      // Une révocation qui laisserait les sessions ouvertes ne révoquerait rien
      // avant leur expiration.
      await app.services.deviceSessions.revokeAllForDevice(device.id);
      await app.services.gateway.detach(device.id, "appareil révoqué");
      // Et la clé part avec. Ce n'est pas la barrière principale — la confiance
      // révoquée suffit — mais c'est celle qui reste si un futur chemin oublie
      // de la vérifier : sans clé, la poignée de main est invérifiable, donc
      // impossible, quelle que soit la règle qu'on aurait oubliée.
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
        summary: "Modifie les permissions accordées à cet appareil",
        params: z.object({ deviceId: z.string().min(1) }),
        body: z.object({ grantedPermissions: z.array(z.string()).max(64) }),
        response: { 200: okSchema(deviceSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const device = await app.services.deviceRegistry.requireDevice(request.params.deviceId);
      assertOwnedBy(device.userId, userId, "Appareil");

      const updated = await app.services.deviceRegistry.updateDevice(device.id, {
        grantedPermissions: request.body.grantedPermissions,
      });
      return ok(present(updated, app.services.expectedWorkerVersion), request.id);
    },
  );

  // ── Sessions d'appareil ───────────────────────────────────────────────────

  app.post(
    "/devices/:deviceId/challenge",
    {
      // Pas de garde : c'est le point d'entrée d'un appareil qui n'a pas encore
      // de session. Il n'accorde rien — un challenge est un nonce public, et le
      // service refuse d'en émettre pour un appareil révoqué.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["device-sessions"],
        summary: "Émet un challenge à signer",
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
        summary: "Ouvre une session d'appareil sur un challenge signé",
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
        throw new NotFoundError("Clé d'appareil", request.params.deviceId);
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
            // Le jeton n'est rendu qu'ici, une fois. Seule son empreinte est
            // conservée côté serveur.
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
        summary: "Ferme toutes les sessions d'un appareil",
        params: z.object({ deviceId: z.string().min(1) }),
        response: { 200: okSchema(z.object({ closed: z.number().int().nonnegative() })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const device = await app.services.deviceRegistry.requireDevice(request.params.deviceId);
      assertOwnedBy(device.userId, userId, "Appareil");

      const closed = await app.services.deviceSessions.revokeAllForDevice(device.id);
      await app.services.gateway.detach(device.id, "sessions fermées");

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
        summary: "Capacités connues du catalogue, et qui les fournit",
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

      // Ce que la flotte sait réellement faire, à cet instant. Distinct du
      // catalogue, qui documente ce qui existe.
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
        summary: "Remplace les capacités déclarées d'un appareil",
        params: z.object({ deviceId: z.string().min(1) }),
        body: z.object({ capabilities: z.array(deviceCapabilitySchema).max(128) }),
        response: { 200: okSchema(z.object({ capabilities: z.array(z.string()) })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const device = await app.services.deviceRegistry.requireDevice(request.params.deviceId);
      assertOwnedBy(device.userId, userId, "Appareil");

      const updated = await app.services.deviceRegistry.updateCapabilities(
        device.id,
        request.body.capabilities,
      );

      return ok({ capabilities: updated.capabilities.map((c) => c.name) }, request.id);
    },
  );
  done();
};
