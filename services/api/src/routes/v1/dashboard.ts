import { z } from "zod";
import type { FastifyPluginCallback } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";
import { ConflictError, NotFoundError } from "../../services/stores.js";
import { DependencyError } from "@nexus/shared";
import { BrowserWorkerClient } from "@nexus/browser-client";
import { mcpServerConfigSchema, type McpServerConfig } from "@nexus/mcp";
import { notificationsConfigSchema } from "@nexus/notifications";
import { BrowserHarnessClient } from "../../services/browser-harness.js";

const secretNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const vaultReferenceSchema = z.string().regex(/^vault:\/\/nexus\/[a-z][a-z0-9_-]{0,63}$/);
const browserConfigurationSchema = z.discriminatedUnion("mode", [
  z.object({
    enabled: z.boolean(),
    mode: z.literal("local-harness"),
    cdpUrl: z.string().url(),
  }),
  z.object({
    enabled: z.boolean(),
    mode: z.literal("remote-worker"),
    baseUrl: z.string().url(),
    tokenRef: vaultReferenceSchema,
  }),
]);

/**
 * Supervision dashboard.
 *
 * **Twelve sections, a single guard.** Every route carries `requireAdmin`:
 * there is no "less sensitive" subset that would be opened to an ordinary client.
 * A partial view of the system is still a view of the system, and
 * slicing the guard per section would create twelve opportunities to make a mistake.
 *
 * Reads remain separate from mutations. MCP settings, Browser Use, and local vault
 * live here because they have no other business domain surface; other actions
 * (devices, tasks, memory) continue through their dedicated routes. Each mutation requires admin guard.
 *
 * **Model reasoning never leaves.** The "agent runs" section goes through
 * `projectAgentRun`, which only reads the observability record — not the transcript,
 * not the provider's opaque blocks. The guarantee is built into the shape of the projection,
 * not a filter that could be forgotten.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Response schemas
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
  source: z.enum(["device", "acp"]),
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
 * An agent run, as exposed.
 *
 * Read as a non-disclosure contract: there is no `messages` field,
 * no `providerBlocks`, no transcript. What appears here is
 * strictly what was requested — status, action, tool, progress,
 * result, error, metrics — and the Zod serialization schema guarantees that
 * nothing else crosses the boundary, even if the projection changed.
 */
const agentRunSchema = z.object({
  runId: z.string(),
  userId: z.string(),
  conversationId: z.string(),
  correlationId: z.string(),
  missionExternalKey: z.string().nullable(),
  replayOfRunId: z.string().nullable(),
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
    fallbackCount: z.number(),
  }),
});

const observabilitySummarySchema = z.object({
  generatedAt: z.string(),
  totals: z.object({
    runs: z.number(),
    failedRuns: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    toolCalls: z.number(),
    failedToolCalls: z.number(),
    estimatedApiEquivalentCostUsd: z.number().nullable(),
  }),
  rates: z.object({ fallback: z.number(), toolError: z.number(), runError: z.number() }),
  agents: z.array(
    z.object({
      agent: z.string(),
      runs: z.number(),
      failures: z.number(),
      averageLatencyMs: z.number(),
      p95LatencyMs: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      estimatedApiEquivalentCostUsd: z.number().nullable(),
    }),
  ),
  missions: z.array(
    z.object({
      mission: z.string(),
      runs: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      estimatedApiEquivalentCostUsd: z.number().nullable(),
    }),
  ),
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
        summary: "System overview",
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

  // ── 2. Devices ────────────────────────────────────────────────────────

  app.get(
    "/dashboard/devices",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Devices, with health, trust, and permissions",
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

      if (device === undefined) throw new NotFoundError("Device", request.params.deviceId);
      return ok(device, request.id);
    },
  );

  // ── 3. Workers ────────────────────────────────────────────────────────

  app.get(
    "/dashboard/workers",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Workers, and real status of their channel",
        response: { 200: okSchema(z.object({ workers: z.array(workerViewSchema) })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      return ok({ workers: await app.services.dashboard.listWorkers(userId) }, request.id);
    },
  );

  // ── 4. Tasks ──────────────────────────────────────────────────────────

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
        summary: "Plan, steps, selected workers, execution log",
        params: z.object({ taskId: z.string().min(1) }),
        response: { 200: okSchema(taskDetailSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const task = await app.services.dashboard.getTask(userId, request.params.taskId);

      if (task === undefined) throw new NotFoundError("Task", request.params.taskId);
      return ok(task, request.id);
    },
  );

  // ── 5. Agent runs ─────────────────────────────────────────────────────

  app.get(
    "/dashboard/runs",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Agent runs — status, tools, metrics. Never reasoning.",
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

  app.get(
    "/dashboard/observability",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Latency aggregates, tokens, equivalent costs, and fallbacks",
        response: { 200: okSchema(observabilitySummarySchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const runs = await app.services.dashboard.listAgentRuns(userId, 200);
      return ok(app.services.telemetry.summarize(runs), request.id);
    },
  );

  /**
   * Analysis replay: same user request, new conversation and
   * zero tool budget. It is therefore impossible to repeat an external effect
   * by clicking "replay". A true replay with side-effects would require
   * a new mission and its ordinary confirmations.
   */
  app.post(
    "/dashboard/runs/:runId/replay",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        params: z.object({ runId: z.string().uuid() }),
        body: z.object({ mode: z.literal("analysis_only").default("analysis_only") }),
        response: { 200: okSchema(agentRunSchema) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const source = await app.services.runStore.load(request.params.runId);
      if (source?.record.userId !== userId) {
        throw new NotFoundError("Run", request.params.runId);
      }
      if (source.record.endTime === null) {
        throw new ConflictError(
          "An active run cannot be replayed.",
          "Wait for the run to complete before replaying it.",
        );
      }
      if (app.services.agentCore === undefined) {
        throw new DependencyError({
          message: "Agent Core has no active LLM provider.",
          userMessage: "The general-purpose agent engine is not available.",
        });
      }
      const message = lastUserText(source.messages);
      if (message === undefined) {
        throw new ConflictError(
          "The source message for this run is no longer available.",
          "This run no longer contains a replayable request.",
        );
      }

      const conversation = await app.services.conversations.create({
        userId,
        title: `Rejeu d'analyse ${source.record.runId.slice(0, 8)}`,
      });
      const replay = await app.services.agentCore.run({
        userId,
        conversationId: conversation.id,
        message,
        correlationId: request.id,
        replayOfRunId: source.record.runId,
        policy: { maxToolCalls: 0, maxIterations: 3 },
      });
      await app.services.conversations.appendMessage({
        conversationId: conversation.id,
        role: "user",
        content: message,
        originClientDeviceId: null,
      });
      if (replay.record.response !== null) {
        await app.services.conversations.appendMessage({
          conversationId: conversation.id,
          role: "assistant",
          content: replay.record.response,
          originClientDeviceId: null,
        });
      }
      const projected = await app.services.dashboard.getAgentRun(userId, replay.record.runId);
      return ok(requireRun(projected), request.id);
    },
  );

  // ── 6. Tools ──────────────────────────────────────────────────────────

  app.get(
    "/dashboard/tools",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Tool catalog, and which ones are granted",
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
                  source: z.enum(["native", "browser", "search", "acp"]),
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
        summary: "MCP servers and their health",
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

      // Not configured is not broken. Saying so avoids sending operators on a wild-goose chase.
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
      if (store === undefined || manager === undefined) throw new Error("MCP is not manageable.");
      if (request.params.name !== request.body.name) throw new Error("Inconsistent MCP name.");

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
      if (store === undefined || manager === undefined) throw new Error("MCP is not manageable.");
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
        summary: "Browser worker health",
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
      const sessionManager = app.services.browserSessionManager;
      const configuration = (await app.services.runtimeConfiguration?.loadBrowser()) ?? null;
      const tokenConfigured =
        configuration === null || configuration.mode === "local-harness"
          ? false
          : (await app.services.vault?.get(configuration.tokenRef)) !== undefined;

      if (sessionManager !== undefined) {
        try {
          const health = await sessionManager.driver.doctor();
          const activeSessions = sessionManager.listActiveSessions();
          return ok(
            {
              configured: true,
              reachable: health.healthy,
              detail: health.healthy
                ? `local harness connected (${activeSessions.length} active session(s))`
                : "harness installed, browser not connected",
              health,
              configuration,
              tokenConfigured: false,
            },
            request.id,
          );
        } catch (cause) {
          return ok(
            {
              configured: true,
              reachable: false,
              detail: cause instanceof Error ? cause.message : "local harness unavailable",
              health: null,
              configuration,
              tokenConfigured: false,
            },
            request.id,
          );
        }
      }

      if (configuration?.enabled === true && configuration.mode === "local-harness") {
        const harness = new BrowserHarnessClient({ cdpUrl: configuration.cdpUrl });
        try {
          const health = await harness.health();
          return ok(
            {
              configured: true,
              reachable: health.healthy,
              detail: health.healthy
                ? "local harness connected"
                : "harness installed, browser not connected",
              health,
              configuration,
              tokenConfigured: false,
            },
            request.id,
          );
        } catch (cause) {
          return ok(
            {
              configured: true,
              reachable: false,
              detail: cause instanceof Error ? cause.message : "local harness unavailable",
              health: null,
              configuration,
              tokenConfigured: false,
            },
            request.id,
          );
        }
      }
      if (browser === undefined) {
        return ok(
          {
            configured: false,
            reachable: false,
            detail: "browser worker not configured",
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
            detail: "reachable",
            health,
            configuration,
            tokenConfigured,
          },
          request.id,
        );
      } catch (cause) {
        // An unreachable worker is informative, not a request error:
        // the dashboard must still render.
        return ok(
          {
            configured: true,
            reachable: false,
            detail: cause instanceof Error ? cause.message : "unreachable",
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
      if (store === undefined || vault === undefined) throw new Error("Configuration unavailable.");
      const parsed = browserConfigurationSchema.parse(request.body);
      if (parsed.mode === "local-harness") {
        const url = new URL(parsed.cdpUrl);
        if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
          throw new Error("Browser Use CDP must remain on loopback.");
        }
        await store.saveBrowser(parsed);
        app.services.setBrowser(undefined);
        return ok({ saved: true }, request.id);
      }
      const url = new URL(parsed.baseUrl);
      if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
        throw new Error("HTTP is restricted to loopback.");
      }
      const token = parsed.enabled ? await vault.get(parsed.tokenRef) : undefined;
      if (parsed.enabled && token === undefined)
        throw new Error("Worker secret is missing from vault.");
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
      const configuration = await app.services.runtimeConfiguration?.loadBrowser();
      if (configuration?.enabled === true && configuration.mode === "local-harness") {
        const harness = new BrowserHarnessClient({ cdpUrl: configuration.cdpUrl });
        return ok({ health: await harness.connect() }, request.id);
      }
      const browser = app.services.browser;
      if (browser === undefined) throw new Error("Browser worker not configured.");
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
      if (app.services.vault === undefined) throw new Error("Local vault unavailable.");
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
      if (app.services.vault === undefined) throw new Error("Local vault unavailable.");
      await app.services.vault.delete(request.params.name);
      return ok({ removed: true }, request.id);
    },
  );

  // ── 9. Memory ─────────────────────────────────────────────────────────

  app.get(
    "/dashboard/memory",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Memory statistics by layer, origin, and sensitivity",
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

  app.get(
    "/dashboard/notifications/config",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        response: { 200: okSchema(notificationsConfigSchema) },
      },
    },
    async (request) => {
      const config =
        (await app.services.runtimeConfiguration?.loadNotifications()) ??
        notificationsConfigSchema.parse({});
      return ok(config, request.id);
    },
  );

  app.put(
    "/dashboard/notifications/config",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        body: notificationsConfigSchema,
        response: { 200: okSchema(z.object({ saved: z.boolean() })) },
      },
    },
    async (request) => {
      const config = request.body;
      await app.services.runtimeConfiguration?.saveNotifications(config);
      if (app.services.notificationDispatcher !== undefined) {
        app.services.notificationDispatcher.updateConfig(config);
      }
      return ok({ saved: true }, request.id);
    },
  );

  app.post(
    "/dashboard/notifications/test",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        response: {
          200: okSchema(
            z.object({
              report: z.object({
                messageId: z.string(),
                timestamp: z.string(),
                channels: z.array(
                  z.object({
                    channel: z.string(),
                    success: z.boolean(),
                    error: z.string().optional(),
                    skippedReason: z.string().optional(),
                  }),
                ),
              }),
            }),
          ),
        },
      },
    },
    async (request) => {
      const dispatcher = app.services.notificationDispatcher;
      if (dispatcher === undefined) {
        throw new Error("External notifications engine not configured.");
      }
      const report = await dispatcher.sendTest();
      return ok({ report }, request.id);
    },
  );

  // ── 11. Security ──────────────────────────────────────────────────────

  app.get(
    "/dashboard/security",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Security events, device trust, sessions",
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

  // ── 12. Logs ──────────────────────────────────────────────────────────

  app.get(
    "/dashboard/logs",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["dashboard"],
        summary: "Latest retained log lines",
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

function lastUserText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as
      { role?: unknown; content?: { type?: unknown; text?: unknown }[] } | undefined;
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  return undefined;
}

function requireRun<T>(run: T | undefined): T {
  if (run === undefined) throw new Error("Replayed run was not persisted.");
  return run;
}

/** Secrets are strictly keyring references, never persisted JSON. */
function withoutInlineSecrets(config: McpServerConfig): McpServerConfig {
  if (config.transport === "stdio") {
    if (Object.keys(config.env).length > 0) {
      throw new Error("Use envRefs and NEXUS vault for sensitive variables.");
    }
    for (const reference of Object.values(config.envRefs)) vaultReferenceSchema.parse(reference);
    return { ...config, env: {} };
  }

  if (Object.keys(config.headers).length > 0) {
    throw new Error("Use headerRefs and NEXUS vault for sensitive headers.");
  }
  for (const reference of Object.values(config.headerRefs)) vaultReferenceSchema.parse(reference);
  return { ...config, headers: {} };
}

function withoutInlineSecretValues(config: McpServerConfig): McpServerConfig {
  return config.transport === "stdio" ? { ...config, env: {} } : { ...config, headers: {} };
}
