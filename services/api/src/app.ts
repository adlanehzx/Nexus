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
import { PrismaConversationStore } from "./services/persistence/prisma-conversation-store.js";
import { ClientChannel } from "./ws/client-channel.js";
import { WorkerChannel } from "./ws/worker-channel.js";
import { websocketRoutes } from "./ws/routes.js";
import { healthRoutes } from "./routes/health.js";
import { v1HealthRoutes } from "./routes/v1/health.js";
import { authRoutes, userRoutes } from "./routes/v1/auth.js";
import { capabilityRoutes, deviceRoutes } from "./routes/v1/devices.js";
import { confirmationRoutes, taskRoutes } from "./routes/v1/tasks.js";
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

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    prisma: PrismaClient;
    redis: Redis;
    /** Canaux temps réel. Le transport WebSocket s'y branche. */
    clientChannel: ClientChannel;
    workerChannel: WorkerChannel;
  }
}

export interface BuildAppOptions {
  config: AppConfig;
  logger: Logger;
  /** Injectables pour les tests : évite d'ouvrir de vraies connexions. */
  prisma?: PrismaClient;
  redis?: Redis;
  /**
   * Où compter les requêtes pour la limitation de débit. "redis" en production
   * (compteur partagé entre réplicas), "memory" dans les tests, qui n'ont pas à
   * dépendre d'un service externe.
   */
  rateLimitStore?: "redis" | "memory";
  /**
   * Services applicatifs.
   *
   * Injectables pour que les tests câblent leurs propres magasins. En
   * production, l'application en construit un à partir de la configuration.
   */
  services?: ServiceContainer;
  /**
   * Monter le transport WebSocket.
   *
   * Coupé dans les tests qui n'utilisent que `app.inject()` : `@fastify/websocket`
   * attache un serveur d'upgrade au serveur HTTP, ce qui n'a aucun sens quand
   * aucun port n'est ouvert.
   */
  websocket?: boolean;
  /** Délai de poignée de main WebSocket. Raccourci dans les tests. */
  websocketHandshakeTimeoutMs?: number;
}

/**
 * Construit l'application sans l'écouter.
 *
 * La séparation build / listen est ce qui rend l'API testable : les tests
 * utilisent `app.inject()` et ne consomment aucun port. `server.ts` ne fait que
 * démarrer ce que cette fonction a assemblé.
 */
export async function buildApp(options: BuildAppOptions) {
  const { config, logger } = options;

  const app = Fastify({
    loggerInstance: logger,
    // Identifiant de corrélation : accepté depuis l'amont s'il existe (le
    // reverse proxy ou un autre service l'a peut-être déjà émis), généré sinon.
    // Il traverse ensuite toute la chaîne et figure dans chaque log.
    requestIdHeader: "x-request-id",
    genReqId: () => newCorrelationId(),
    logController: new LogController({ requestIdLogLabel: "correlationId" }),
    trustProxy: true,
    bodyLimit: 1_048_576,
    ajv: { customOptions: { removeAdditional: false } },
  }).withTypeProvider<ZodTypeProvider>();

  // Zod devient le moteur de validation ET de sérialisation : un schéma unique
  // valide l'entrée, type le handler et produit la documentation OpenAPI.
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

  // L'identifiant de corrélation repart avec la réponse : en cas d'erreur,
  // l'utilisateur peut le citer et une seule recherche donne toute l'histoire
  // de sa requête — HTTP, job, run agent, exécution d'outil.
  app.addHook("onRequest", (request, reply, done) => {
    void reply.header("x-request-id", request.id);
    done();
  });

  const services =
    options.services ??
    new ServiceContainer({
      tokenPrivateKeyPem: config.AUTH_SIGNING_KEY,
      prisma,
      onTaskError: (error, taskId) => {
        logger.error({ err: error, taskId }, "exécution de plan interrompue");
      },
      users: new PrismaUserStore(prisma),
      sessions: new PrismaSessionStore(prisma),
      conversations: new PrismaConversationStore(prisma),
      deviceStore: new PrismaDeviceStore(prisma),
      taskStore: new PrismaTaskStore(prisma),
    });

  app.decorate(
    "clientChannel",
    new ClientChannel({
      services,
      onError: (error, context) => {
        logger.warn({ err: error, ...context }, "demande client refusée");
      },
    }),
  );
  app.decorate(
    "workerChannel",
    new WorkerChannel({
      services,
      onError: (error, deviceId) => {
        logger.warn({ err: error, deviceId }, "trame worker refusée");
      },
    }),
  );

  await app.register(errorHandlerPlugin);
  await app.register(authenticationPlugin, { services });

  await app.register(helmet, {
    // L'API ne sert pas de HTML : la CSP par défaut n'a rien à protéger ici et
    // gênerait la page de documentation OpenAPI.
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
    // Redis est déjà là : partager le compteur entre instances évite qu'un
    // quota de 100 devienne un quota de 100 × nombre de réplicas.
    ...((options.rateLimitStore ?? "redis") === "redis" ? { redis } : {}),
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "NEXUS API",
        description: "API de l'assistant personnel NEXUS",
        version: config.API_VERSION,
      },
      servers: [{ url: `http://${config.API_HOST}:${String(config.API_PORT)}` }],
    },
    transform: jsonSchemaTransform,
  });

  // Sonde de liveness, hors versionnement : elle appartient à l'infrastructure,
  // pas au contrat public de l'API.
  await app.register(healthRoutes);

  // Transport temps réel. Hors du préfixe versionné : la version voyage dans
  // l'enveloppe de chaque trame (`v`), pas dans l'URL — une socket vit des
  // heures et ne peut pas changer d'URL en cours de route.
  if (options.websocket !== false) {
    await app.register(websocketRoutes, {
      allowedOrigins: config.CORS_ORIGINS,
      ...(options.websocketHandshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: options.websocketHandshakeTimeoutMs }),
    });
  }

  // Toutes les routes métier sous le même préfixe versionné : le contrat public
  // change de version en bloc, jamais route par route.
  await app.register(
    async (v1) => {
      await v1.register(v1HealthRoutes);
      await v1.register(authRoutes);
      await v1.register(userRoutes);
      await v1.register(deviceRoutes);
      await v1.register(capabilityRoutes);
      await v1.register(taskRoutes);
      await v1.register(confirmationRoutes);
      await v1.register(conversationRoutes);
      await v1.register(notificationRoutes);
      await v1.register(memoryRoutes);
      await v1.register(toolRoutes);
      await v1.register(dashboardRoutes);
      await v1.register(missionControlRoutes);
      await v1.register(orchestratorRoutes);
      await v1.register(agentCoreRoutes);
    },
    { prefix: "/api/v1" },
  );

  app.addHook("onReady", () => {
    app.log.info({ event: "api.ready", version: config.API_VERSION }, "API prête");
  });

  return app;
}

/**
 * Type exact de l'application assemblée : instance Fastify spécialisée par le
 * logger Pino et le type provider Zod. On l'infère plutôt que de la réécrire à
 * la main — une annotation approximative masquerait justement les erreurs de
 * typage que `withTypeProvider` est censé faire remonter.
 */
export type NexusApp = Awaited<ReturnType<typeof buildApp>>;
