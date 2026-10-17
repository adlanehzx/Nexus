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
