import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export type { PrismaClient };

export interface DatabaseOptions {
  url: string;
  /** Journalise les requêtes SQL. À n'activer qu'en développement. */
  logQueries?: boolean;
  /** Taille maximale du pool de connexions PostgreSQL. */
  poolMax?: number;
}

/**
 * Construit un client Prisma.
 *
 * Depuis Prisma 7, la connexion passe par un driver adapter : c'est `pg` qui
 * détient le pool, pas un moteur natif. Conséquence pratique — la configuration
 * du pool est explicite et sous notre contrôle, et l'URL vient de la
 * configuration validée, jamais d'une lecture directe de `process.env`.
 */
export function createDatabaseClient(options: DatabaseOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.url,
    max: options.poolMax ?? 10,
  });

  return new PrismaClient({
    adapter,
    log: options.logQueries ? ["query", "warn", "error"] : ["warn", "error"],
  });
}

export interface DatabaseHealth {
  status: "up" | "down";
  latencyMs?: number;
  error?: string;
}

/**
 * Sonde de readiness. Volontairement triviale (`SELECT 1`) : on vérifie que le
 * pool rend une connexion, pas que le schéma est correct — une sonde qui fait
 * trop de travail devient elle-même une cause de panne.
 */
export async function checkDatabase(client: PrismaClient): Promise<DatabaseHealth> {
  const startedAt = performance.now();
  try {
    await client.$queryRaw`SELECT 1`;
    return { status: "up", latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      status: "down",
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : "erreur inconnue",
    };
  }
}
