import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../src/lib/api.js";
import { DashboardApi, type PaperMarketDetail, type PaperOrder } from "../src/lib/api.js";
import { paperOrderInput, paperOrderPnl } from "../src/lib/paper-trading.js";

const market: PaperMarketDetail = {
  id: "market/1",
  question: "Research market",
  state: "open",
  close_at: "2099-01-01T00:00:00Z",
  winning_outcome: null,
  latest_quote: {
    yes_price_ppm: 500000,
    liquidity_cents: 100000,
    observed_at: "2026-11-08T12:00:00Z",
  },
};
const order: PaperOrder = {
  id: "o1",
  market_id: market.id,
  outcome: "yes",
  state: "filled",
  stake_cents: 100,
  shares_micro: 190000000,
  execution_price_ppm: 510000,
  payout_cents: null,
};
afterEach(() => vi.unstubAllGlobals());

describe("Paper Trading", () => {
  it("supports opposing Yes/No positions and rejects invalid or closed orders", () => {
    expect(paperOrderInput("a1", market, "yes", "0.7", "0.9").model_probability).toBe("0.7");
    expect(paperOrderInput("a1", market, "no", "0.3", "1").model_probability).toBe("0.3");
    expect(() => paperOrderInput("a1", market, "no", "0.7", "0.9")).toThrow(/selected side/);
    for (const probability of ["", "NaN", "0", "1", "Infinity"]) {
      expect(() => paperOrderInput("a1", market, "yes", probability, "0.9")).toThrow(/Probability/);
    }
    expect(() => paperOrderInput("a1", market, "yes", "0.7", "0")).toThrow(/confidence/);
    expect(() =>
      paperOrderInput("a1", { ...market, latest_quote: null }, "yes", "0.7", "0.9"),
    ).toThrow(/quote/);
    expect(() =>
      paperOrderInput("a1", { ...market, state: "settled" }, "yes", "0.7", "0.9"),
    ).toThrow(/open market/);
    expect(() =>
      paperOrderInput("a1", { ...market, close_at: "2020-01-01T00:00:00Z" }, "yes", "0.7", "0.9"),
    ).toThrow(/open market/);
  });

  it("marks both outcomes using shares after fees and uses actual settlement payouts", () => {
    expect(paperOrderPnl(order, market)).toBe(-5);
    const moved = { ...market, latest_quote: { ...market.latest_quote!, yes_price_ppm: 800000 } };
    expect(paperOrderPnl(order, moved)).toBe(52);
    expect(paperOrderPnl({ ...order, outcome: "no" }, moved)).toBe(-62);
    expect(paperOrderPnl(order, undefined)).toBeNull();
    expect(paperOrderPnl({ ...order, state: "settled", payout_cents: 190 }, undefined)).toBe(90);
    expect(paperOrderPnl({ ...order, state: "settled", payout_cents: 0 }, undefined)).toBe(-100);
  });

  it("wires authenticated detail, quotes, orders with retry keys, risk declines and settlement", async () => {
    const calls: { path: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn((url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      calls.push({ path, init });
      if (path.endsWith("/auth/login"))
        return new Response(
          JSON.stringify({
            data: {
              user: { id: "paper-user", email: "paper@example.org", role: "ADMIN" },
              tokens: { accessToken: "access", refreshToken: "refresh" },
            },
          }),
        );
      if (path.endsWith("/paper/orders"))
        return new Response(
          JSON.stringify({ data: { filled: false, stake_cents: 100, reasons: ["stale_quote"] } }),
        );
      if (path.includes("/markets/") && init.method === "GET")
        return new Response(JSON.stringify({ data: market }));
      return new Response(JSON.stringify({ data: { id: "a1", orders: [order] } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const session = createSession("http://localhost:3000");
    await session.login("paper@example.org", "test-password");
    const api = new DashboardApi(session);
    await expect(api.getPaperAccount("a/1")).resolves.toMatchObject({ orders: [order] });
    await expect(api.getPaperMarket(market.id)).resolves.toEqual(market);
    await api.addPaperQuote(market.id, {
      yes_price: "0.5",
      liquidity_eur: "1000",
      source_url: "https://example.org",
      observed_at: "2026-11-08T12:00:00Z",
    });
    const input = paperOrderInput("a1", market, "yes", "0.7", "0.9");
    await expect(api.placePaperOrder(input, "retry-key")).resolves.toMatchObject({
      filled: false,
      reasons: ["stale_quote"],
    });
    await api.placePaperOrder(input, "retry-key");
    await api.settlePaperMarket(market.id, "yes");
    expect(calls.some((c) => c.path.endsWith("/accounts/a%2F1"))).toBe(true);
    const orders = calls.filter((c) => c.path.endsWith("/paper/orders"));
    expect(orders).toHaveLength(2);
    for (const call of orders) {
      expect(call.init.headers).toMatchObject({
        authorization: "Bearer access",
        "idempotency-key": "retry-key",
      });
      expect(JSON.parse(call.init.body as string)).toEqual(input);
    }
    expect(calls.at(-1)?.path).toBe("/api/v1/mission-control/paper/markets/market%2F1/settle");
    expect(JSON.parse(calls.at(-1)?.init.body as string)).toEqual({ winning_outcome: "yes" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Engine unavailable" } }), {
          status: 502,
        }),
      ),
    );
    await expect(api.getPaperAccount("a1")).rejects.toThrow();
  });
});
