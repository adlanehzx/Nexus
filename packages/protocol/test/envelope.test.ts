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
  payload: { delta: "hello" },
};

describe("envelopeSchema", () => {
  it("accepts a complete envelope", () => {
    expect(envelopeSchema.parse(validEnvelope)).toMatchObject({ type: "agent.token", seq: 42 });
  });

  it("accepts an envelope without seq or channel", () => {
    const { seq: _seq, channel: _channel, ...minimal } = validEnvelope;
    expect(envelopeSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects differing protocol version", () => {
    expect(envelopeSchema.safeParse({ ...validEnvelope, v: 2 }).success).toBe(false);
  });

  it("rejects non-ISO 8601 timestamps", () => {
    expect(envelopeSchema.safeParse({ ...validEnvelope, ts: "01/09/2026" }).success).toBe(false);
  });

  it("rejects negative seq values", () => {
    expect(envelopeSchema.safeParse({ ...validEnvelope, seq: -1 }).success).toBe(false);
  });
});

describe("WsCloseCode", () => {
  it("falls within application-reserved 4000-4999 range", () => {
    for (const code of Object.values(WsCloseCode)) {
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThanOrEqual(4999);
    }
  });
});

describe("health probe contracts", () => {
  it("validates degraded readiness response", () => {
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

  it("requires all declared dependencies", () => {
    const result = readinessResponseSchema.safeParse({
      status: "ok",
      version: "0.1.0",
      uptimeSeconds: 1,
      timestamp: "2026-09-01T10:00:00.000Z",
      dependencies: { database: { status: "up" } },
    });

    expect(result.success).toBe(false);
  });

  it("enforces correlationId presence on error responses", () => {
    const withoutId = {
      error: { code: "NOT_FOUND", message: "Resource not found.", retryable: false },
    };
    expect(errorResponseSchema.safeParse(withoutId).success).toBe(false);
  });
});
