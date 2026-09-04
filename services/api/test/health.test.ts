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
 * Smoke test de l'API.
 *
 * Utilise `app.inject()` : aucun port ouvert, aucun service externe. Les
 * dépendances sont injectées, ce qui permet de tester le chemin dégradé —
 * base ou Redis en panne — qui est précisément celui qu'on ne peut pas
 * provoquer facilement en intégration.
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

  it("répond 200 et respecte son contrat", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body = livenessResponseSchema.parse(response.json());
    expect(body.status).toBe("ok");
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("reste vert même quand les dépendances sont tombées", async () => {
    // C'est tout l'intérêt de séparer liveness et readiness : une base lente ne
    // doit pas provoquer le redémarrage d'un processus sain.
    const degraded = await build(false);
    const response = await degraded.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    await degraded.close();
  });

  it("renvoie un identifiant de corrélation", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["x-request-id"]).toBeDefined();
  });

  it("réutilise l'identifiant de corrélation fourni en amont", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "correlation-amont" },
    });

    expect(response.headers["x-request-id"]).toBe("correlation-amont");
  });
});

describe("GET /api/v1/health — readiness", () => {
  it("répond 200 quand PostgreSQL et Redis répondent", async () => {
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

  it("répond 503 quand une dépendance est tombée", async () => {
    // Le statut HTTP doit porter l'information : aucun load balancer ne lit le
    // corps de la réponse.
    const app = await build(false);
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(response.statusCode).toBe(503);
    const body = readinessResponseSchema.parse(response.json());
    expect(body.status).toBe("degraded");
    expect(body.dependencies.database.status).toBe("down");

    await app.close();
  });

  it("ne divulgue pas de détail interne au-delà du message d'erreur de la sonde", async () => {
    const app = await build(false);
    const body = readinessResponseSchema.parse(
      (await app.inject({ method: "GET", url: "/api/v1/health" })).json(),
    );

    expect(JSON.stringify(body)).not.toContain("stack");
    await app.close();
  });
});

describe("gestion des erreurs", () => {
  let app: NexusApp;

  beforeEach(async () => {
    app = await build();
  });
  afterEach(async () => {
    await app.close();
  });

  it("renvoie une 404 dans la forme d'erreur standard", async () => {
    const response = await app.inject({ method: "GET", url: "/route-qui-nexiste-pas" });

    expect(response.statusCode).toBe(404);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.retryable).toBe(false);
    expect(body.error.correlationId).toBeTruthy();
  });

  it("sépare la sonde d'infrastructure de la sonde versionnée", async () => {
    // /health appartient à l'infrastructure et n'est pas versionnée ;
    // /api/v1/health fait partie du contrat public. Les deux coexistent, et
    // aucune n'est accessible sous le préfixe de l'autre.
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/../health" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(404);
  });
});

describe("documentation OpenAPI", () => {
  it("décrit les routes à partir de leurs schémas Zod", async () => {
    const app = await build();
    await app.ready();

    const spec = app.swagger();
    expect(spec.paths?.["/health"]).toBeDefined();
    expect(spec.paths?.["/api/v1/health"]).toBeDefined();

    await app.close();
  });
});
