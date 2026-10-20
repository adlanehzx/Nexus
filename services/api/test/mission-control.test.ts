import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionControlPort } from "@nexus/mission-control-client";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";
import { missionOwnerPrefix } from "../src/services/acp-orchestrator.js";

const health = {
  status: "ready" as const,
  worker_enabled: true,
  worker_concurrency: 2,
  scheduler_enabled: true,
  profiles: ["antigravity", "claude", "codex"],
};

const fake = {
  health: vi.fn().mockResolvedValue(health),
  settings: vi.fn(),
  updateSettings: vi.fn(),
  submitMission: vi.fn(),
  getMission: vi.fn(),
  listMissions: vi.fn().mockResolvedValue([]),
  createSchedule: vi.fn(),
  getSchedule: vi.fn(),
  listSchedules: vi.fn().mockResolvedValue([]),
  listScheduleRuns: vi.fn().mockResolvedValue([]),
  pauseSchedule: vi.fn(),
  resumeSchedule: vi.fn(),
  agents: vi.fn(),
  registerAgent: vi.fn(),
  createAgent: vi.fn(),
  updateAgentProfile: vi.fn(),
  disableAgent: vi.fn(),
  testAgentProfile: vi.fn(),
  updateAgentHealth: vi.fn(),
  verifyAudit: vi.fn().mockResolvedValue({ valid: true, checked: 21, head: "a".repeat(64) }),
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

function scheduleFor(userId: string, id = "33333333-3333-4333-8333-333333333333") {
  return {
    id,
    name: "Veille",
    state: "active" as const,
    schedule_kind: "cron" as const,
    run_at: null,
    cron_expression: "0 8 * * *",
    timezone: "Europe/Paris",
    catch_up_policy: "latest" as const,
    max_catch_up: 3,
    max_concurrency: 1,
    misfire_grace_seconds: 300,
    mission: {
      external_key: `${missionOwnerPrefix(userId)}-schedule-test`,
      title: "Veille",
      workspace: "/tmp/nexus",
      tasks: [
        {
          key: "watch",
          profile: "codex",
          fallback_profiles: [],
          instruction: "Veille",
          depends_on: [],
          timeout_seconds: 1800,
          max_attempts: 2,
          retry_delay_seconds: 10,
          context_budget_chars: 60_000,
        },
      ],
    },
    next_run_at: "2030-01-01T07:00:00+00:00",
    last_scheduled_at: null,
    created_at: "2026-10-20T10:00:00+00:00",
    updated_at: "2026-10-20T10:00:00+00:00",
  };
}

let harness: ApiHarness;
let admin: Account;
let member: Account;

beforeEach(async () => {
  vi.clearAllMocks();
  harness = await makeApi({ missionControl: fake });
  admin = await createAccount(harness, "admin-mission@example.org");
  member = await createAccount(harness, "member-mission@example.org");
});

afterEach(async () => harness.close());

describe("routes Mission Control", () => {
  it("réserve le statut à l'administrateur", async () => {
    expect(
      (await harness.app.inject({ method: "GET", url: "/api/v1/dashboard/mission-control" }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await harness.app.inject({
          method: "GET",
          url: "/api/v1/dashboard/mission-control",
          headers: member.authorization,
        })
      ).statusCode,
    ).toBe(403);
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/dashboard/mission-control",
      headers: admin.authorization,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ configured: true, reachable: true, health });
  });

  it("transmet une mission validée et sa clé d'idempotence", async () => {
    fake.submitResearchMission.mockResolvedValueOnce({
      mission_id: "11111111-1111-4111-8111-111111111111",
      research_run_id: "22222222-2222-4222-8222-222222222222",
      replayed: false,
      mode: "paper_only",
    });
    const payload = {
      objective: "Vérifier puis prévoir",
      question: "Événement ?",
      close_at: "2030-01-01T00:00:00Z",
      workspace: "/tmp/nexus",
      sources: ["https://example.org/source"],
      account_id: "11111111-1111-4111-8111-111111111111",
      market_id: "22222222-2222-4222-8222-222222222222",
    };
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/mission-control/research-missions",
      headers: { ...admin.authorization, "idempotency-key": "mission-1" },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(fake.submitResearchMission).toHaveBeenCalledWith(payload, "mission-1");
  });

  it("force le propriétaire à la création d'un calendrier", async () => {
    const created = scheduleFor(admin.userId);
    fake.createSchedule.mockResolvedValueOnce(created);
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/mission-control/schedules",
      headers: admin.authorization,
      payload: {
        name: "Veille",
        timezone: "Europe/Paris",
        cron_expression: "0 8 * * *",
        mission: {
          external_key: "nexus-autre-utilisateur-tentative",
          title: "Veille",
          workspace: "/tmp/nexus",
          tasks: [{ key: "watch", profile: "codex", instruction: "Veille" }],
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const input = fake.createSchedule.mock.calls[0]?.[0];
    expect(input?.mission.external_key).toMatch(
      new RegExp(`^${missionOwnerPrefix(admin.userId)}-schedule-`),
    );
    expect(input?.mission.external_key).not.toContain("autre-utilisateur");
    expect(input?.mission.workspace).toMatch(/\.nexus-workspaces\/schedule-[0-9a-f-]+$/);
    expect(input?.mission.workspace).not.toBe("/tmp/nexus");
  });

  it("filtre la liste et masque les calendriers d'un autre administrateur", async () => {
    await harness.services.users.setRole(member.userId, "ADMIN");
    const owned = scheduleFor(admin.userId);
    const foreign = scheduleFor(member.userId, "44444444-4444-4444-8444-444444444444");
    fake.listSchedules.mockResolvedValueOnce([owned, foreign]);
    const dashboard = await harness.app.inject({
      method: "GET",
      url: "/api/v1/dashboard/mission-control",
      headers: admin.authorization,
    });
    expect(dashboard.statusCode).toBe(200);
    const body = dashboard.json<{ data: { schedules: { id: string }[] } }>();
    expect(body.data.schedules.map((item) => item.id)).toEqual([owned.id]);

    fake.getSchedule.mockResolvedValueOnce(foreign);
    const hidden = await harness.app.inject({
      method: "POST",
      url: `/api/v1/mission-control/schedules/${foreign.id}/pause`,
      headers: admin.authorization,
    });
    expect(hidden.statusCode).toBe(404);
    expect(fake.pauseSchedule).not.toHaveBeenCalled();
  });

  it("expose uniquement l'historique d'un calendrier propriétaire", async () => {
    const owned = scheduleFor(admin.userId);
    fake.getSchedule.mockResolvedValueOnce(owned);
    fake.listScheduleRuns.mockResolvedValueOnce([]);
    const response = await harness.app.inject({
      method: "GET",
      url: `/api/v1/mission-control/schedules/${owned.id}/runs`,
      headers: admin.authorization,
    });
    expect(response.statusCode).toBe(200);
    expect(fake.listScheduleRuns).toHaveBeenCalledWith(owned.id, 100);
  });
});
