import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";
import { NotFoundError } from "../../services/stores.js";
import { BrowserWorkerClient } from "@nexus/browser-client";
import { mcpServerConfigSchema, type McpServerConfig } from "@nexus/mcp";

const secretNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const vaultReferenceSchema = z.string().regex(/^vault:\/\/nexus\/[a-z][a-z0-9_-]{0,63}$/);
const browserConfigurationSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().url(),
  tokenRef: vaultReferenceSchema,
});

/**
 * Le tableau de bord de supervision.
 *
 * **Douze sections, une seule garde.** Chaque route porte `requireAdmin` : il
 * n'existe pas de sous-ensemble « moins sensible » qu'on ouvrirait à un client
 * ordinaire. Une vue partielle du système est encore une vue du système, et
 * découper la garde par section reviendrait à créer douze occasions de se
 * tromper au lieu d'une.
 *
 * Les lectures restent séparées des mutations. Les réglages MCP, Browser Use et
 * coffre local vivent ici car ils n'ont pas d'autre surface métier ; les autres
 * actions (appareils, tâches, mémoire) continuent de passer par leurs routes
 * dédiées. Chaque mutation exige la garde administrateur.
 *
 * **Le raisonnement du modèle ne sort pas.** La section « runs d'agent » passe
 * par `projectAgentRun`, qui ne lit que l'enregistrement d'observabilité — pas
 * le transcript, pas les blocs opaques du fournisseur. La garantie tient à la
 * forme de la projection, pas à un filtre qu'on pourrait oublier.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Schémas de réponse
// ─────────────────────────────────────────────────────────────────────────────

const healthSchema = z.object({
  name: z.string(),
  level: z.enum(["ok", "degraded", "down", "unconfigured"]),
  detail: z.string(),
});

const deviceViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  type: z.string(),
  platform: z.string(),
  status: z.string(),
  trust: z.string(),
  authenticated: z.boolean(),
  capabilities: z.array(
    z.object({
      name: z.string(),
      enabled: z.boolean(),
      version: z.string(),
      description: z.string(),
    }),
  ),
  grantedPermissions: z.array(z.string()),
  lastHeartbeatAt: z.string().nullable(),
  health: z.object({
    activeTasks: z.number(),
    maxConcurrentTasks: z.number(),
    cpuLoad: z.number().nullable(),
    memoryFreeMb: z.number().nullable(),
    diskFreeMb: z.number().nullable(),
    batteryPercent: z.number().nullable(),
    onBattery: z.boolean().nullable(),
    latencyMs: z.number().nullable(),
    reportedAt: z.string().nullable(),
  }),
  pairedAt: z.string(),
  revokedAt: z.string().nullable(),
  agentVersion: z.string().nullable(),
});

const workerViewSchema = deviceViewSchema.extend({
  connected: z.boolean(),
  acceptingTasks: z.boolean(),
});

const taskStepSchema = z.object({
  id: z.string(),
  description: z.string(),
  tool: z.string(),
  requiredCapabilities: z.array(z.string()),
  status: z.string(),
  selectedDeviceId: z.string().nullable(),
  selectedDeviceName: z.string().nullable(),
  riskLevel: z.string(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

const taskViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  originClientDeviceId: z.string(),
  correlationId: z.string(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  progressPercent: z.number(),
  steps: z.array(taskStepSchema),
});

const taskDetailSchema = taskViewSchema.extend({
  executions: z.array(
    z.object({
      id: z.string(),
      stepId: z.string(),
      deviceId: z.string(),
      deviceName: z.string().nullable(),
      status: z.string(),
      startedAt: z.string(),
      completedAt: z.string().nullable(),
      durationMs: z.number().nullable(),
      result: z.unknown(),
      error: z.object({ code: z.string(), message: z.string() }).nullable(),
    }),
  ),
});

/**
 * Un run, tel qu'il sort.
 *
 * À lire comme un contrat de non-divulgation : il n'y a pas de champ
 * `messages`, pas de `providerBlocks`, pas de transcript. Ce qui figure ici est
 * exactement ce qui a été demandé — statut, action, outil, progression,
 * résultat, erreur, métriques — et le schéma de sérialisation Zod garantit que
 * rien d'autre ne franchit la frontière, même si la projection changeait.
 */
const agentRunSchema = z.object({
  runId: z.string(),
  userId: z.string(),
  conversationId: z.string(),
  correlationId: z.string(),
  status: z.string(),
  stopReason: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  iterations: z.number(),
  response: z.string().nullable(),
  tools: z.array(
    z.object({
      callId: z.string(),
      tool: z.string(),
      riskLevel: z.string(),
      status: z.string(),
      durationMs: z.number(),
      attempts: z.number(),
      action: z.string(),
      errorCode: z.string().nullable(),
    }),
  ),
  errors: z.array(
    z.object({
      at: z.string(),
      code: z.string(),
      message: z.string(),
      iteration: z.number(),
    }),
  ),
  metrics: z.object({
    model: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
    toolCalls: z.number(),
    failedToolCalls: z.number(),
  }),
});

// ─────────────────────────────────────────────────────────────────────────────

export const dashboardRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ── 1. Vue d'ensemble ─────────────────────────────────────────────────

  app.get(
    "/dashboard/overview",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Vue d'ensemble du système",
        response: {
          200: okSchema(
            z.object({
              at: z.string(),
              devices: z.object({
                total: z.number(),
                online: z.number(),
                degraded: z.number(),
                revoked: z.number(),
              }),
              workers: z.object({
                total: z.number(),
                connected: z.number(),
                accepting: z.number(),
                busy: z.number(),
              }),
              tasks: z.object({
                total: z.number(),
                running: z.number(),
                succeeded: z.number(),
                failed: z.number(),
                cancelled: z.number(),
              }),
              agentRuns: z.object({
                total: z.number(),
                running: z.number(),
                failed: z.number(),
                waitingForConfirmation: z.number(),
              }),
              notifications: z.object({ unread: z.number() }),
              security: z.object({
                eventsRetained: z.number(),
                byKind: z.record(z.string(), z.number()),
              }),
              health: z.array(healthSchema),
              recentActivity: z.array(
                z.object({
                  at: z.string(),
                  kind: z.enum(["task", "run", "security", "log"]),
                  summary: z.string(),
                  level: z.enum(["info", "warning", "error"]),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok(await app.services.dashboard.overview(userId), request.id);
    },
  );

  // ── 2. Appareils ──────────────────────────────────────────────────────

  app.get(
    "/dashboard/devices",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Appareils, avec santé, confiance et permissions",
        response: { 200: okSchema(z.object({ devices: z.array(deviceViewSchema) })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok({ devices: await app.services.dashboard.listDevices(userId) }, request.id);
    },
  );

  app.get(
    "/dashboard/devices/:deviceId",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        params: z.object({ deviceId: z.string().min(1) }),
        response: { 200: okSchema(deviceViewSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const device = await app.services.dashboard.getDevice(userId, request.params.deviceId);

      if (device === undefined) throw new NotFoundError("Appareil", request.params.deviceId);
      return ok(device, request.id);
    },
  );

  // ── 3. Exécutants ─────────────────────────────────────────────────────

  app.get(
    "/dashboard/workers",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Exécutants, et l'état réel de leur canal",
        response: { 200: okSchema(z.object({ workers: z.array(workerViewSchema) })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok({ workers: await app.services.dashboard.listWorkers(userId) }, request.id);
    },
  );

  // ── 4. Tâches ─────────────────────────────────────────────────────────

  app.get(
    "/dashboard/tasks",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: okSchema(z.object({ tasks: z.array(taskViewSchema) })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const tasks = await app.services.dashboard.listTasks(userId, request.query.limit);
      return ok({ tasks }, request.id);
    },
  );

  app.get(
    "/dashboard/tasks/:taskId",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Plan, étapes, exécutants retenus, journal d'exécution",
        params: z.object({ taskId: z.string().min(1) }),
        response: { 200: okSchema(taskDetailSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const task = await app.services.dashboard.getTask(userId, request.params.taskId);

      if (task === undefined) throw new NotFoundError("Tâche", request.params.taskId);
      return ok(task, request.id);
    },
  );

  // ── 5. Runs d'agent ───────────────────────────────────────────────────

  app.get(
    "/dashboard/runs",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Runs d'agent — statut, outils, métriques. Jamais le raisonnement.",
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: okSchema(z.object({ runs: z.array(agentRunSchema) })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const runs = await app.services.dashboard.listAgentRuns(userId, request.query.limit);
      return ok({ runs }, request.id);
    },
  );

  app.get(
    "/dashboard/runs/:runId",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        params: z.object({ runId: z.string().min(1) }),
        response: { 200: okSchema(agentRunSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const run = await app.services.dashboard.getAgentRun(userId, request.params.runId);

      if (run === undefined) throw new NotFoundError("Run", request.params.runId);
      return ok(run, request.id);
    },
  );

  // ── 6. Outils ─────────────────────────────────────────────────────────

  app.get(
    "/dashboard/tools",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Catalogue d'outils, et lesquels sont autorisés",
        response: {
          200: okSchema(
            z.object({
              tools: z.array(
                z.object({
                  name: z.string(),
                  description: z.string(),
                  version: z.string(),
                  riskLevel: z.string(),
                  requiredPermissions: z.array(z.string()),
                  allowed: z.boolean(),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok({ tools: await app.services.dashboard.listTools(userId) }, request.id);
    },
  );

  // ── 7. MCP ────────────────────────────────────────────────────────────

  app.get(
    "/dashboard/mcp",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Serveurs MCP et leur santé",
        response: {
          200: okSchema(
            z.object({
              configured: z.boolean(),
              configurations: z.array(z.unknown()),
              servers: z.array(
                z.object({
                  name: z.string(),
                  status: z.string(),
                  toolCount: z.number(),
                  lastError: z.string().nullable(),
                  consecutiveFailures: z.number(),
                  reconnectAttempts: z.number(),
                  circuitOpenUntil: z.string().nullable(),
                  serverInfo: z.object({ name: z.string(), version: z.string() }).nullable(),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => {
      const manager = app.services.mcp;
      const configurations = ((await app.services.runtimeConfiguration?.loadMcp()) ?? []).map(
        withoutInlineSecretValues,
      );

      // Non configuré n'est pas en panne. Le dire évite d'envoyer chercher un
      // incident qui n'existe pas.
      if (manager === undefined) {
        return ok({ configured: false, configurations, servers: [] }, request.id);
      }

      return ok(
        {
          configured: true,
          configurations,
          servers: manager.health().map((server) => ({
            name: server.name,
            status: server.status,
            toolCount: server.toolCount,
            lastError: server.lastError ?? null,
            consecutiveFailures: server.consecutiveFailures,
            reconnectAttempts: server.reconnectAttempts,
            circuitOpenUntil:
              server.circuitOpenUntil === undefined
                ? null
                : new Date(server.circuitOpenUntil).toISOString(),
            serverInfo: server.serverInfo ?? null,
          })),
        },
        request.id,
      );
    },
  );

  app.put(
    "/dashboard/mcp/servers/:name",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        params: z.object({ name: z.string().min(1).max(40) }),
        body: mcpServerConfigSchema,
        response: { 200: okSchema(z.object({ health: z.unknown() })) },
      },
    },
    async (request) => {
      const store = app.services.runtimeConfiguration;
      const manager = app.services.mcp;
      if (store === undefined || manager === undefined) throw new Error("MCP non administrable.");
      if (request.params.name !== request.body.name) throw new Error("Nom MCP incohérent.");

      const config = withoutInlineSecrets(request.body);
      const current = await store.loadMcp();
      const next = [...current.filter((item) => item.name !== config.name), config];
      await store.saveMcp(next);
      const health = await manager.addServer(config);
      return ok({ health }, request.id);
    },
  );

  app.delete(
    "/dashboard/mcp/servers/:name",
    {
      preHandler: app.requireAdmin,
      schema: { tags: ["dashboard"], params: z.object({ name: z.string().min(1).max(40) }) },
    },
    async (request) => {
      const store = app.services.runtimeConfiguration;
      const manager = app.services.mcp;
      if (store === undefined || manager === undefined) throw new Error("MCP non administrable.");
      await manager.removeServer(request.params.name);
      await store.saveMcp(
        (await store.loadMcp()).filter((item) => item.name !== request.params.name),
      );
      return ok({ removed: true }, request.id);
    },
  );

  app.post(
    "/dashboard/mcp/servers/:name/reconnect",
    {
      preHandler: app.requireAdmin,
      schema: { tags: ["dashboard"], params: z.object({ name: z.string().min(1).max(40) }) },
    },
    async (request) => {
      const health = await app.services.mcp?.reconnect(request.params.name);
      if (health === undefined) throw new NotFoundError("Serveur MCP", request.params.name);
      return ok({ health }, request.id);
    },
  );

  // ── 8. Browser Use ────────────────────────────────────────────────────

  app.get(
    "/dashboard/browser",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Santé du worker navigateur",
        response: {
          200: okSchema(
            z.object({
              configured: z.boolean(),
              reachable: z.boolean(),
              detail: z.string(),
              health: z.unknown().nullable(),
              configuration: browserConfigurationSchema.nullable(),
              tokenConfigured: z.boolean(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const browser = app.services.browser;
      const configuration = (await app.services.runtimeConfiguration?.loadBrowser()) ?? null;
      const tokenConfigured =
        configuration === null
          ? false
          : (await app.services.vault?.get(configuration.tokenRef)) !== undefined;
      if (browser === undefined) {
        return ok(
          {
            configured: false,
            reachable: false,
            detail: "worker navigateur non configuré",
            health: null,
            configuration,
            tokenConfigured,
          },
          request.id,
        );
      }

      try {
        const health = await browser.health();
        return ok(
          {
            configured: true,
            reachable: true,
            detail: "joignable",
            health,
            configuration,
            tokenConfigured,
          },
          request.id,
        );
      } catch (cause) {
        // Un worker injoignable est une information, pas une erreur de la
        // requête : le tableau de bord doit s'afficher quand même.
        return ok(
          {
            configured: true,
            reachable: false,
            detail: cause instanceof Error ? cause.message : "injoignable",
            health: null,
            configuration,
            tokenConfigured,
          },
          request.id,
        );
      }
    },
  );

  app.put(
    "/dashboard/browser/configuration",
    {
      preHandler: app.requireAdmin,
      schema: { tags: ["dashboard"], body: browserConfigurationSchema },
    },
    async (request) => {
      const store = app.services.runtimeConfiguration;
      const vault = app.services.vault;
      if (store === undefined || vault === undefined)
        throw new Error("Configuration indisponible.");
      const parsed = browserConfigurationSchema.parse(request.body);
      const url = new URL(parsed.baseUrl);
      if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
        throw new Error("HTTP est réservé à la boucle locale.");
      }
      const token = parsed.enabled ? await vault.get(parsed.tokenRef) : undefined;
      if (parsed.enabled && token === undefined)
        throw new Error("Le secret du worker est absent du coffre.");
      await store.saveBrowser(parsed);
      app.services.setBrowser(
        parsed.enabled && token !== undefined
          ? new BrowserWorkerClient({ baseUrl: parsed.baseUrl, token })
          : undefined,
      );
      return ok({ saved: true }, request.id);
    },
  );

  app.post(
    "/dashboard/browser/test",
    { preHandler: app.requireAdmin, schema: { tags: ["dashboard"] } },
    async (request) => {
      const browser = app.services.browser;
      if (browser === undefined) throw new Error("Worker navigateur non configuré.");
      return ok({ health: await browser.health() }, request.id);
    },
  );

  app.get(
    "/dashboard/secrets",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        response: { 200: okSchema(z.object({ names: z.array(z.string()) })) },
      },
    },
    async (request) => ok({ names: (await app.services.vault?.list()) ?? [] }, request.id),
  );

  app.put(
    "/dashboard/secrets/:name",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        params: z.object({ name: secretNameSchema }),
        body: z.object({ secret: z.string().min(4).max(16_384) }),
      },
    },
    async (request) => {
      if (app.services.vault === undefined) throw new Error("Coffre local indisponible.");
      await app.services.vault.set(request.params.name, request.body.secret);
      return ok({ name: request.params.name, configured: true }, request.id);
    },
  );

  app.delete(
    "/dashboard/secrets/:name",
    {
      preHandler: app.requireAdmin,
      schema: { tags: ["dashboard"], params: z.object({ name: secretNameSchema }) },
    },
    async (request) => {
      if (app.services.vault === undefined) throw new Error("Coffre local indisponible.");
      await app.services.vault.delete(request.params.name);
      return ok({ removed: true }, request.id);
    },
  );

  // ── 9. Mémoire ────────────────────────────────────────────────────────

  app.get(
    "/dashboard/memory",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Statistiques de mémoire par couche, origine et sensibilité",
        response: {
          200: okSchema(
            z.object({
              total: z.number(),
              byLayer: z.record(z.string(), z.number()),
              byOrigin: z.record(z.string(), z.number()),
              bySensitivity: z.record(z.string(), z.number()),
              recent: z.array(
                z.object({
                  id: z.string(),
                  content: z.string(),
                  layer: z.string(),
                  origin: z.string(),
                  createdAt: z.string(),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok(await app.services.dashboard.memoryStats(userId), request.id);
    },
  );

  // ── 10. Notifications ─────────────────────────────────────────────────

  app.get(
    "/dashboard/notifications",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: {
          200: okSchema(
            z.object({
              unread: z.number(),
              notifications: z.array(
                z.object({
                  id: z.string(),
                  title: z.string(),
                  body: z.string(),
                  severity: z.string(),
                  readAt: z.string().nullable(),
                  createdAt: z.string(),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const page = await app.services.notificationStore.listByUser(userId, {
        limit: request.query.limit,
      });
      const unread = await app.services.notificationStore.listByUser(
        userId,
        { limit: 1 },
        { unreadOnly: true },
      );

      return ok(
        {
          unread: unread.total,
          notifications: page.items.map((notification) => ({
            id: notification.id,
            title: notification.title,
            body: notification.body,
            severity: notification.severity,
            readAt: notification.readAt === null ? null : notification.readAt.toISOString(),
            createdAt: notification.createdAt.toISOString(),
          })),
        },
        request.id,
      );
    },
  );

  // ── 11. Sécurité ──────────────────────────────────────────────────────

  app.get(
    "/dashboard/security",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Événements de sécurité, confiance des appareils, sessions",
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }),
        response: {
          200: okSchema(
            z.object({
              events: z.array(
                z.object({
                  at: z.string(),
                  kind: z.string(),
                  userId: z.string().nullable(),
                  summary: z.string(),
                  context: z.record(z.string(), z.unknown()),
                }),
              ),
              byKind: z.record(z.string(), z.number()),
              trust: z.object({
                trusted: z.number(),
                pending: z.number(),
                revoked: z.number(),
              }),
              permissions: z.array(z.string()),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const devices = await app.services.deviceRegistry.listDevices(userId);

      return ok(
        {
          events: app.services.securityLog.list({ limit: request.query.limit }),
          byKind: app.services.securityLog.countByKind(),
          trust: {
            trusted: devices.filter((device) => device.trust === "TRUSTED").length,
            pending: devices.filter((device) => device.trust === "PENDING").length,
            revoked: devices.filter((device) => device.trust === "REVOKED").length,
          },
          permissions: await app.services.permissionsFor(userId),
        },
        request.id,
      );
    },
  );

  // ── 12. Journaux ──────────────────────────────────────────────────────

  app.get(
    "/dashboard/logs",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Dernières lignes de journal retenues",
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(500).default(100),
          level: z.enum(["debug", "info", "warn", "error", "fatal"]).optional(),
          search: z.string().max(200).optional(),
        }),
        response: {
          200: okSchema(
            z.object({
              retained: z.number(),
              entries: z.array(
                z.object({
                  at: z.string(),
                  level: z.string(),
                  message: z.string(),
                  correlationId: z.string().nullable(),
                  context: z.record(z.string(), z.unknown()),
                }),
              ),
            }),
          ),
        },
      },
    },
    (request) => {
      const entries = app.services.logs.list({
        limit: request.query.limit,
        ...(request.query.level === undefined ? {} : { level: request.query.level }),
        ...(request.query.search === undefined ? {} : { search: request.query.search }),
      });

      return ok({ retained: app.services.logs.size, entries }, request.id);
    },
  );

  done();
};

/** Les secrets sont exclusivement des références de trousseau, jamais du JSON persistant. */
function withoutInlineSecrets(config: McpServerConfig): McpServerConfig {
  if (config.transport === "stdio") {
    if (Object.keys(config.env).length > 0) {
      throw new Error("Utilisez envRefs et le coffre NEXUS pour les variables sensibles.");
    }
    for (const reference of Object.values(config.envRefs)) vaultReferenceSchema.parse(reference);
    return { ...config, env: {} };
  }

  if (Object.keys(config.headers).length > 0) {
    throw new Error("Utilisez headerRefs et le coffre NEXUS pour les en-têtes sensibles.");
  }
  for (const reference of Object.values(config.headerRefs)) vaultReferenceSchema.parse(reference);
  return { ...config, headers: {} };
}

function withoutInlineSecretValues(config: McpServerConfig): McpServerConfig {
  return config.transport === "stdio" ? { ...config, env: {} } : { ...config, headers: {} };
}
