import { Redis } from "ioredis";

/**
 * Client Redis.
 *
 * Un seul Redis sert quatre usages distincts, séparés par convention de préfixe
 * de clé (cf. docs/architecture/02-backend.md) :
 *   session:*    sessions temporaires et jetons éphémères
 *   bull:*       files de jobs (BullMQ, phase 2)
 *   cache:*      cache applicatif
 *   run:* / ws:* pub/sub et streams d'événements temps réel
 *
 * Les connexions pub/sub devront être distinctes du client de commandes : un
 * client Redis en mode subscribe ne peut plus exécuter de commandes ordinaires.
 */

export const RedisKeyPrefix = {
  session: "session:",
  cache: "cache:",
  queue: "bull:",
  runEvents: "run:",
} as const;

export interface RedisOptions {
  url: string;
  /** Nom visible dans `CLIENT LIST` — précieux pour diagnostiquer une fuite de connexions. */
  connectionName?: string;
}

export function createRedisClient(options: RedisOptions): Redis {
  return new Redis(options.url, {
    connectionName: options.connectionName ?? "nexus-api",
    // On ne veut pas qu'une commande reste en attente indéfiniment si Redis est
    // injoignable : elle doit échouer et remonter comme une erreur de dépendance.
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    // La connexion est établie explicitement au démarrage, pas à la première
    // commande : un démarrage doit échouer bruyamment, pas silencieusement.
    lazyConnect: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
}

export interface RedisHealth {
  status: "up" | "down";
  latencyMs?: number;
  error?: string;
}

export async function checkRedis(client: Redis): Promise<RedisHealth> {
  const startedAt = performance.now();
  try {
    const reply: string = await client.ping();
    if (reply !== "PONG") {
      return { status: "down", error: `réponse inattendue : ${reply}` };
    }
    return { status: "up", latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      status: "down",
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : "erreur inconnue",
    };
  }
}
