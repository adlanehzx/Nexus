import { describe, expect, it, vi } from "vitest";
import { MissionControlClient, MissionControlClientError } from "../src/index.js";

const account = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "NEXUS 50",
  currency: "EUR",
  initial_balance_cents: 5000,
  cash_balance_cents: 5000,
  realized_pnl_cents: 0,
  live_trading: 0,
  open_exposure_cents: 0,
  risk_policy: {},
  orders: [],
};

const schedule = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Veille",
  state: "active",
  schedule_kind: "cron",
  run_at: null,
  cron_expression: "0 8 * * 1-5",
  timezone: "Europe/Paris",
  catch_up_policy: "latest",
  max_catch_up: 3,
  max_concurrency: 1,
  misfire_grace_seconds: 300,
  mission: {
    external_key: "nexus-owned-schedule",
    title: "Veille",
    workspace: "/tmp/nexus",
    tasks: [{ key: "watch", profile: "codex", instruction: "Veille", depends_on: [] }],
  },
  next_run_at: "2030-01-01T07:00:00+00:00",
  last_scheduled_at: null,
  created_at: "2026-10-20T10:00:00+00:00",
  updated_at: "2026-10-20T10:00:00+00:00",
};

describe("MissionControlClient", () => {
  it("refuse HTTP hors boucle locale et les credentials dans l'URL", () => {
    expect(() => new MissionControlClient({ baseUrl: "http://example.org:18100" })).toThrow(
      /loopback/i,
    );
    expect(() => new MissionControlClient({ baseUrl: "https://user:secret@example.org" })).toThrow(
      /credentials/i,
    );
  });

  it("valide le contrat et transmet l'idempotency key", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          mission_id: "11111111-1111-4111-8111-111111111111",
          research_run_id: "22222222-2222-4222-8222-222222222222",
          replayed: false,
          mode: "paper_only",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new MissionControlClient({
      baseUrl: "http://127.0.0.1:18100",
      fetchImpl,
    });
    await client.submitResearchMission(
      {
        objective: "Vérifier",
        question: "Événement ?",
        close_at: "2030-01-01T00:00:00Z",
        workspace: "/tmp/nexus",
        sources: ["https://example.org/source"],
        account_id: "11111111-1111-4111-8111-111111111111",
        market_id: "22222222-2222-4222-8222-222222222222",
      },
      "research-1",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    const init = fetchImpl.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)["idempotency-key"]).toBe("research-1");
  });

  it("soumet et relit une mission ACP générique", async () => {
    const missionId = "33333333-3333-4333-8333-333333333333";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ mission_id: missionId, replayed: false }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: missionId,
            external_key: "nexus-test",
            title: "Test",
            workspace: "/tmp/nexus",
            state: "succeeded",
            created_at: "2026-10-19T10:00:00+00:00",
            updated_at: "2026-10-19T10:01:00+00:00",
            tasks: [
              {
                id: "44444444-4444-4444-8444-444444444444",
                mission_id: missionId,
                task_key: "final",
                ordinal: 0,
                profile_key: "codex",
                state: "succeeded",
                result_json: '{"response":"ok"}',
                error_json: null,
                created_at: "2026-10-19T10:00:00+00:00",
                updated_at: "2026-10-19T10:01:00+00:00",
                depends_on: [],
                attempts: [],
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const client = new MissionControlClient({ baseUrl: "http://localhost:18100", fetchImpl });
    await client.submitMission(
      {
        external_key: "nexus-test",
        title: "Test",
        workspace: "/tmp/nexus",
        tasks: [{ key: "final", profile: "codex", instruction: "Réponds.", depends_on: [] }],
      },
      "generic-1",
    );
    const mission = await client.getMission(missionId);
    expect(mission.state).toBe("succeeded");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://localhost:18100/v1/missions");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(`http://localhost:18100/v1/missions/${missionId}`);
  });

  it("pilote un calendrier et valide son historique", async () => {
    const run = {
      id: "66666666-6666-4666-8666-666666666666",
      schedule_id: schedule.id,
      scheduled_for: "2030-01-01T07:00:00+00:00",
      state: "submitted",
      mission_id: "77777777-7777-4777-8777-777777777777",
      error_code: null,
      created_at: "2030-01-01T07:00:00+00:00",
      updated_at: "2030-01-01T07:00:01+00:00",
      started_at: "2030-01-01T07:00:00+00:00",
      finished_at: null,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(schedule), { status: 201 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ schedules: [schedule] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ runs: [run] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...schedule, state: "paused" }), { status: 200 }),
      );
    const client = new MissionControlClient({ baseUrl: "http://localhost:18100", fetchImpl });

    await client.createSchedule({
      name: "Veille",
      mission: schedule.mission,
      timezone: "Europe/Paris",
      cron_expression: "0 8 * * 1-5",
    });
    expect(await client.listSchedules()).toHaveLength(1);
    expect(await client.listScheduleRuns(schedule.id)).toEqual([run]);
    expect((await client.pauseSchedule(schedule.id)).state).toBe("paused");
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:18100/v1/schedules",
      "http://localhost:18100/v1/schedules?limit=50",
      `http://localhost:18100/v1/schedules/${schedule.id}/runs?limit=100`,
      `http://localhost:18100/v1/schedules/${schedule.id}/pause`,
    ]);
  });

  it("refuse un calendrier avec run_at et cron simultanément", () => {
    const client = new MissionControlClient({
      baseUrl: "http://localhost:18100",
      fetchImpl: vi.fn<typeof fetch>(),
    });
    expect(() =>
      client.createSchedule({
        name: "Invalide",
        mission: schedule.mission,
        run_at: "2030-01-01T00:00:00Z",
        cron_expression: "0 8 * * *",
      }),
    ).toThrow(/exactly one/i);
  });

  it("valide le registre d'agents avant de l'exposer", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          worker_enabled: true,
          configured: [
            {
              key: "claude",
              agent_profile_id: "profile-claude",
              running_tasks: 0,
              queued_tasks: 0,
              last_task_state: "succeeded",
              status: "available",
              cooldown_until: null,
              remaining_5h_percent: 80,
              remaining_week_percent: 60,
              resets_5h_at: null,
              resets_week_at: null,
              usage_source: "provider",
              consecutive_failures: 0,
              last_error_category: null,
            },
          ],
          available: [
            {
              id: "profile-claude",
              name: "CLAUDE",
              agent_kind: "acp",
              registered_as: "claude",
              command: "/usr/bin/claude-acp",
              args: [],
              model: "claude-opus-5",
              permission_policy: "workspace",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const client = new MissionControlClient({ baseUrl: "http://localhost:18100", fetchImpl });
    const registry = await client.agents();
    expect(registry.configured[0]?.key).toBe("claude");
  });

  it("rejette une réponse qui tenterait d'activer le trading réel", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...account, live_trading: 1 }), { status: 200 }),
      );
    const client = new MissionControlClient({
      baseUrl: "http://localhost:18100",
      fetchImpl,
    });
    await expect(client.getPaperAccount(account.id)).rejects.toBeInstanceOf(
      MissionControlClientError,
    );
  });

  it("ne propage pas le corps d'une erreur distante", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"detail":"TOKEN_SECRET"}', { status: 500 }));
    const client = new MissionControlClient({
      baseUrl: "http://localhost:18100",
      fetchImpl,
    });
    await expect(client.health()).rejects.not.toThrow(/TOKEN_SECRET/);
  });
});
