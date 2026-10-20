import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionControlPort } from "@nexus/mission-control-client";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

const missionId = "44444444-4444-4444-8444-444444444444";

describe("Endpoints de Collaboration Inter-Agents (Chantier 14)", () => {
  let harness: ApiHarness;
  let account: Account;
  let workspaceDir: string;

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
      getMission: vi.fn().mockResolvedValue({
        id: missionId,
        external_key: "nexus-owner-collab-1",
        title: "Mission avec collaboration",
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
                summary: "Architecture validée sans faille apparente.",
                payloadType: "hypothesis",
                confidenceScore: 0.9,
                assumptions: ["Cache mémoire local"],
                openQuestions: [],
                proposedSubtasks: [
                  {
                    key: "stress_test",
                    title: "Stress test",
                    instruction: "Exécute 500 req/s",
                    reason: "Valider le cache",
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
                  "Contradiction majeure : le cache mémoire local n'invalide pas les sessions révoquées !",
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
  });

  afterEach(async () => {
    await harness.close();
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("enregistre un artefact et permet sa consultation et son téléchargement", async () => {
    // 1. POST /api/v1/orchestrator/missions/:missionId/artifacts
    const createRes = await harness.app.inject({
      method: "POST",
      url: `/api/v1/orchestrator/missions/${missionId}/artifacts`,
      headers: account.authorization,
      payload: {
        taskKey: "investigate",
        name: "architecture_diagram.mmd",
        content: "flowchart TD\nA[Client] --> B[API]",
        description: "Schéma d'architecture",
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

  it("expose la vue collaborative avec messages structurés, débats contradictoires et sous-tâches", async () => {
    // Créer un artefact au préalable
    await harness.app.inject({
      method: "POST",
      url: `/api/v1/orchestrator/missions/${missionId}/artifacts`,
      headers: account.authorization,
      payload: {
        taskKey: "investigate",
        name: "scan.json",
        content: JSON.stringify({ ok: true }),
        description: "Rapport d'audit",
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
    // Un débat contradictoire doit avoir été détecté entre investigate et security_review
    expect(collab.debates).toHaveLength(1);
    expect(collab.debates[0]?.issue).toContain("Divergence contradictoire détectée");
    // Une sous-tâche proposée par investigate doit être listée
    expect(collab.proposedSubtasks).toHaveLength(1);
    expect(collab.proposedSubtasks[0]?.key).toBe("stress_test");
  });
});
