import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export type { PrismaClient };

export interface DatabaseOptions {
  url: string;
  /** Logs SQL queries. Enable in development only. */
  logQueries?: boolean;
  /** Maximum PostgreSQL connection pool size. */
  poolMax?: number;
}

/**
 * Builds a PrismaClient instance.
 *
 * Uses `@prisma/adapter-pg` driver adapter. Connection pooling is managed
 * explicitly via `pg`, with validated configuration rather than reading raw process.env.
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
 * Readiness probe (`SELECT 1`).
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
      error: error instanceof Error ? error.message : "unknown error",
    };
  }
}
