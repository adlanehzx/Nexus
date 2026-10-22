import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@nexus/database";
import { parseConfig } from "@nexus/config";
import {
  livenessResponseSchema,
  readinessResponseSchema,
  errorResponseSchema,
} from "@nexus/protocol";
import { buildApp, type NexusApp } from "../src/app.js";

/**
 * API smoke test.
 *
 * Uses `app.inject()`: no open port, no external services. Dependencies are injected,
 * allowing test of degraded paths — database or Redis failure — which are precisely
 * those difficult to trigger reliably in live integration environments.
 */

const config = parseConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://nexus:pwd@localhost:5432/nexus_test",
  REDIS_URL: "redis://localhost:6379",
});

const logger = pino({ level: "silent" });

function makePrisma(healthy: boolean): PrismaClient {
  return {
    $queryRaw: healthy
      ? vi.fn().mockResolvedValue([{ ok: 1 }])
      : vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:5432")),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  } as unknown as PrismaClient;
}

function makeRedis(healthy: boolean): Redis {
  return {
    ping: healthy
      ? vi.fn().mockResolvedValue("PONG")
      : vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:6379")),
    quit: vi.fn().mockResolvedValue("OK"),
    connect: vi.fn().mockResolvedValue(undefined),
  } as unknown as Redis;
}

async function build(healthy = true): Promise<NexusApp> {
  return buildApp({
    config,
    logger,
    prisma: makePrisma(healthy),
    redis: makeRedis(healthy),
    rateLimitStore: "memory",
  });
}

describe("GET /health — liveness", () => {
  let app: NexusApp;

  beforeEach(async () => {
    app = await build();
  });
  afterEach(async () => {
    await app.close();
  });

  it("responds 200 and complies with contract", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body = livenessResponseSchema.parse(response.json());
    expect(body.status).toBe("ok");
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("remains green even when dependencies are down", async () => {
    // Key reason to separate liveness and readiness: a slow database
    // must not trigger restarts of a healthy application process.
    const degraded = await build(false);
    const response = await degraded.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    await degraded.close();
  });

  it("returns correlation identifier", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["x-request-id"]).toBeDefined();
  });

  it("reuses upstream correlation identifier", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "upstream-correlation" },
    });

    expect(response.headers["x-request-id"]).toBe("upstream-correlation");
  });
});

describe("GET /api/v1/health — readiness", () => {
  it("responds 200 when PostgreSQL and Redis are responsive", async () => {
    const app = await build(true);
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(response.statusCode).toBe(200);
    const body = readinessResponseSchema.parse(response.json());
    expect(body.status).toBe("ok");
    expect(body.dependencies.database.status).toBe("up");
    expect(body.dependencies.redis.status).toBe("up");
    expect(body.dependencies.database.latencyMs).toBeGreaterThanOrEqual(0);

    await app.close();
  });

  it("responds 503 when a dependency is down", async () => {
    // HTTP status must carry information: load balancers check status codes,
    // not response bodies.
    const app = await build(false);
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(response.statusCode).toBe(503);
    const body = readinessResponseSchema.parse(response.json());
    expect(body.status).toBe("degraded");
    expect(body.dependencies.database.status).toBe("down");

    await app.close();
  });

  it("does not leak internal details beyond probe error message", async () => {
    const app = await build(false);
    const body = readinessResponseSchema.parse(
      (await app.inject({ method: "GET", url: "/api/v1/health" })).json(),
    );

    expect(JSON.stringify(body)).not.toContain("stack");
    await app.close();
  });
});

describe("error handling", () => {
  let app: NexusApp;

  beforeEach(async () => {
    app = await build();
  });
  afterEach(async () => {
    await app.close();
  });

  it("returns 404 in standard error format", async () => {
    const response = await app.inject({ method: "GET", url: "/non-existent-route" });

    expect(response.statusCode).toBe(404);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.retryable).toBe(false);
    expect(body.error.correlationId).toBeTruthy();
  });

  it("separates infrastructure probe from versioned probe", async () => {
    // /health belongs to infrastructure and is unversioned;
    // /api/v1/health is part of public API contract. Both coexist
    // and neither is accessible under the other's prefix.
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/../health" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(404);
  });
});

describe("OpenAPI documentation", () => {
  it("describes routes from their Zod schemas", async () => {
    const app = await build();
    await app.ready();

    const spec = app.swagger();
    expect(spec.paths?.["/health"]).toBeDefined();
    expect(spec.paths?.["/api/v1/health"]).toBeDefined();

    await app.close();
  });
});
