import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionControlPort } from "@nexus/mission-control-client";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

const health = {
  status: "ready" as const,
  worker_enabled: true,
  worker_concurrency: 2,
  profiles: ["antigravity", "claude", "codex"],
};

const fake = {
  health: vi.fn().mockResolvedValue(health),
  submitMission: vi.fn(),
  getMission: vi.fn(),
  agents: vi.fn(),
  registerAgent: vi.fn(),
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
});
