import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionControlPort, SubmitMission } from "@nexus/mission-control-client";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

const missionId = "33333333-3333-4333-8333-333333333333";
let submitted: SubmitMission | undefined;

const engine = {
  health: vi.fn().mockResolvedValue({
    status: "ready" as const,
    worker_enabled: true,
    worker_concurrency: 2,
    profiles: ["antigravity", "claude", "codex"],
  }),
  submitMission: vi.fn((input: SubmitMission) => {
    submitted = input;
    return Promise.resolve({ mission_id: missionId, replayed: false });
  }),
  getMission: vi.fn(() =>
    Promise.resolve({
      id: missionId,
      external_key: submitted?.external_key ?? "wrong-owner",
      title: submitted?.title ?? "Mission",
      workspace: submitted?.workspace ?? "/tmp",
      state: "succeeded",
      tasks: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          mission_id: missionId,
          task_key: "nexus_final_synthesis",
          ordinal: 2,
          profile_key: "codex",
          state: "succeeded",
          result_json: '{"response":"Réponse finale vérifiée"}',
          error_json: null,
        },
      ],
    }),
  ),
  agents: vi.fn().mockResolvedValue({ worker_enabled: true, configured: [], available: [] }),
  registerAgent: vi.fn().mockResolvedValue({
    worker_enabled: true,
    configured: [],
    available: [],
  }),
  createAgent: vi.fn().mockResolvedValue({
    worker_enabled: true,
    configured: [],
    available: [],
  }),
  updateAgentHealth: vi.fn().mockResolvedValue({
    worker_enabled: true,
    configured: [],
    available: [],
  }),
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

let harness: ApiHarness;
let account: Account;

beforeEach(async () => {
  submitted = undefined;
  vi.clearAllMocks();
  harness = await makeApi({ missionControl: engine });
  account = await createAccount(harness, "orchestrator@example.org");
});

afterEach(async () => harness.close());

describe("façade orchestrateur NEXUS", () => {
  it("transforme un seul message en DAG ACP puis expose uniquement la synthèse", async () => {
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/messages",
      headers: account.authorization,
      payload: { message: "Analyse ce dépôt et propose trois améliorations." },
    });
    expect(created.statusCode).toBe(202);
    expect(submitted?.tasks.at(-1)).toMatchObject({
      key: "nexus_final_synthesis",
      profile: "claude",
      fallback_profiles: ["antigravity", "codex"],
      context_budget_chars: 80_000,
    });
    expect((submitted?.tasks.at(-1)?.depends_on ?? []).length).toBeGreaterThan(0);
    expect(submitted?.tasks).toContainEqual(
      expect.objectContaining({
        key: "nexus_quality_review_1",
        profile: "claude",
        context_budget_chars: 80_000,
      }),
    );
    expect(submitted?.tasks.at(-1)?.depends_on).toContain("nexus_quality_review_1");

    const status = await harness.app.inject({
      method: "GET",
      url: `/api/v1/orchestrator/missions/${missionId}`,
      headers: account.authorization,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().data).toMatchObject({
      state: "succeeded",
      response: "Réponse finale vérifiée",
    });
  });

  it("exige une session utilisateur", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/messages",
      payload: { message: "test" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("permet à l'administrateur de consulter et enregistrer les profils ACP NEXUS", async () => {
    const listed = await harness.app.inject({
      method: "GET",
      url: "/api/v1/orchestrator/agents",
      headers: account.authorization,
    });
    expect(listed.statusCode).toBe(200);
    expect(engine.agents).toHaveBeenCalledOnce();

    const registered = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/agents",
      headers: account.authorization,
      payload: { key: "nouvel-agent", agent_profile_id: "profile-123" },
    });
    expect(registered.statusCode).toBe(201);
    expect(engine.registerAgent).toHaveBeenCalledWith({
      key: "nouvel-agent",
      agent_profile_id: "profile-123",
    });
  });

  it("réserve le registre d'agents au compte administrateur", async () => {
    const member = await createAccount(harness, "member-agents@example.org");
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/orchestrator/agents",
      headers: member.authorization,
    });
    expect(response.statusCode).toBe(403);
  });

  it("crée un profil ACP depuis NEXUS sans recevoir de secret", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/orchestrator/agents/create",
      headers: account.authorization,
      payload: {
        key: "claude-review",
        name: "Claude-Review",
        template_profile_id: "profile-claude",
        model: "claude-opus",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(engine.createAgent).toHaveBeenCalledWith({
      key: "claude-review",
      name: "Claude-Review",
      template_profile_id: "profile-claude",
      model: "claude-opus",
    });
    expect(JSON.stringify(engine.createAgent.mock.calls)).not.toMatch(/token|secret|password/i);
  });
});
