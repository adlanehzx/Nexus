import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionControlPort } from "@nexus/mission-control-client";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";
import { missionOwnerPrefix } from "../src/services/acp-orchestrator.js";

const missionId = "44444444-4444-4444-8444-444444444444";

describe("Inter-Agent Collaboration Endpoints", () => {
  let harness: ApiHarness;
  let account: Account;
  let workspaceDir: string;
  let ownerExternalKey = "unassigned";

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "nexus-collab-workspace-"));

    const engine = {
      health: vi.fn().mockResolvedValue({
        status: "ready" as const,
        worker_enabled: true,
        worker_concurrency: 2,
        profiles: ["antigravity", "claude", "codex"],
      }),
      settings: vi.fn().mockResolvedValue({
        task_timeout_seconds: 1800,
        max_attempts: 3,
        retry_delay_seconds: 10,
        context_budget_chars: 60000,
        quality_review: true,
        research_priority: ["antigravity", "claude", "codex"],
        review_priority: ["claude", "codex", "antigravity"],
        synthesis_priority: ["claude", "antigravity", "codex"],
      }),
      updateSettings: vi.fn(),
      submitMission: vi.fn().mockResolvedValue({ mission_id: missionId, replayed: false }),
      getMission: vi.fn().mockImplementation(() =>
        Promise.resolve({
          id: missionId,
          external_key: ownerExternalKey,
          title: "Mission with collaboration",
          workspace: workspaceDir,
          state: "succeeded",
          created_at: "2026-10-20T20:00:00+00:00",
          updated_at: "2026-10-20T20:05:00+00:00",
          tasks: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              mission_id: missionId,
              task_key: "investigate",
              ordinal: 1,
              profile_key: "antigravity",
              state: "succeeded",
              result_json: JSON.stringify({
                response: JSON.stringify({
                  summary: "Architecture validated with no apparent flaws.",
                  payloadType: "hypothesis",
                  confidenceScore: 0.9,
                  assumptions: ["Local memory cache"],
                  openQuestions: [],
                  proposedSubtasks: [
                    {
                      key: "stress_test",
                      title: "Stress test",
                      instruction: "Run 500 req/s",
                      reason: "Validate cache",
                      priority: "recommended",
                    },
                  ],
                }),
              }),
              error_json: null,
              created_at: "2026-10-20T20:00:00+00:00",
              updated_at: "2026-10-20T20:02:00+00:00",
              depends_on: [],
              attempts: [],
            },
            {
              id: "22222222-2222-4222-8222-222222222222",
              mission_id: missionId,
              task_key: "security_review",
              ordinal: 2,
              profile_key: "claude",
              state: "succeeded",
              result_json: JSON.stringify({
                response: JSON.stringify({
                  summary:
                    "Major contradiction: local memory cache does not invalidate revoked sessions!",
                  payloadType: "contradiction_claim",
                  confidenceScore: 0.95,
                  assumptions: [],
                  openQuestions: [],
                  proposedSubtasks: [],
                }),
              }),
              error_json: null,
              created_at: "2026-10-20T20:02:00+00:00",
              updated_at: "2026-10-20T20:04:00+00:00",
              depends_on: ["investigate"],
              attempts: [],
            },
          ],
        }),
      ),
      listMissions: vi.fn().mockResolvedValue([]),
      createSchedule: vi.fn(),
      getSchedule: vi.fn(),
      listSchedules: vi.fn().mockResolvedValue([]),
      listScheduleRuns: vi.fn().mockResolvedValue([]),
      pauseSchedule: vi.fn(),
      resumeSchedule: vi.fn(),
      agents: vi.fn().mockResolvedValue({ worker_enabled: true, configured: [], available: [] }),
      registerAgent: vi.fn(),
      createAgent: vi.fn(),
      updateAgentProfile: vi.fn(),
      disableAgent: vi.fn(),
      testAgentProfile: vi.fn(),
      updateAgentHealth: vi.fn(),
      verifyAudit: vi.fn(),
      createPaperAccount: vi.fn(),
      getPaperAccount: vi.fn(),
      listPaperAccounts: vi.fn().mockResolvedValue([]),
      createPaperMarket: vi.fn(),
      getPaperMarket: vi.fn(),
      listPaperMarkets: vi.fn().mockResolvedValue([]),
      addPaperQuote: vi.fn(),
      submitResearchMission: vi.fn(),
      getResearchRun: vi.fn(),
      listResearchRuns: vi.fn().mockResolvedValue([]),
    } satisfies MissionControlPort;

    harness = await makeApi({ missionControl: engine });
    account = await createAccount(harness, "collab@nexus.local");
    ownerExternalKey = `${missionOwnerPrefix(account.userId)}-collab-1`;
  });

  afterEach(async () => {
    await harness.close();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("saves an artifact and allows its inspection and download", async () => {
    // 1. POST /api/v1/orchestrator/missions/:missionId/artifacts
    const createRes = await harness.app.inject({
      method: "POST",
      url: `/api/v1/orchestrator/missions/${missionId}/artifacts`,
      headers: account.authorization,
      payload: {
        taskKey: "investigate",
        name: "architecture_diagram.mmd",
        content: "flowchart TD\nA[Client] --> B[API]",
        description: "Architecture diagram",
        mimeType: "text/vnd.mermaid",
      },
    });

    expect(createRes.statusCode).toBe(201);
    const created = createRes.json<{ data: { artifact: { uri: string; name: string } } }>();
    expect(created.data.artifact.name).toBe("architecture_diagram.mmd");
    expect(created.data.artifact.uri).toBe("artifact://investigate/architecture_diagram.mmd");

    // 2. GET /api/v1/orchestrator/missions/:missionId/artifacts
    const listRes = await harness.app.inject({
      method: "GET",
      url: `/api/v1/orchestrator/missions/${missionId}/artifacts`,
      headers: account.authorization,
    });
    expect(listRes.statusCode).toBe(200);
    const listed = listRes.json<{ data: { artifacts: { uri: string }[] } }>();
    expect(listed.data.artifacts).toHaveLength(1);

    // 3. GET /api/v1/orchestrator/missions/:missionId/artifacts/download?uri=...
    const downloadRes = await harness.app.inject({
      method: "GET",
      url: `/api/v1/orchestrator/missions/${missionId}/artifacts/download?uri=${encodeURIComponent(
        created.data.artifact.uri,
      )}`,
      headers: account.authorization,
    });
    expect(downloadRes.statusCode).toBe(200);
    expect(downloadRes.body).toBe("flowchart TD\nA[Client] --> B[API]");
  });

  it("exposes collaborative view with structured messages, cross-critique debates, and subtasks", async () => {
    // Create artifact in advance
    await harness.app.inject({
      method: "POST",
      url: `/api/v1/orchestrator/missions/${missionId}/artifacts`,
      headers: account.authorization,
      payload: {
        taskKey: "investigate",
        name: "scan.json",
        content: JSON.stringify({ ok: true }),
        description: "Audit report",
      },
    });

    const collabRes = await harness.app.inject({
      method: "GET",
      url: `/api/v1/orchestrator/missions/${missionId}/collaboration`,
      headers: account.authorization,
    });

    expect(collabRes.statusCode).toBe(200);
    const collab = collabRes.json<{
      data: {
        missionId: string;
        tasks: unknown[];
        artifacts: unknown[];
        debates: { issue: string; severity: string }[];
        proposedSubtasks: { key: string }[];
      };
    }>().data;

    expect(collab.missionId).toBe(missionId);
    expect(collab.tasks).toHaveLength(2);
    expect(collab.artifacts).toHaveLength(1);
    // A cross-critique debate must have been detected between investigate and security_review
    expect(collab.debates).toHaveLength(1);
    expect(collab.debates[0]?.issue).toContain("Contradictory divergence detected");
    // A subtask proposed by investigate must be listed
    expect(collab.proposedSubtasks).toHaveLength(1);
    expect(collab.proposedSubtasks[0]?.key).toBe("stress_test");
  });

  it("persists bounded advanced collaboration through the authenticated API", async () => {
    const create = await harness.app.inject({
      method: "POST",
      url: `/api/v1/orchestrator/missions/${missionId}/collaboration/advanced/sessions`,
      headers: account.authorization,
      payload: {
        actorId: "planner",
        agents: [
          {
            id: "planner",
            capabilities: ["planning"],
            permissions: ["collaboration.message", "collaboration.bid"],
          },
          {
            id: "reviewer",
            capabilities: ["review"],
            permissions: ["collaboration.message"],
          },
        ],
        limits: {
          maxHops: 2,
          maxTokens: 20,
          maxDurationMs: 60_000,
          maxRecursionDepth: 1,
          consensusThreshold: 0.5,
          mandatoryCrossReview: true,
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const sessionId = create.json<{ data: { event: { sessionId: string } } }>().data.event
      .sessionId;

    const message = await harness.app.inject({
      method: "POST",
      url: `/api/v1/orchestrator/missions/${missionId}/collaboration/advanced/sessions/${sessionId}/actions`,
      headers: account.authorization,
      payload: {
        kind: "message",
        actorId: "planner",
        recipientId: "reviewer",
        tokenCount: 5,
        payloadType: "proposal",
        content: "Review the bounded plan.",
      },
    });
    expect(message.statusCode).toBe(201);

    const forbiddenMoneyBid = await harness.app.inject({
      method: "POST",
      url: `/api/v1/orchestrator/missions/${missionId}/collaboration/advanced/sessions/${sessionId}/actions`,
      headers: account.authorization,
      payload: {
        kind: "bid",
        actorId: "planner",
        taskKey: "review_plan",
        virtualScore: 90,
        rationale: "Planning capability match.",
        currency: "USD",
        amount: 10,
      },
    });
    expect(forbiddenMoneyBid.statusCode).toBe(400);

    const replay = await harness.app.inject({
      method: "GET",
      url: `/api/v1/orchestrator/missions/${missionId}/collaboration/advanced/sessions/${sessionId}`,
      headers: account.authorization,
    });
    expect(replay.statusCode).toBe(200);
    const events = replay.json<{ data: { events: { sequence: number; actorId: string }[] } }>().data
      .events;
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.actorId)).toEqual(["planner", "planner"]);
  });
});
