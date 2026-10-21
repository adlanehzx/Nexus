import { describe, expect, it } from "vitest";
import {
  TokenService,
  generateSigningKeyPair,
  hashPassword,
  needsRehash,
  verifyPassword,
  assertPasswordAcceptable,
} from "../src/index.js";

/**
 * Tokens and passwords.
 *
 * Both areas fail silently: ill-verified tokens admit attackers,
 * poorly-hashed passwords leak credentials. Tests test rejection as strictly as acceptance.
 */

const keys = generateSigningKeyPair();

function makeService(now = () => new Date("2026-09-02T10:00:00.000Z")) {
  return new TokenService({ privateKeyPem: keys.privateKeyPem, now });
}

describe("access tokens", () => {
  it("issues a token readable by the service", () => {
    const service = makeService();
    const { token } = service.issueAccessToken({ userId: "u1", sessionId: "s1" });

    expect(service.verifyAccessToken(token)).toMatchObject({ sub: "u1", sid: "s1" });
  });

  it("rejects token signed by another key", () => {
    const other = new TokenService({ privateKeyPem: generateSigningKeyPair().privateKeyPem });
    const { token } = other.issueAccessToken({ userId: "u1", sessionId: "s1" });

    expect(() => makeService().verifyAccessToken(token)).toThrow(
      expect.objectContaining({ code: "TOKEN_INVALID" }),
    );
  });

  it("rejects token whose payload has been tampered with", () => {
    const service = makeService();
    const { token } = service.issueAccessToken({ userId: "u1", sessionId: "s1" });

    const [header, , signature] = token.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ sub: "admin", sid: "s1" })).toString("base64url");

    expect(() => service.verifyAccessToken(`${header}.${forged}.${signature}`)).toThrow(
      expect.objectContaining({ code: "TOKEN_INVALID" }),
    );
  });

  it("rejects header declaring another algorithm", () => {
    const service = makeService();
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "admin" })).toString("base64url");

    expect(() => service.verifyAccessToken(`${header}.${payload}.`)).toThrow(
      expect.objectContaining({ code: "TOKEN_INVALID" }),
    );
  });

  it("distinguishes expired token from invalid token", () => {
    let now = new Date("2026-09-02T10:00:00.000Z");
    const service = new TokenService({
      privateKeyPem: keys.privateKeyPem,
      accessTtlSeconds: 60,
      now: () => now,
    });

    const { token } = service.issueAccessToken({ userId: "u1", sessionId: "s1" });
    now = new Date("2026-09-02T10:05:00.000Z");

    expect(() => service.verifyAccessToken(token)).toThrow(
      expect.objectContaining({ code: "TOKEN_EXPIRED", retryable: true }),
    );
  });

  it("rejects input that is not a valid token format", () => {
    const service = makeService();
    for (const invalid of ["", "abc", "a.b", "a.b.c.d"]) {
      expect(() => service.verifyAccessToken(invalid)).toThrow(
        expect.objectContaining({ code: "TOKEN_INVALID" }),
      );
    }
  });

  it("rejects device token presented as access token", () => {
    const service = makeService();
    const { token } = service.issueDeviceToken({
      deviceId: "d1",
      userId: "u1",
      capabilities: ["terminal.execute"],
    });

    expect(() => service.verifyAccessToken(token)).toThrow(
      expect.objectContaining({ code: "TOKEN_INVALID" }),
    );
  });

  it("rejects access token presented as device token", () => {
    const service = makeService();
    const { token } = service.issueAccessToken({ userId: "u1", sessionId: "s1" });

    expect(() => service.verifyDeviceToken(token)).toThrow(
      expect.objectContaining({ code: "TOKEN_INVALID" }),
    );
  });

  it("rejects unexpected issuer or audience", () => {
    const foreign = new TokenService({
      privateKeyPem: keys.privateKeyPem,
      issuer: "other",
    });
    const { token } = foreign.issueAccessToken({ userId: "u1", sessionId: "s1" });

    expect(() => makeService().verifyAccessToken(token)).toThrow(
      expect.objectContaining({ code: "TOKEN_INVALID" }),
    );
  });

  it("exposes public key that verifies without ability to issue", () => {
    const service = makeService();
    expect(service.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(service.publicKeyPem).not.toContain("PRIVATE");
  });

  it("carries negotiated capabilities in device token", () => {
    const service = makeService();
    const { token } = service.issueDeviceToken({
      deviceId: "d1",
      userId: "u1",
      capabilities: ["filesystem.read"],
    });

    expect(service.verifyDeviceToken(token)).toMatchObject({
      sub: "d1",
      userId: "u1",
      capabilities: ["filesystem.read"],
    });
  });
});

describe("mission grant assertions", () => {
  it("issues grant readable by service and bound to mission", () => {
    const service = makeService();
    const { token, grantId } = service.issueMissionGrant({
      userId: "u1",
      service: "mission-engine",
      missionExternalKey: "nexus-abc-1",
    });

    expect(service.verifyMissionGrant(token)).toMatchObject({
      sub: "u1",
      svc: "mission-engine",
      mek: "nexus-abc-1",
      aud: "nexus-mission-grant",
      jti: grantId,
    });
  });

  it("rejects grant presented as access token", () => {
    const service = makeService();
    const { token } = service.issueMissionGrant({
      userId: "u1",
      service: "mission-engine",
      missionExternalKey: "nexus-abc-1",
    });

    expect(() => service.verifyAccessToken(token)).toThrow(/audience|claims/i);
  });

  it("rejects access token presented as mission grant", () => {
    const service = makeService();
    const { token } = service.issueAccessToken({ userId: "u1", sessionId: "s1" });

    expect(() => service.verifyMissionGrant(token)).toThrow(/mission claims/i);
  });

  it("rejects grant signed by another key", () => {
    const foreign = new TokenService({ privateKeyPem: generateSigningKeyPair().privateKeyPem });
    const { token } = foreign.issueMissionGrant({
      userId: "u1",
      service: "mission-engine",
      missionExternalKey: "nexus-abc-1",
    });

    expect(() => makeService().verifyMissionGrant(token)).toThrow();
  });

  it("expires grant upon ttl expiration", () => {
    let instant = new Date("2026-09-02T10:00:00.000Z");
    const service = new TokenService({
      privateKeyPem: keys.privateKeyPem,
      missionGrantTtlSeconds: 60,
      now: () => instant,
    });
    const { token } = service.issueMissionGrant({
      userId: "u1",
      service: "mission-engine",
      missionExternalKey: "nexus-abc-1",
    });

    expect(service.verifyMissionGrant(token)).toMatchObject({ sub: "u1" });
    instant = new Date("2026-09-02T10:01:01.000Z");
    expect(() => service.verifyMissionGrant(token)).toThrow(/expir/i);
  });

  it("binds grant to single mission", () => {
    const service = makeService();
    const first = service.issueMissionGrant({
      userId: "u1",
      service: "mission-engine",
      missionExternalKey: "nexus-abc-1",
    });
    const second = service.issueMissionGrant({
      userId: "u1",
      service: "mission-engine",
      missionExternalKey: "nexus-abc-2",
    });

    expect(service.verifyMissionGrant(first.token).mek).toBe("nexus-abc-1");
    expect(service.verifyMissionGrant(second.token).mek).toBe("nexus-abc-2");
    expect(first.grantId).not.toBe(second.grantId);
  });
});

describe("passwords", { timeout: 30_000 }, () => {
  it("verifies correct password", async () => {
    const encoded = await hashPassword("a valid secure password");
    await expect(verifyPassword("a valid secure password", encoded)).resolves.toBe(true);
  });

  it("rejects incorrect password", async () => {
    const encoded = await hashPassword("a valid secure password");
    await expect(verifyPassword("another password", encoded)).resolves.toBe(false);
  });

  it("produces distinct hashes each invocation", async () => {
    const a = await hashPassword("the exact same password");
    const b = await hashPassword("the exact same password");
    expect(a).not.toBe(b);
  });

  it("records parameters within the hash", async () => {
    const encoded = await hashPassword("a valid secure password");
    expect(encoded.split("$").slice(0, 4)).toEqual(["scrypt", "65536", "8", "1"]);
  });

  it("rejects passwords shorter than 12 characters", () => {
    expect(() => assertPasswordAcceptable("short")).toThrow(
      expect.objectContaining({ code: "PASSWORD_TOO_WEAK" }),
    );
  });

  it("rejects excessively long passwords without leaking them into errors", () => {
    const long = "x".repeat(2_000);
    let caught: { context?: Record<string, unknown> } | undefined;
    try {
      assertPasswordAcceptable(long);
    } catch (cause) {
      caught = cause as { context?: Record<string, unknown> };
    }

    expect(JSON.stringify(caught?.context)).not.toContain("xxxx");
  });

  it("returns false on corrupted hash instead of throwing", async () => {
    for (const broken of ["", "notvalid", "scrypt$x$y$z$a$b", "bcrypt$1$2$3$4$5"]) {
      await expect(verifyPassword("a valid secure password", broken)).resolves.toBe(false);
    }
  });

  it("rejects hash declaring unreasonable parameters", async () => {
    const absurd = `scrypt$${String(1 << 25)}$8$1$c2VsCg$Y2xlCg`;
    await expect(verifyPassword("a valid secure password", absurd)).resolves.toBe(false);
  });

  it("flags outdated hashes for rehash", async () => {
    expect(needsRehash(`scrypt$16384$8$1$c2VsCg$Y2xlCg`)).toBe(true);
    expect(needsRehash(await hashPassword("a valid secure password"))).toBe(false);
  });
});

describe("service tokens", () => {
  it("issues service token readable for target audience", () => {
    const service = makeService();
    const { token } = service.issueServiceToken({
      service: "nexus-api",
      audience: "nexus-mission-engine",
    });

    expect(service.verifyServiceToken(token, "nexus-mission-engine")).toMatchObject({
      sub: "nexus-api",
      aud: "nexus-mission-engine",
    });
  });

  it("rejects service token presented for another audience", () => {
    const service = makeService();
    const { token } = service.issueServiceToken({
      service: "nexus-api",
      audience: "nexus-mission-engine",
    });

    expect(() => service.verifyServiceToken(token, "nexus-other-service")).toThrow(/audience/i);
  });

  it("cannot be used as access token or mission grant", () => {
    const service = makeService();
    const { token } = service.issueServiceToken({
      service: "nexus-api",
      audience: "nexus-mission-engine",
    });

    expect(() => service.verifyAccessToken(token)).toThrow();
    expect(() => service.verifyMissionGrant(token)).toThrow();
  });

  it("rejects mission grant presented as service token", () => {
    const service = makeService();
    const { token } = service.issueMissionGrant({
      userId: "u1",
      service: "mission-engine",
      missionExternalKey: "nexus-abc-1",
    });

    expect(() => service.verifyServiceToken(token, "nexus-mission-engine")).toThrow();
  });

  it("expires in minutes rather than hours", () => {
    let instant = new Date("2026-09-02T10:00:00.000Z");
    const service = new TokenService({
      privateKeyPem: keys.privateKeyPem,
      serviceTtlSeconds: 120,
      now: () => instant,
    });
    const { token } = service.issueServiceToken({
      service: "nexus-api",
      audience: "nexus-mission-engine",
    });

    instant = new Date("2026-09-02T10:01:00.000Z");
    expect(service.verifyServiceToken(token, "nexus-mission-engine")).toBeDefined();
    instant = new Date("2026-09-02T10:03:00.000Z");
    expect(() => service.verifyServiceToken(token, "nexus-mission-engine")).toThrow(/expir/i);
  });

  it("rejects token signed by another key", () => {
    const foreign = new TokenService({ privateKeyPem: generateSigningKeyPair().privateKeyPem });
    const { token } = foreign.issueServiceToken({
      service: "nexus-api",
      audience: "nexus-mission-engine",
    });

    expect(() => makeService().verifyServiceToken(token, "nexus-mission-engine")).toThrow();
  });
});
