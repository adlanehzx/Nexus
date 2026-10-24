import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdvancedCollaborationCoordinator,
  FileCollaborationLedger,
  InMemoryCollaborationLedger,
  type CollaborationAgent,
  type CollaborationBoundaryError,
  type CollaborationLimits,
} from "../src/services/advanced-collaboration.js";

const permissions = [
  "collaboration.message",
  "collaboration.debate",
  "collaboration.vote",
  "collaboration.review",
  "collaboration.arbitrate",
  "collaboration.assign_role",
  "collaboration.revise_plan",
  "collaboration.bid",
];

const agents: CollaborationAgent[] = [
  { id: "planner", capabilities: ["planning"], permissions },
  { id: "reviewer", capabilities: ["security_review"], permissions },
  { id: "arbiter", capabilities: ["arbitration"], permissions },
];

const limits: CollaborationLimits = {
  maxHops: 4,
  maxTokens: 100,
  maxDurationMs: 60_000,
  maxRecursionDepth: 2,
  consensusThreshold: 2 / 3,
  mandatoryCrossReview: true,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function started(options?: { now?: () => Date; limits?: Partial<CollaborationLimits> }) {
  const coordinator = new AdvancedCollaborationCoordinator(
    new InMemoryCollaborationLedger(),
    options?.now,
  );
  const event = await coordinator.start({
    actorId: "planner",
    agents,
    limits: { ...limits, ...options?.limits },
  });
  return { coordinator, sessionId: event.sessionId };
}

describe("AdvancedCollaborationCoordinator", () => {
  it("terminates cycles and enforces hop, token, recursion, and wall-time budgets", async () => {
    const { coordinator, sessionId } = await started({
      limits: { maxHops: 1, maxTokens: 10, maxRecursionDepth: 0 },
    });
    const root = await coordinator.sendMessage(sessionId, {
      actorId: "planner",
      recipientId: "reviewer",
      tokenCount: 10,
      payloadType: "proposal",
      content: "Bounded proposal",
    });

    await expect(
      coordinator.sendMessage(sessionId, {
        actorId: "reviewer",
        recipientId: "planner",
        parentEventId: root.id,
        tokenCount: 1,
        payloadType: "answer",
        content: "Cycle",
      }),
    ).rejects.toMatchObject({ code: "cycle_detected" });
    await expect(
      coordinator.sendMessage(sessionId, {
        actorId: "reviewer",
        recipientId: "arbiter",
        tokenCount: 1,
        payloadType: "answer",
        content: "One hop too many",
      }),
    ).rejects.toMatchObject({ code: "hop_budget_exhausted" });

    let now = new Date("2026-10-24T09:00:00.000Z");
    const timed = await started({ now: () => now, limits: { maxDurationMs: 10 } });
    now = new Date("2026-10-24T09:00:00.011Z");
    await expect(timed.coordinator.replay(timed.sessionId)).rejects.toMatchObject({
      code: "time_budget_exhausted",
    });
  });

  it("records structured debates, independent review, typed votes, consensus, and arbitration", async () => {
    const { coordinator, sessionId } = await started();
    const debate = await coordinator.openDebate(sessionId, {
      actorId: "planner",
      debateId: "safety-debate",
      proposition: "The plan is safe to execute.",
      participantIds: ["planner", "reviewer", "arbiter"],
    });
    const plannerVote = await coordinator.castVote(sessionId, {
      actorId: "planner",
      debateId: "safety-debate",
      choice: "approve",
      rationale: "All preconditions passed.",
    });
    await coordinator.castVote(sessionId, {
      actorId: "reviewer",
      debateId: "safety-debate",
      choice: "approve",
      rationale: "Security controls are present.",
    });
    await expect(
      coordinator.recordConsensus(sessionId, { actorId: "arbiter", debateId: "safety-debate" }),
    ).rejects.toMatchObject({ code: "cross_review_required" });
    await coordinator.recordReview(sessionId, {
      actorId: "reviewer",
      subjectEventId: debate.id,
      decision: "approved",
      findings: ["No boundary violation found."],
    });
    const consensus = await coordinator.recordConsensus(sessionId, {
      actorId: "arbiter",
      debateId: "safety-debate",
    });
    const arbitration = await coordinator.arbitrate(sessionId, {
      actorId: "arbiter",
      debateId: "safety-debate",
      decision: "Proceed within declared limits.",
      evidenceEventIds: [debate.id, plannerVote.id, consensus.id],
    });

    expect(consensus.data).toMatchObject({ outcome: "approved", approvalRatio: 2 / 3 });
    expect(arbitration.actorId).toBe("arbiter");
    expect(await coordinator.replay(sessionId)).toHaveLength(7);
  });

  it("constrains roles, persists ordered plan revisions, and accepts virtual scores only", async () => {
    const { coordinator, sessionId } = await started();
    await expect(
      coordinator.assignRole(sessionId, {
        actorId: "planner",
        agentId: "planner",
        role: "security_reviewer",
        requiredCapabilities: ["security_review"],
        requiredPermissions: ["collaboration.review"],
      }),
    ).rejects.toMatchObject({ code: "capability_denied" });
    await coordinator.assignRole(sessionId, {
      actorId: "planner",
      agentId: "reviewer",
      role: "security_reviewer",
      requiredCapabilities: ["security_review"],
      requiredPermissions: ["collaboration.review"],
    });
    const revision = await coordinator.revisePlan(sessionId, {
      actorId: "planner",
      previousRevision: 0,
      operations: [{ operation: "add", taskKey: "threat_model", instruction: "Review threats." }],
      reason: "Cross-review is mandatory.",
    });
    await expect(
      coordinator.revisePlan(sessionId, {
        actorId: "planner",
        previousRevision: 0,
        operations: [{ operation: "remove", taskKey: "threat_model" }],
        reason: "Stale writer.",
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });
    const bid = await coordinator.placeBid(sessionId, {
      actorId: "reviewer",
      taskKey: "threat_model",
      virtualScore: 87,
      rationale: "Capability match.",
    });

    expect(revision.data.revision).toBe(1);
    expect(bid.data).toEqual({
      taskKey: "threat_model",
      virtualScore: 87,
      rationale: "Capability match.",
    });
    await expect(
      coordinator.placeBid(sessionId, {
        actorId: "reviewer",
        taskKey: "threat_model",
        virtualScore: 101,
        rationale: "Invalid score.",
      }),
    ).rejects.toBeDefined();
  });

  it("replays every attributable event after restart and fails closed on ledger corruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-collaboration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new AdvancedCollaborationCoordinator(new FileCollaborationLedger(path));
    const startedEvent = await first.start({ actorId: "planner", agents, limits });
    await first.sendMessage(startedEvent.sessionId, {
      actorId: "planner",
      recipientId: "reviewer",
      tokenCount: 4,
      payloadType: "question",
      content: "Review this plan.",
    });

    const restarted = new AdvancedCollaborationCoordinator(new FileCollaborationLedger(path));
    const replay = await restarted.replay(startedEvent.sessionId);
    expect(replay.map((event) => event.sequence)).toEqual([1, 2]);
    expect(replay.every((event) => event.actorId.length > 0)).toBe(true);
    expect((await readFile(path, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);

    const corruptPath = join(directory, "corrupt.jsonl");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(corruptPath, '{"not":"an event"}\n', { mode: 0o600 }),
    );
    const corrupt = new AdvancedCollaborationCoordinator(new FileCollaborationLedger(corruptPath));
    await expect(corrupt.replay(startedEvent.sessionId)).rejects.toBeDefined();
  });

  it("rejects actors without explicit permissions", async () => {
    const coordinator = new AdvancedCollaborationCoordinator(new InMemoryCollaborationLedger());
    const start = await coordinator.start({
      actorId: "planner",
      agents: [agents[0]!, { id: "guest", capabilities: [], permissions: [] }],
      limits,
    });
    await expect(
      coordinator.sendMessage(start.sessionId, {
        actorId: "guest",
        recipientId: "planner",
        tokenCount: 1,
        payloadType: "question",
        content: "Not authorized.",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CollaborationBoundaryError>>({ code: "permission_denied" }),
    );
  });
});
