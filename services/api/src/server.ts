import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getConfig, loadDotEnv } from "@nexus/config";
import { createLogger } from "./lib/logger.js";
import { buildApp } from "./app.js";
import { ServiceContainer } from "./services/container.js";
import { ToolRegistry } from "@nexus/tools";
import { McpManager } from "@nexus/mcp";
import {
  BrowserWorkerClient,
  BrowserHarnessDriver,
  BrowserSessionManager,
} from "@nexus/browser-client";
import { NotificationDispatcher } from "@nexus/notifications";
import { KeyringVault, RuntimeConfigurationStore } from "./services/runtime-configuration.js";
import { TailscaleDiscoveryService } from "./services/tailscale-discovery.js";
import { initializeTelemetry } from "./services/telemetry-runtime.js";
import { NexusTelemetry } from "./services/domain-telemetry.js";

/**
 * API service entrypoint.
 *
 * Responsibilities, in this order: load and VALIDATE configuration,
 * start dependencies, listen, then shut down cleanly. Nothing else —
 * application assembly lives in `app.ts` to remain testable.
 */

const here = dirname(fileURLToPath(import.meta.url));
loadDotEnv(resolve(here, "../../../.env"));

// An invalid configuration must prevent boot, not yield an obscure error
// on the first request. It is therefore resolved before anything else.
const config = getConfig();
const telemetryRuntime = initializeTelemetry(config);

/**
 * Services first, then the logger.
 *
 * The order is not arbitrary: the container holds the log buffer displayed
 * by the dashboard, and the logger must write into it. Building the logger first
 * would leave the buffer empty, and the "Logs" section would display a blank screen
 * without anything actually failing.
 */
import {
  AntigravityCliProvider,
  ClaudeCliProvider,
  FallbackProvider,
  OllamaProvider,
} from "@nexus/llm";
import { createDatabaseClient } from "@nexus/database";
import { PrismaUserStore } from "./services/persistence/prisma-user-store.js";
import { PrismaPairingTicketStore } from "./services/persistence/prisma-pairing-ticket-store.js";
import { PrismaSessionStore } from "./services/persistence/prisma-session-store.js";
import { PrismaDeviceStore } from "./services/persistence/prisma-device-store.js";
import { PrismaDeviceCredentialStore } from "./services/persistence/prisma-device-credential-store.js";
import { PrismaTaskStore } from "./services/persistence/prisma-task-store.js";
import { PrismaAgentRunClaimStore } from "./services/persistence/prisma-agent-run-claim-store.js";
import { PrismaMissionGrantRegistry } from "./services/persistence/prisma-mission-grant-registry.js";
import { PrismaScheduleGrantRegistry } from "./services/persistence/prisma-schedule-grant-registry.js";
import { PrismaNotificationStore } from "./services/persistence/prisma-notification-store.js";
import { PrismaAgentRunStore } from "./services/persistence/prisma-agent-run-store.js";
import { PrismaConversationStore } from "./services/persistence/prisma-conversation-store.js";
import { PrismaCareerStore } from "./services/persistence/prisma-career-store.js";
import { MissionControlClient } from "@nexus/mission-control-client";
import { MISSION_ENGINE_AUDIENCE, TokenService } from "@nexus/auth";
import { SearxngClient, createWebSearchTools } from "@nexus/web-search";
import { LocalHashEmbeddingProvider, TransformersEmbeddingProvider } from "@nexus/memory";

const prisma = createDatabaseClient({ url: config.DATABASE_URL });
const runtimeConfiguration = new RuntimeConfigurationStore(
  config.NEXUS_RUNTIME_CONFIG_DIR ?? resolve(here, "../config"),
);
const vault = new KeyringVault(runtimeConfiguration);
const toolRegistry = new ToolRegistry();
if (config.SEARXNG_URL !== undefined) {
  const webSearch = new SearxngClient({
    baseUrl: config.SEARXNG_URL,
    timeoutMs: config.SEARXNG_TIMEOUT_MS,
  });
  toolRegistry.registerAll(createWebSearchTools({ provider: webSearch }));
}
const mcp = new McpManager({
  registry: toolRegistry,
  configs: await runtimeConfiguration.loadMcp(),
  resolveSecret: (reference) => vault.get(reference),
});
const browserConfiguration = await runtimeConfiguration.loadBrowser();
const browserToken =
  browserConfiguration?.enabled === true && browserConfiguration.mode === "remote-worker"
    ? await vault.get(browserConfiguration.tokenRef)
    : undefined;
const browser =
  browserConfiguration?.enabled === true &&
  browserConfiguration.mode === "remote-worker" &&
  browserToken !== undefined
    ? new BrowserWorkerClient({ baseUrl: browserConfiguration.baseUrl, token: browserToken })
    : undefined;

const isLocalHarnessEnabled =
  browserConfiguration?.enabled !== false &&
  (browserConfiguration?.mode === "local-harness" || browserConfiguration === null);

const nativeBrowserDriver = isLocalHarnessEnabled
  ? new BrowserHarnessDriver({
      cdpUrl: browserConfiguration?.cdpUrl ?? process.env.BU_CDP_URL ?? "http://127.0.0.1:19222",
    })
  : undefined;

const browserSessionManager = nativeBrowserDriver
  ? new BrowserSessionManager({
      driver: nativeBrowserDriver,
      artifactsDirectory:
        config.NEXUS_BROWSER_ARTIFACTS_DIR ?? resolve(here, "../../../var/artifacts/browser"),
    })
  : undefined;

const notificationsConfiguration = (await runtimeConfiguration?.loadNotifications()) ?? null;

const notificationDispatcher =
  notificationsConfiguration?.enabled !== false
    ? new NotificationDispatcher({
        config: notificationsConfiguration ?? {
          enabled: true,
          desktop: { enabled: true, urgency: "normal" },
          ntfy: { enabled: false, serverUrl: "https://ntfy.sh", topic: "nexus-alerts" },
          quietHours: {
            enabled: false,
            start: "22:00",
            end: "08:00",
            timezone: "Europe/Paris",
            allowUrgent: true,
          },
          grouping: { enabled: true, windowSeconds: 30 },
          dashboardBaseUrl: `http://localhost:${config.API_PORT}`,
        },
        resolveSecret: vault ? (ref) => vault.get(ref) : undefined,
      })
    : undefined;

/**
 * Dedicated signer for outbound calls.
 *
 * A second instance using the same key, rather than a reference to the container:
 * capturing `services` in a closure within its own initializer causes it to be inferred
 * as `any`, disarming all `no-unsafe-*` rules along that path. The token service is stateless,
 * so two instances derived from the same PEM produce interchangeable tokens.
 */
const outboundSigner = new TokenService({ privateKeyPem: config.AUTH_SIGNING_KEY });
const embeddings =
  config.MEMORY_EMBEDDING_BACKEND === "neural"
    ? new TransformersEmbeddingProvider({
        model: config.MEMORY_EMBEDDING_MODEL,
        ...(config.MEMORY_EMBEDDING_CACHE_DIR === undefined
          ? {}
          : { cacheDir: config.MEMORY_EMBEDDING_CACHE_DIR }),
        localFilesOnly: config.MEMORY_EMBEDDING_LOCAL_ONLY,
      })
    : new LocalHashEmbeddingProvider();

const services = new ServiceContainer({
  prisma,
  users: new PrismaUserStore(prisma),
  sessions: new PrismaSessionStore(prisma),
  conversations: new PrismaConversationStore(prisma),
  deviceStore: new PrismaDeviceStore(prisma),
  // Without this store, device public keys lived in memory: an API restart
  // lost all of them, and every worker was subsequently rejected at handshake
  // without any clue pointing to the cause.
  credentials: new PrismaDeviceCredentialStore(prisma),
  taskStore: new PrismaTaskStore(prisma),
  agentRunClaims: new PrismaAgentRunClaimStore(prisma),
  missionGrantRegistry: new PrismaMissionGrantRegistry(prisma),
  scheduleGrantRegistry: new PrismaScheduleGrantRegistry(prisma),
  notifications: new PrismaNotificationStore(prisma),
  runStore: new PrismaAgentRunStore(prisma),
  careerStore: new PrismaCareerStore(prisma),
  telemetry: new NexusTelemetry({ pricing: config.MODEL_PRICING_JSON }),
  embeddings,
  observabilityDirectory:
    config.NEXUS_OBSERVABILITY_DIR ?? resolve(here, "../../../var/observability"),
  tokenPrivateKeyPem: config.AUTH_SIGNING_KEY,
  apiVersion: config.API_VERSION,
  toolRegistry,
  mcp,
  runtimeConfiguration,
  vault,
  ...(browser === undefined ? {} : { browser }),
  ...(browserSessionManager === undefined ? {} : { browserSessionManager }),
  ...(notificationDispatcher === undefined ? {} : { notificationDispatcher }),
  llmProvider: new FallbackProvider([
    new AntigravityCliProvider(),
    new ClaudeCliProvider(),
    new OllamaProvider(),
  ]),
  tailscale: new TailscaleDiscoveryService({ apiPort: config.API_PORT }),
  ...(config.PUBLIC_API_URL === undefined ? {} : { publicApiUrl: config.PUBLIC_API_URL }),
  ...(config.EXPECTED_WORKER_VERSION === undefined
    ? {}
    : { expectedWorkerVersion: config.EXPECTED_WORKER_VERSION }),
  pairingTickets: new PrismaPairingTicketStore(prisma),
  ...(config.MISSION_CONTROL_URL === undefined
    ? {}
    : {
        missionControl: new MissionControlClient({
          baseUrl: config.MISSION_CONTROL_URL,
          // Closure, not a static value: only invoked when making an outbound call,
          // well after `services` is constructed — emitting a fresh token,
          // which a frozen string could not do.
          serviceToken: () =>
            outboundSigner.issueServiceToken({
              service: "nexus-api",
              audience: MISSION_ENGINE_AUDIENCE,
            }).token,
        }),
      }),
});

const logger = createLogger(config, [services.logs]);

async function main(): Promise<void> {
  const app = await buildApp({ config, logger, services, prisma });

  // Redis uses `lazyConnect`: we force connection now so that an unreachable
  // Redis fails startup loudly.
  await app.redis.connect();
  await services.mcp?.start();

  // Phase 5 Recovery: Reconstruct active task states from persistent storage
  // before accepting new traffic.
  await services.coordinator.recover();

  // Pause state is read **before** accepting traffic. Without this line,
  // it would be written to disk and never reloaded: NEXUS would seem paused
  // but resume operations upon the first restart, without alerting anyone.
  // The log announces it, because a paused boot must explain itself.
  const pause = await services.pause.restore();
  if (pause.paused) {
    logger.warn(
      { event: "api.paused", since: pause.since, reason: pause.reason },
      "NEXUS is starting in paused state: only side-effect-free actions are allowed",
    );
  }

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  logger.info(
    { event: "api.listening", host: config.API_HOST, port: config.API_PORT },
    "API listening",
  );

  let shuttingDown = false;

  /**
   * Graceful shutdown.
   *
   * Fastify stops accepting new requests, lets in-flight requests finish,
   * then dependencies are closed. The timer is the last-resort guarantee:
   * a process refusing to die will be killed by the orchestrator anyway,
   * so we might as well do it cleanly ourselves with proper logging.
   */
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ event: "api.shutdown.start", signal }, "Shutdown in progress");

    const forceExit = setTimeout(() => {
      logger.error(
        { event: "api.shutdown.timeout", timeoutMs: config.SHUTDOWN_TIMEOUT_MS },
        "Graceful shutdown timeout exceeded — forcing exit",
      );
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      await app.close();
      await Promise.allSettled([
        services.mcp?.stop(),
        app.prisma.$disconnect(),
        app.redis.quit(),
        telemetryRuntime.shutdown(),
      ]);
      logger.info({ event: "api.shutdown.done" }, "Shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error({ event: "api.shutdown.error", err: error }, "Graceful shutdown failed");
      process.exit(1);
    }
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  // An uncaught exception leaves the process in an indeterminate state:
  // we log and exit rather than continuing to serve traffic.
  process.on("uncaughtException", (error) => {
    logger.fatal({ event: "api.uncaught_exception", err: error }, "Uncaught exception");
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ event: "api.unhandled_rejection", err: reason }, "Unhandled rejection");
    void shutdown("unhandledRejection");
  });
}

main().catch((error: unknown) => {
  logger.fatal({ event: "api.boot_failed", err: error }, "Boot failed");
  process.exit(1);
});
