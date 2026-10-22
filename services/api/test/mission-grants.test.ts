import { describe, expect, it } from "vitest";
import { TokenService, generateSigningKeyPair } from "@nexus/auth";
import {
  InMemoryMissionGrantRegistry,
  MissionGrantService,
} from "../src/services/mission-grants.js";

/**
 * Mission grant assertion lifecycle.
 *
 * Driven by an injected clock to test expiration and renewal deterministically.
 */

const keys = generateSigningKeyPair();
const HOUR = 60 * 60 * 1000;

function build(options: { renewWithinMs?: number } = {}) {
  let instant = new Date("2026-10-20T08:00:00.000Z");
  const now = () => instant;
  const registry = new InMemoryMissionGrantRegistry();
  const service = new MissionGrantService({
    signer: new TokenService({ privateKeyPem: keys.privateKeyPem, now }),
    registry,
    now,
    ...(options.renewWithinMs === undefined ? {} : { renewWithinMs: options.renewWithinMs }),
  });
  const verifier = new TokenService({ privateKeyPem: keys.privateKeyPem, now });

  return {
    service,
    registry,
    verifier,
    advance: (ms: number) => {
      instant = new Date(instant.getTime() + ms);
    },
  };
}

const SCOPE = {
  userId: "11111111-1111-7111-8111-111111111111",
  service: "mission-engine",
  missionExternalKey: "nexus-mission-grants",
};

describe("issuance and registry", () => {
  it("records every issued assertion", async () => {
    const { service, registry } = build();
    const granted = await service.issue(SCOPE);

    const recorded = await registry.find(granted.grantId);
    expect(recorded?.status).toBe("ACTIVE");
    expect(recorded?.missionExternalKey).toBe(SCOPE.missionExternalKey);
    expect(recorded?.expiresAt).toEqual(granted.expiresAt);
  });

  it("rejects signed assertion missing from registry", async () => {
    const { service, verifier } = build();
    const orphan = verifier.issueMissionGrant(SCOPE);

    await expect(service.assertUsable(verifier.verifyMissionGrant(orphan.token))).rejects.toThrow(
      /registry/i,
    );
  });

  it("accepts an active assertion", async () => {
    const { service, verifier } = build();
    const granted = await service.issue(SCOPE);

    const claims = verifier.verifyMissionGrant(granted.token);
    await expect(service.assertUsable(claims)).resolves.toMatchObject({
      status: "ACTIVE",
      userId: SCOPE.userId,
    });
  });
});

describe("retirement", () => {
  it("rejects retired assertion while signature remains valid", async () => {
    const { service, verifier } = build();
    const granted = await service.issue(SCOPE);
    const claims = verifier.verifyMissionGrant(granted.token);

    expect(await service.retire(SCOPE.missionExternalKey)).toBe(1);

    await expect(service.assertUsable(claims)).rejects.toThrow(/revoked/i);
  });

  it("retires all assertions of a mission, not only the last one", async () => {
    const { service, verifier, advance } = build({ renewWithinMs: 20 * HOUR });
    const first = await service.issue(SCOPE);
    advance(5 * HOUR);
    const rotated = await service.renewById(first.grantId);
    expect(rotated).toBeDefined();

    expect(await service.retire(SCOPE.missionExternalKey)).toBe(2);
    for (const token of [first.token, rotated!.token]) {
      await expect(service.assertUsable(verifier.verifyMissionGrant(token))).rejects.toThrow(
        /revoked/i,
      );
    }
  });

  it("distinguishes mission end from incident revocation", async () => {
    const { service } = build();
    await service.issue(SCOPE);
    await service.retire(SCOPE.missionExternalKey, "REVOKED");

    const grants = await service.listByMission(SCOPE.missionExternalKey);
    expect(grants[0]?.status).toBe("REVOKED");
    expect(grants[0]?.retiredAt).not.toBeNull();
  });

  it("is idempotent and does not shift retirement date", async () => {
    const { service, advance } = build();
    await service.issue(SCOPE);
    expect(await service.retire(SCOPE.missionExternalKey)).toBe(1);
    const first = (await service.listByMission(SCOPE.missionExternalKey))[0]?.retiredAt;

    advance(HOUR);
    expect(await service.retire(SCOPE.missionExternalKey)).toBe(0);
    expect((await service.listByMission(SCOPE.missionExternalKey))[0]?.retiredAt).toEqual(first);
  });
});

describe("expiration and rotation", () => {
  it("rejects assertion expired according to registry", async () => {
    const { service, verifier, advance } = build();
    const granted = await service.issue(SCOPE);
    const claims = verifier.verifyMissionGrant(granted.token);

    advance(25 * HOUR);
    await expect(service.assertUsable(claims)).rejects.toThrow(/expired/i);
  });

  it("does not renew an assertion far from expiry", async () => {
    const { service, advance } = build({ renewWithinMs: 8 * HOUR });
    const granted = await service.issue(SCOPE);

    advance(2 * HOUR);
    expect(await service.renewById(granted.grantId)).toBeUndefined();
  });

  it("renews within window and new assertion is usable", async () => {
    const { service, verifier, advance } = build({ renewWithinMs: 8 * HOUR });
    const granted = await service.issue(SCOPE);

    advance(17 * HOUR);
    const renewed = await service.renewById(granted.grantId);
    expect(renewed).toBeDefined();
    expect(renewed!.grantId).not.toBe(granted.grantId);
    expect(renewed!.expiresAt.getTime()).toBeGreaterThan(granted.expiresAt.getTime());

    await expect(
      service.assertUsable(verifier.verifyMissionGrant(renewed!.token)),
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("lets legacy assertion live until its expiry", async () => {
    const { service, verifier, advance } = build({ renewWithinMs: 8 * HOUR });
    const granted = await service.issue(SCOPE);
    const claims = verifier.verifyMissionGrant(granted.token);

    advance(17 * HOUR);
    await service.renewById(granted.grantId);

    await expect(service.assertUsable(claims)).resolves.toMatchObject({
      status: "ACTIVE",
    });
  });

  it("covers mission longer than assertion lifetime", async () => {
    const { service, verifier, advance } = build({ renewWithinMs: 8 * HOUR });
    let current = await service.issue(SCOPE);

    for (let elapsed = 0; elapsed < 72; elapsed += 6) {
      advance(6 * HOUR);
      const claims = verifier.verifyMissionGrant(current.token);
      await expect(service.assertUsable(claims)).resolves.toBeDefined();
      const renewed = await service.renewById(current.grantId);
      if (renewed !== undefined) current = renewed;
    }
  });

  it("does not renew an assertion already retired", async () => {
    const { service, advance } = build({ renewWithinMs: 8 * HOUR });
    const granted = await service.issue(SCOPE);
    await service.retire(SCOPE.missionExternalKey);

    advance(17 * HOUR);
    expect(await service.renewById(granted.grantId)).toBeUndefined();
  });
});
