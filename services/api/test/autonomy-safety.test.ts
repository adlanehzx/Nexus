import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AutonomySafetyController,
  AutonomySafetyStore,
  signFederation,
} from "../src/services/autonomy-safety.js";

let clock: Date;
let path: string;
let key: Uint8Array;
let controller: AutonomySafetyController;
const artifactHash = createHash("sha256").update("diff").digest("hex");

beforeEach(async () => {
  clock = new Date("2026-10-25T08:00:00Z");
  path = join(await mkdtemp(join(tmpdir(), "nexus-autonomy-")), "safety.json");
  key = new Uint8Array(32).fill(9);
  controller = new AutonomySafetyController({
    store: new AutonomySafetyStore(path),
    peerKeys: new Map([["private-peer", key]]),
    now: () => clock,
    federationLimit: 2,
  });
});

describe("proposal-only autonomy", () => {
  it("persists code proposals but exposes no execution or mutation primitive", async () => {
    const { proposal } = await controller.propose({
      kind: "CODE_CHANGE",
      title: "Improve retry policy",
      artifactHash,
      proposerId: "agent",
    });
    expect(proposal.status).toBe("PENDING");
    const restarted = new AutonomySafetyController({
      store: new AutonomySafetyStore(path),
      now: () => clock,
    });
    expect((await restarted.snapshot()).proposals[0]?.artifactHash).toBe(artifactHash);
    expect("execute" in controller).toBe(false);
    expect("apply" in controller).toBe(false);
    expect("purchase" in controller).toBe(false);
    expect("deploy" in controller).toBe(false);
  });

  it("requires independent, unexpired confirmation for a non-production deployment proposal", async () => {
    const created = await controller.propose({
      kind: "DEPLOYMENT",
      title: "Stage release",
      artifactHash,
      environment: "staging",
      proposerId: "agent",
    });
    await expect(
      controller.decide(created.proposal.id, "agent", "APPROVE", created.confirmationToken!),
    ).rejects.toThrow("Independent");
    await expect(
      controller.decide(created.proposal.id, "human", "APPROVE", "wrong"),
    ).rejects.toThrow("invalid");
    expect(
      (await controller.decide(created.proposal.id, "human", "APPROVE", created.confirmationToken!))
        .status,
    ).toBe("APPROVED");
  });

  it("rejects money, production, commands, and unknown fields structurally", async () => {
    await expect(
      controller.propose({
        kind: "DEPLOYMENT",
        title: "Prod",
        artifactHash,
        environment: "production",
        proposerId: "agent",
      } as never),
    ).rejects.toThrow();
    await expect(
      controller.propose({
        kind: "CODE_CHANGE",
        title: "Buy",
        artifactHash,
        proposerId: "agent",
        amount: 10,
        currency: "EUR",
        command: "curl",
      } as never),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8").catch(() => "")).not.toMatch(/amount|currency|command/);
  });
});

describe("private federation and permanent agents", () => {
  const envelope = (nonce: string, peerId = "private-peer") => {
    const unsigned = {
      peerId,
      nonce,
      issuedAt: clock.toISOString(),
      kind: "STATUS" as const,
      payloadHash: createHash("sha256").update("status").digest("hex"),
    };
    return { ...unsigned, signature: signFederation(unsigned, key) };
  };

  it("requires allowlisting and signatures, rejects replay, and rate limits", async () => {
    await expect(
      controller.acceptFederation(envelope("nonce-000000000001", "unknown")),
    ).rejects.toThrow("allowlisted");
    await expect(
      controller.acceptFederation({ ...envelope("nonce-000000000001"), signature: "0".repeat(64) }),
    ).rejects.toThrow("signature");
    await controller.acceptFederation(envelope("nonce-000000000001"));
    await expect(controller.acceptFederation(envelope("nonce-000000000001"))).rejects.toThrow(
      "replay",
    );
    await controller.acceptFederation(envelope("nonce-000000000002"));
    await expect(controller.acceptFederation(envelope("nonce-000000000003"))).rejects.toThrow(
      "rate limit",
    );
  });

  it("starts permanent agents paused and enforces supervision, budget and emergency stop after restart", async () => {
    await controller.registerPermanentAgent({
      agentId: "agent-1",
      supervisorId: "human",
      budgetUnits: 5,
    });
    await expect(controller.consumeBudget("agent-1", 1)).rejects.toThrow("not allowed");
    await expect(controller.setAgentPaused("agent-1", "stranger", false)).rejects.toThrow(
      "unavailable",
    );
    await controller.setAgentPaused("agent-1", "human", false);
    expect((await controller.consumeBudget("agent-1", 3)).consumedUnits).toBe(3);
    await expect(controller.consumeBudget("agent-1", 3)).rejects.toThrow("exhausted");
    const restarted = new AutonomySafetyController({
      store: new AutonomySafetyStore(path),
      now: () => clock,
    });
    expect((await restarted.snapshot()).agents[0]?.paused).toBe(true);
    const stopped = await restarted.emergencyStop("agent-1", "human");
    expect(stopped).toMatchObject({ paused: true, emergencyStopped: true });
    await expect(restarted.setAgentPaused("agent-1", "human", false)).rejects.toThrow(
      "cannot resume",
    );
  });
});
