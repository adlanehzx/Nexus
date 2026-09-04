import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getConfig, loadDotEnv } from "@nexus/config";
import { createLogger } from "./lib/logger.js";
import { buildApp } from "./app.js";
import { ServiceContainer } from "./services/container.js";

/**
 * Point d'entrée du service API.
 *
 * Responsabilités, dans cet ordre : charger et VALIDER la configuration,
 * démarrer les dépendances, écouter, puis s'arrêter proprement. Rien d'autre —
 * l'assemblage de l'application vit dans `app.ts`, pour rester testable.
 */

const here = dirname(fileURLToPath(import.meta.url));
loadDotEnv(resolve(here, "../../../.env"));

// Une configuration invalide doit empêcher le boot, pas produire une erreur
// obscure à la première requête. On la résout donc avant toute autre chose.
const config = getConfig();

/**
 * Les services d'abord, le logger ensuite.
 *
 * L'ordre n'est pas arbitraire : le conteneur porte le tampon de journaux que
 * le tableau de bord affiche, et le logger doit ecrire dedans. Construire le
 * logger en premier laisserait le tampon vide, et la section « Journaux »
 * afficherait un ecran blanc sans que rien n'echoue.
 */
import { FallbackProvider, ClaudeCliProvider, GeminiCliProvider, LocalLLMProvider } from "@nexus/llm";
import { createDatabaseClient } from "@nexus/database";
import { PrismaUserStore } from "./services/persistence/prisma-user-store.js";
import { PrismaSessionStore } from "./services/persistence/prisma-session-store.js";
import { PrismaDeviceStore } from "./services/persistence/prisma-device-store.js";
import { PrismaTaskStore } from "./services/persistence/prisma-task-store.js";

const prisma = createDatabaseClient({ url: config.DATABASE_URL });

const services = new ServiceContainer({
  users: new PrismaUserStore(prisma),
  sessions: new PrismaSessionStore(prisma),
  deviceStore: new PrismaDeviceStore(prisma),
  taskStore: new PrismaTaskStore(prisma),
  tokenPrivateKeyPem: config.AUTH_SIGNING_KEY,
  apiVersion: config.API_VERSION,
  llmProvider: new FallbackProvider([
    new ClaudeCliProvider(),
    new GeminiCliProvider(),
    new LocalLLMProvider(),
  ]),
});

const logger = createLogger(config, [services.logs]);

async function main(): Promise<void> {
  const app = await buildApp({ config, logger, services, prisma });

  // Redis est en `lazyConnect` : on force la connexion maintenant pour qu'un
  // Redis injoignable fasse échouer le démarrage bruyamment.
  await app.redis.connect();

  // Phase 5 Recovery: Reconstruct active task states from persistent storage
  // before accepting new traffic.
  await services.coordinator.recover();

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  logger.info(
    { event: "api.listening", host: config.API_HOST, port: config.API_PORT },
    "API en écoute",
  );

  let shuttingDown = false;

  /**
   * Arrêt gracieux.
   *
   * Fastify cesse d'accepter, laisse les requêtes en cours se terminer, puis on
   * ferme les dépendances. Le minuteur est la garantie de dernier recours : un
   * processus qui refuse de mourir sera tué par l'orchestrateur de toute façon,
   * autant le faire nous-mêmes proprement et en le journalisant.
   */
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ event: "api.shutdown.start", signal }, "Arrêt en cours");

    const forceExit = setTimeout(() => {
      logger.error(
        { event: "api.shutdown.timeout", timeoutMs: config.SHUTDOWN_TIMEOUT_MS },
        "Arrêt gracieux dépassé — sortie forcée",
      );
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      await app.close();
      await Promise.allSettled([app.prisma.$disconnect(), app.redis.quit()]);
      logger.info({ event: "api.shutdown.done" }, "Arrêt terminé");
      process.exit(0);
    } catch (error) {
      logger.error({ event: "api.shutdown.error", err: error }, "Échec de l'arrêt gracieux");
      process.exit(1);
    }
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  // Une exception non capturée laisse le processus dans un état indéterminé :
  // on journalise et on sort, plutôt que de continuer à servir du trafic.
  process.on("uncaughtException", (error) => {
    logger.fatal({ event: "api.uncaught_exception", err: error }, "Exception non capturée");
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ event: "api.unhandled_rejection", err: reason }, "Promesse rejetée non gérée");
    void shutdown("unhandledRejection");
  });
}

main().catch((error: unknown) => {
  logger.fatal({ event: "api.boot_failed", err: error }, "Démarrage impossible");
  process.exit(1);
});
