import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { DeviceAuthenticationError, ReplayRejectedError } from "../src/errors.js";
import { DeviceSessionService, hashToken } from "../src/sessions.js";
import { NEXUS_EVENT_TYPES, nexusEventSchema, parseNexusEvent } from "@nexus/protocol";
import { DESKTOP, IPHONE, USER_ID, makeHarness, setupFleet } from "./fixtures.js";

/**
 * Device authentication, anti-replay, and session rotation.
 *
 * Core invariant: a device ID never authenticates itself. It is public metadata.
 * Proof of possession of the private key is required.
 */

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    signNonce: (nonce: string) =>
      sign(null, Buffer.from(nonce, "utf8"), privateKey).toString("base64"),
  };
}

function makeService(h: ReturnType<typeof makeHarness>) {
  return new DeviceSessionService({ registry: h.registry, now: () => h.clock.now });
}

describe("device authentication", () => {
  it("opens a session upon validly signed challenge", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const keys = makeKeyPair();
    const service = makeService(h);

    const challenge = await service.createChallenge(DESKTOP.id);
    const { session, token } = await service.authenticate(
      { deviceId: DESKTOP.id, nonce: challenge.nonce, signature: keys.signNonce(challenge.nonce) },
      keys.publicPem,
    );

    expect(session.deviceId).toBe(DESKTOP.id);
    expect(session.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(session)).not.toContain(token);
    expect((await h.registry.requireDevice(DESKTOP.id)).authenticated).toBe(true);
  });

  it("rejects an invalid signature", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const keys = makeKeyPair();
    const intruder = makeKeyPair();
    const service = makeService(h);

    const challenge = await service.createChallenge(DESKTOP.id);

    await expect(
      service.authenticate(
        {
          deviceId: DESKTOP.id,
          nonce: challenge.nonce,
          signature: intruder.signNonce(challenge.nonce),
        },
        keys.publicPem,
      ),
    ).rejects.toBeInstanceOf(DeviceAuthenticationError);
  });

  it("consumes nonce even when signature verification fails", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const keys = makeKeyPair();
    const service = makeService(h);

    const challenge = await service.createChallenge(DESKTOP.id);
    await service
      .authenticate(
        { deviceId: DESKTOP.id, nonce: challenge.nonce, signature: "invalid" },
        keys.publicPem,
      )
      .catch(() => undefined);

    await expect(
      service.authenticate(
        {
          deviceId: DESKTOP.id,
          nonce: challenge.nonce,
          signature: keys.signNonce(challenge.nonce),
        },
        keys.publicPem,
      ),
    ).rejects.toBeInstanceOf(ReplayRejectedError);
  });

  it("rejects an expired challenge", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const keys = makeKeyPair();
    const service = makeService(h);

    const challenge = await service.createChallenge(DESKTOP.id);
    h.clock.now = new Date(h.clock.now.getTime() + 120_000);

    await expect(
      service.authenticate(
        {
          deviceId: DESKTOP.id,
          nonce: challenge.nonce,
          signature: keys.signNonce(challenge.nonce),
        },
        keys.publicPem,
      ),
    ).rejects.toBeInstanceOf(ReplayRejectedError);
  });

  it("refuses to authenticate a revoked device", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    await h.registry.revokeDevice(DESKTOP.id);
    const service = makeService(h);

    await expect(service.createChallenge(DESKTOP.id)).rejects.toBeInstanceOf(
      DeviceAuthenticationError,
    );
  });

  it("refuses to authenticate an unapproved device", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [], trusted: [] });
    const keys = makeKeyPair();
    const service = makeService(h);

    const challenge = await service.createChallenge(DESKTOP.id);

    await expect(
      service.authenticate(
        {
          deviceId: DESKTOP.id,
          nonce: challenge.nonce,
          signature: keys.signNonce(challenge.nonce),
        },
        keys.publicPem,
      ),
    ).rejects.toBeInstanceOf(DeviceAuthenticationError);
  });

  it("bounds negotiated capabilities to registered capabilities", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const keys = makeKeyPair();
    const service = makeService(h);

    const challenge = await service.createChallenge(DESKTOP.id);
    const { session } = await service.authenticate(
      {
        deviceId: DESKTOP.id,
        nonce: challenge.nonce,
        signature: keys.signNonce(challenge.nonce),
        capabilities: ["terminal.execute", "android.notification"],
      },
      keys.publicPem,
    );

    expect(session.capabilities).toEqual(["terminal.execute"]);
  });
});

describe("sessions", () => {
  async function openSession(h: ReturnType<typeof makeHarness>) {
    const keys = makeKeyPair();
    const service = makeService(h);
    const challenge = await service.createChallenge(DESKTOP.id);
    const issued = await service.authenticate(
      { deviceId: DESKTOP.id, nonce: challenge.nonce, signature: keys.signNonce(challenge.nonce) },
      keys.publicPem,
    );
    return { service, issued };
  }

  it("resolves a valid token", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const { service, issued } = await openSession(h);

    expect(await service.resolve(issued.token)).toBeDefined();
    expect(await service.resolve("fabricated-token")).toBeUndefined();
  });

  it("invalidates expired token", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const { service, issued } = await openSession(h);

    h.clock.now = new Date(h.clock.now.getTime() + 31 * 60_000);
    expect(await service.resolve(issued.token)).toBeUndefined();
  });

  it("immediately invalidates active sessions for revoked devices", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const { service, issued } = await openSession(h);
    expect(await service.resolve(issued.token)).toBeDefined();

    await h.registry.revokeDevice(DESKTOP.id);

    expect(await service.resolve(issued.token)).toBeUndefined();
  });

  it("rotates token and invalidates predecessor", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const { service, issued } = await openSession(h);

    const rotated = await service.rotate(issued.token);

    expect(rotated.token).not.toBe(issued.token);
    expect(rotated.session.rotatedFromId).toBe(issued.session.id);
    expect(await service.resolve(issued.token)).toBeUndefined();
    expect(await service.resolve(rotated.token)).toBeDefined();
  });

  it("terminates all sessions for a device", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const { service, issued } = await openSession(h);

    expect(await service.revokeAllForDevice(DESKTOP.id)).toBe(1);
    expect(await service.resolve(issued.token)).toBeUndefined();
    expect((await h.registry.requireDevice(DESKTOP.id)).authenticated).toBe(false);
  });
});

describe("anti-replay", () => {
  it("rejects duplicate request IDs", () => {
    const h = makeHarness();
    const service = makeService(h);

    service.assertNotReplayed("req-1", h.clock.now);
    expect(() => service.assertNotReplayed("req-1", h.clock.now)).toThrow(ReplayRejectedError);
  });

  it("rejects timestamps outside tolerated drift window", () => {
    const h = makeHarness();
    const service = makeService(h);

    const stale = new Date(h.clock.now.getTime() - 5 * 60_000);
    expect(() => service.assertNotReplayed("req-2", stale)).toThrow(ReplayRejectedError);
  });

  it("compares tokens in constant time", () => {
    expect(DeviceSessionService.tokensMatch("abc", "abc")).toBe(true);
    expect(DeviceSessionService.tokensMatch("abc", "abd")).toBe(false);
    expect(DeviceSessionService.tokensMatch("abc", "abcd")).toBe(false);
  });
});

describe("event contract", () => {
  it("exposes all defined event families", () => {
    const families = new Set(NEXUS_EVENT_TYPES.map((t) => t.split(".")[0]));
    expect([...families].sort()).toEqual([
      "agent",
      "confirmation",
      "device",
      "notification",
      "task",
      "worker",
    ]);
  });

  it("validates well-formed events", () => {
    const event = nexusEventSchema.parse({
      v: 1,
      id: "evt-1",
      type: "task.started",
      at: "2026-09-02T10:00:00.000Z",
      userId: USER_ID,
      correlationId: "corr-1",
      originClientDeviceId: IPHONE.id,
      taskId: "task-1",
    });

    expect(event.type).toBe("task.started");
    expect(event.originClientDeviceId).toBe(IPHONE.id);
  });

  it("rejects differing schema versions", () => {
    const result = nexusEventSchema.safeParse({
      v: 2,
      id: "evt-1",
      type: "task.started",
      at: "2026-09-02T10:00:00.000Z",
      userId: USER_ID,
      correlationId: "c",
      originClientDeviceId: null,
      taskId: "t",
    });
    expect(result.success).toBe(false);
  });

  it("ignores unknown event types gracefully", () => {
    expect(
      parseNexusEvent({
        v: 1,
        id: "e",
        type: "future.unknown.event",
        at: "2026-09-02T10:00:00.000Z",
        userId: USER_ID,
        correlationId: "c",
        originClientDeviceId: null,
      }),
    ).toBeUndefined();
  });
});
