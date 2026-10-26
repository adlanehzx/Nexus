import Fastify, { LogController } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Logger } from "pino";
import type { AppConfig } from "@nexus/config";
import { newCorrelationId } from "@nexus/shared";
import { createDatabaseClient, type PrismaClient } from "@nexus/database";
import type { Redis } from "ioredis";
import { createRedisClient } from "./lib/redis.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { authenticationPlugin } from "./plugins/authentication.js";
import { ServiceContainer } from "./services/container.js";
import { PrismaUserStore } from "./services/persistence/prisma-user-store.js";
import { PrismaSessionStore } from "./services/persistence/prisma-session-store.js";
import { PrismaDeviceStore } from "./services/persistence/prisma-device-store.js";
import { PrismaTaskStore } from "./services/persistence/prisma-task-store.js";
import { PrismaAgentRunClaimStore } from "./services/persistence/prisma-agent-run-claim-store.js";
import { PrismaMissionGrantRegistry } from "./services/persistence/prisma-mission-grant-registry.js";
import { PrismaScheduleGrantRegistry } from "./services/persistence/prisma-schedule-grant-registry.js";
import { PrismaConversationStore } from "./services/persistence/prisma-conversation-store.js";
import { ClientChannel } from "./ws/client-channel.js";
import { WorkerChannel } from "./ws/worker-channel.js";
import { websocketRoutes } from "./ws/routes.js";
import { healthRoutes } from "./routes/health.js";
import { v1HealthRoutes } from "./routes/v1/health.js";
import { authRoutes, userRoutes } from "./routes/v1/auth.js";
import { capabilityRoutes, deviceRoutes } from "./routes/v1/devices.js";
import { confirmationRoutes, taskRoutes } from "./routes/v1/tasks.js";
import { pauseRoutes } from "./routes/v1/pause.js";
import {
  conversationRoutes,
  memoryRoutes,
  notificationRoutes,
  toolRoutes,
} from "./routes/v1/conversations.js";
import { dashboardRoutes } from "./routes/v1/dashboard.js";
import { missionControlRoutes } from "./routes/v1/mission-control.js";
import { orchestratorRoutes } from "./routes/v1/orchestrator.js";
import { agentCoreRoutes } from "./routes/v1/agent-core.js";
import { connectionRoutes } from "./routes/v1/connections.js";
import { organizationRoutes } from "./routes/v1/organizations.js";
import { careerRoutes } from "./routes/v1/career.js";
import { linkedInRoutes } from "./routes/v1/linkedin.js";
import { finishHttpSpan, startHttpSpan } from "./services/telemetry-runtime.js";

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    prisma: PrismaClient;
    redis: Redis;
    /** Real-time channels. WebSocket transport connects here. */
    clientChannel: ClientChannel;
    workerChannel: WorkerChannel;
  }
}

export interface BuildAppOptions {
  config: AppConfig;
  logger: Logger;
  /** Injectable for tests: avoids opening real connections. */
  prisma?: PrismaClient;
  redis?: Redis;
  /**
   * Where to count requests for rate limiting. "redis" in production
   * (counter shared across replicas), "memory" in tests, which do not need
   * to depend on an external service.
   */
  rateLimitStore?: "redis" | "memory";
  /**
   * Application services.
   *
   * Injectable so tests can wire their own stores. In production,
   * the application builds one from configuration.
   */
  services?: ServiceContainer;
  /**
   * Mount WebSocket transport.
   *
   * Disabled in tests using only `app.inject()`: `@fastify/websocket`
   * attaches an upgrade server to the HTTP server, which makes no sense when
   * no port is open.
   */
  websocket?: boolean;
  /** WebSocket handshake timeout. Shortened in tests. */
  websocketHandshakeTimeoutMs?: number;
}

/**
 * Builds the application without listening.
 *
 * The build / listen separation is what makes the API testable: tests
 * use `app.inject()` and consume no ports. `server.ts` only starts
 * what this function assembled.
 */
export async function buildApp(options: BuildAppOptions) {
  const { config, logger } = options;

  const app = Fastify({
    loggerInstance: logger,
    // Correlation identifier: accepted from upstream if present (the reverse
    // proxy or another service may have already emitted it), generated otherwise.
    // It then traverses the whole chain and appears in every log.
    requestIdHeader: "x-request-id",
    genReqId: () => newCorrelationId(),
    logController: new LogController({ requestIdLogLabel: "correlationId" }),
    trustProxy: true,
    bodyLimit: 1_048_576,
    ajv: { customOptions: { removeAdditional: false } },
  }).withTypeProvider<ZodTypeProvider>();
  const requestSpans = new WeakMap<object, ReturnType<typeof startHttpSpan>>();

  // Zod becomes both the validation AND serialization engine: a single schema
  // validates input, types the handler, and generates OpenAPI documentation.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate("config", config);

  const prisma =
    options.prisma ??
    createDatabaseClient({
      url: config.DATABASE_URL,
      logQueries: config.NODE_ENV === "development",
    });
  const redis = options.redis ?? createRedisClient({ url: config.REDIS_URL });

  app.decorate("prisma", prisma);
  app.decorate("redis", redis);

  // The correlation identifier is returned with the response: in case of error,
  // the user can cite it and a single search reveals the whole history
  // of their request — HTTP, job, agent run, tool execution.
  app.addHook("onRequest", (request, reply, done) => {
    void reply.header("x-request-id", request.id);
    requestSpans.set(
      request,
      startHttpSpan({
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        correlationId: request.id,
      }),
    );
    done();
  });

  app.addHook("onResponse", (request, reply, done) => {
    const active = requestSpans.get(request);
    if (active !== undefined) {
      finishHttpSpan(active, {
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        statusCode: reply.statusCode,
      });
      requestSpans.delete(request);
    }
    done();
  });

  const services =
    options.services ??
    new ServiceContainer({
      tokenPrivateKeyPem: config.AUTH_SIGNING_KEY,
      prisma,
      onTaskError: (error, taskId) => {
        logger.error({ err: error, taskId }, "plan execution aborted");
      },
      users: new PrismaUserStore(prisma),
      sessions: new PrismaSessionStore(prisma),
      conversations: new PrismaConversationStore(prisma),
      deviceStore: new PrismaDeviceStore(prisma),
      taskStore: new PrismaTaskStore(prisma),
      agentRunClaims: new PrismaAgentRunClaimStore(prisma),
      missionGrantRegistry: new PrismaMissionGrantRegistry(prisma),
      scheduleGrantRegistry: new PrismaScheduleGrantRegistry(prisma),
    });

  app.decorate(
    "clientChannel",
    new ClientChannel({
      services,
      onError: (error, context) => {
        logger.warn({ err: error, ...context }, "client request rejected");
      },
    }),
  );
  app.decorate(
    "workerChannel",
    new WorkerChannel({
      services,
      onError: (error, deviceId) => {
        logger.warn({ err: error, deviceId }, "worker frame rejected");
      },
    }),
  );

  await app.register(errorHandlerPlugin);
  await app.register(authenticationPlugin, { services });

  await app.register(helmet, {
    // The API does not serve HTML: default CSP has nothing to protect here
    // and would interfere with the OpenAPI documentation page.
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    nameSpace: "ratelimit:",
    // Redis is already here: sharing the counter between instances prevents
    // a quota of 100 from becoming 100 * number of replicas.
    ...((options.rateLimitStore ?? "redis") === "redis" ? { redis } : {}),
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "NEXUS API",
        description: "NEXUS personal assistant API",
        version: config.API_VERSION,
      },
      servers: [{ url: `http://${config.API_HOST}:${String(config.API_PORT)}` }],
    },
    transform: jsonSchemaTransform,
  });

  // Liveness probe, unversioned: belongs to infrastructure, not the API's public contract.
  await app.register(healthRoutes);

  // Real-time transport. Outside versioned prefix: version travels in
  // frame envelope (`v`), not the URL — a socket lives for hours and cannot
  // change URLs in flight.
  if (options.websocket !== false) {
    await app.register(websocketRoutes, {
      allowedOrigins: config.CORS_ORIGINS,
      ...(options.websocketHandshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: options.websocketHandshakeTimeoutMs }),
    });
  }

  // All domain routes under the same versioned prefix: public contract
  // changes version as a whole, never route by route.
  await app.register(
    async (v1) => {
      await v1.register(v1HealthRoutes);
      await v1.register(authRoutes);
      await v1.register(userRoutes);
      await v1.register(deviceRoutes);
      await v1.register(capabilityRoutes);
      await v1.register(taskRoutes);
      await v1.register(pauseRoutes);
      await v1.register(confirmationRoutes);
      await v1.register(conversationRoutes);
      await v1.register(notificationRoutes);
      await v1.register(memoryRoutes);
      await v1.register(toolRoutes);
      await v1.register(dashboardRoutes);
      await v1.register(missionControlRoutes);
      await v1.register(orchestratorRoutes);
      await v1.register(agentCoreRoutes);
      await v1.register(connectionRoutes);
      await v1.register(organizationRoutes);
      await v1.register(careerRoutes);
      await v1.register(linkedInRoutes);
    },
    { prefix: "/api/v1" },
  );

  app.addHook("onReady", () => {
    app.log.info({ event: "api.ready", version: config.API_VERSION }, "API ready");
  });

  return app;
}

/**
 * Exact type of the assembled application: Fastify instance specialized by the
 * Pino logger and Zod type provider. Inferred rather than rewritten manually —
 * an approximate annotation would hide typing errors that `withTypeProvider` is meant to surface.
 */
export type NexusApp = Awaited<ReturnType<typeof buildApp>>;
