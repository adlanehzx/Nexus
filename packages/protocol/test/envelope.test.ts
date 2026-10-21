import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, WsCloseCode, envelopeSchema } from "../src/envelope.js";
import { readinessResponseSchema, errorResponseSchema } from "../src/health.js";

const validEnvelope = {
  v: PROTOCOL_VERSION,
  id: "01J8Z2K3M4N5P6Q7R8S9T0",
  type: "agent.token",
  ts: "2026-09-01T10:00:00.123Z",
  seq: 42,
  channel: "run:01J8Z2K3M4",
  payload: { delta: "bonjour" },
};

describe("envelopeSchema", () => {
  it("accepte une enveloppe complète", () => {
    expect(envelopeSchema.parse(validEnvelope)).toMatchObject({ type: "agent.token", seq: 42 });
  });

  it("accepte une enveloppe sans seq ni channel", () => {
    const { seq: _seq, channel: _channel, ...minimal } = validEnvelope;
    expect(envelopeSchema.safeParse(minimal).success).toBe(true);
  });

  it("refuse une version de protocole différente", () => {
    // Le client doit être fermé avec 4400, pas recevoir des messages qu'il
    // interprétera de travers.
    expect(envelopeSchema.safeParse({ ...validEnvelope, v: 2 }).success).toBe(false);
  });

  it("refuse un horodatage qui n'est pas ISO 8601", () => {
    expect(envelopeSchema.safeParse({ ...validEnvelope, ts: "01/09/2026" }).success).toBe(false);
  });

  it("refuse un seq négatif", () => {
    expect(envelopeSchema.safeParse({ ...validEnvelope, seq: -1 }).success).toBe(false);
  });
});

describe("WsCloseCode", () => {
  it("reste dans la plage applicative 4000-4999", () => {
    for (const code of Object.values(WsCloseCode)) {
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThanOrEqual(4999);
    }
  });
});

describe("contrats de santé", () => {
  it("valide une réponse de readiness dégradée", () => {
    const parsed = readinessResponseSchema.parse({
      status: "degraded",
      version: "0.1.0",
      uptimeSeconds: 12,
      timestamp: "2026-09-01T10:00:00.000Z",
      dependencies: {
        database: { status: "up", latencyMs: 3 },
        redis: { status: "down", error: "ECONNREFUSED" },
      },
    });

    expect(parsed.dependencies.redis.status).toBe("down");
  });

  it("exige les deux dépendances", () => {
    const result = readinessResponseSchema.safeParse({
      status: "ok",
      version: "0.1.0",
      uptimeSeconds: 1,
      timestamp: "2026-09-01T10:00:00.000Z",
      dependencies: { database: { status: "up" } },
    });

    expect(result.success).toBe(false);
  });

  it("impose un correlationId dans toute réponse d'erreur", () => {
    const withoutId = {
      error: { code: "NOT_FOUND", message: "Resource not found.", retryable: false },
    };
    expect(errorResponseSchema.safeParse(withoutId).success).toBe(false);
  });
});
