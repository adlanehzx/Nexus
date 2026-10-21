import { describe, expect, it } from "vitest";
import { TokenService, generateSigningKeyPair } from "@nexus/auth";
import {
  InMemoryMissionGrantRegistry,
  MissionGrantService,
} from "../src/services/mission-grants.js";
import {
  InMemoryScheduleGrantRegistry,
  ScheduleGrantService,
  scheduledExternalKey,
} from "../src/services/schedule-grants.js";
import { createAccount, makeApi } from "./harness.js";

const keys = generateSigningKeyPair();
const USER = "11111111-1111-4111-8111-111111111111";
const SCHEDULE = "22222222-2222-4222-8222-222222222222";
const BASE = "nexus-owner-schedule-watch";
const DUE = "2030-01-01T07:00:00+00:00";

function build(active = true) {
  const tokens = new TokenService({ privateKeyPem: keys.privateKeyPem });
  const missions = new MissionGrantService({
    signer: tokens,
    registry: new InMemoryMissionGrantRegistry(),
  });
  const schedules = new ScheduleGrantService({
    registry: new InMemoryScheduleGrantRegistry(),
    missions,
    isUserActive: () => Promise.resolve(active),
  });
  return { tokens, missions, schedules };
}

describe("délégations de calendrier", () => {
  it("émet une assertion courte pour l'occurrence exacte", async () => {
    const { tokens, schedules } = build();
    const delegated = await schedules.issue({
      userId: USER,
      missionExternalKey: BASE,
      scheduleId: SCHEDULE,
    });
    const missionExternalKey = scheduledExternalKey(BASE, SCHEDULE, DUE);

    const exchanged = await schedules.exchange({
      token: delegated.token,
      scheduleId: SCHEDULE,
      scheduledFor: DUE,
      missionExternalKey,
    });

    expect(exchanged.owner.userId).toBe(USER);
    expect(tokens.verifyMissionGrant(exchanged.token)).toMatchObject({
      sub: USER,
      svc: "mission-engine",
      mek: missionExternalKey,
    });
  });

  it("expose l'échange HTTP sans accepter une session utilisateur à sa place", async () => {
    const harness = await makeApi();
    try {
      const account = await createAccount(harness, "schedule-grant@example.org");
      const delegated = await harness.services.scheduleGrants.issue({
        userId: account.userId,
        missionExternalKey: BASE,
        scheduleId: SCHEDULE,
      });
      const missionExternalKey = scheduledExternalKey(BASE, SCHEDULE, DUE);
      const exchanged = await harness.app.inject({
        method: "POST",
        url: "/api/v1/agent-core/schedule-grants/exchange",
        headers: { authorization: `Bearer ${delegated.token}` },
        payload: {
          scheduleId: SCHEDULE,
          scheduledFor: DUE,
          missionExternalKey,
        },
      });
      expect(exchanged.statusCode).toBe(200);
      expect(exchanged.body).not.toContain(delegated.token);

      const userToken = await harness.app.inject({
        method: "POST",
        url: "/api/v1/agent-core/schedule-grants/exchange",
        headers: account.authorization,
        payload: { scheduleId: SCHEDULE, scheduledFor: DUE, missionExternalKey },
      });
      expect(userToken.statusCode).toBe(401);
    } finally {
      await harness.close();
    }
  });

  it("refuse un autre calendrier ou une occurrence forgée", async () => {
    const { schedules } = build();
    const delegated = await schedules.issue({
      userId: USER,
      missionExternalKey: BASE,
      scheduleId: SCHEDULE,
    });
    await expect(
      schedules.exchange({
        token: delegated.token,
        scheduleId: "33333333-3333-4333-8333-333333333333",
        scheduledFor: DUE,
        missionExternalKey: "nexus-forged",
      }),
    ).rejects.toThrow(/autre calendrier/i);
    await expect(
      schedules.exchange({
        token: delegated.token,
        scheduleId: SCHEDULE,
        scheduledFor: DUE,
        missionExternalKey: "nexus-forged",
      }),
    ).rejects.toThrow(/ne couvre pas/i);
  });

  it("refuse immédiatement une délégation retirée ou un compte inactif", async () => {
    const active = build();
    const delegated = await active.schedules.issue({
      userId: USER,
      missionExternalKey: BASE,
      scheduleId: SCHEDULE,
    });
    await active.schedules.revoke(delegated.id);
    await expect(
      active.schedules.exchange({
        token: delegated.token,
        scheduleId: SCHEDULE,
        scheduledFor: DUE,
        missionExternalKey: scheduledExternalKey(BASE, SCHEDULE, DUE),
      }),
    ).rejects.toThrow(/retirée/i);

    const inactive = build(false);
    const blocked = await inactive.schedules.issue({
      userId: USER,
      missionExternalKey: BASE,
      scheduleId: SCHEDULE,
    });
    await expect(
      inactive.schedules.exchange({
        token: blocked.token,
        scheduleId: SCHEDULE,
        scheduledFor: DUE,
        missionExternalKey: scheduledExternalKey(BASE, SCHEDULE, DUE),
      }),
    ).rejects.toThrow(/inactif/i);
  });
});
