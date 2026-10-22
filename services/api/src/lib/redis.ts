import { Redis } from "ioredis";

/**
 * Redis client.
 *
 * A single Redis instance serves four distinct purposes, separated by key prefix convention
 * (see docs/architecture/02-backend.md):
 *   session:*    temporary sessions and ephemeral tokens
 *   bull:*       job queues (BullMQ, phase 2)
 *   cache:*      application cache
 *   run:* / ws:* pub/sub and real-time event streams
 *
 * Pub/sub connections must be distinct from the command client: a Redis
 * client in subscribe mode can no longer execute ordinary commands.
 */

export const RedisKeyPrefix = {
  session: "session:",
  cache: "cache:",
  queue: "bull:",
  runEvents: "run:",
} as const;

export interface RedisOptions {
  url: string;
  /** Name visible in `CLIENT LIST` — valuable for diagnosing connection leaks. */
  connectionName?: string;
}

export function createRedisClient(options: RedisOptions): Redis {
  return new Redis(options.url, {
    connectionName: options.connectionName ?? "nexus-api",
    // We do not want a command to hang indefinitely if Redis is unreachable:
    // it must fail and surface as a dependency error.
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    // The connection is established explicitly at startup, not on the first
    // command: startup must fail loudly, not silently.
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
      return { status: "down", error: `unexpected response: ${reply}` };
    }
    return { status: "up", latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      status: "down",
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : "unknown error",
    };
  }
}
