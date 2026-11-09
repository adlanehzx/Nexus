/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-empty-function, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-plus-operands, @typescript-eslint/no-base-to-string, @typescript-eslint/no-unnecessary-type-assertion --
   Test doubles implement async/Promise-returning interfaces without awaiting and use loose fetch mocks. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, createHash } from "node:crypto";
import { TradingLab, type TradingConfig } from "../src/services/trading/lab.js";
import {
  binanceSignature,
  krakenSignature,
  RestVenue,
  type ExecutionVenue,
  type VenueConfig,
  type VenueOrder,
} from "../src/services/trading/venues.js";
const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const venueConfig: VenueConfig = {
  id: "binance",
  environment: "testnet",
  quoteCurrency: "USD",
  accountId: "",
  gatewayUrl: "https://localhost:5000",
};
const config = (mode: "virtual" | "live" = "live"): TradingConfig => ({
  mode,
  enabled: true,
  venues: [
    {
      ...venueConfig,
      symbols: [{ symbol: "BTCUSD", baseAsset: "BTC" }],
      allocatedCapital: 1000,
      maxOrderSize: 20,
      maxPositionSize: 100,
      maxDailyLoss: 30,
      maxDrawdown: 0.1,
      kellyFraction: 0.25,
      allowedOrderTypes: ["limit"],
      manualConfirmation: true,
    },
  ],
});
const order = () => ({
  venue: "binance" as const,
  symbol: "BTCUSD",
  side: "buy" as const,
  type: "limit" as const,
  quantity: 1,
  price: 10,
  winProbability: 0.8,
  payoffRatio: 1,
  confirmed: true,
  intentId: crypto.randomUUID(),
});
function mockVenue() {
  return {
    getBalances: vi.fn(async () => ({ USD: 1000 })),
    getPositions: vi.fn(async () => []),
    getOpenOrders: vi.fn(async () => [] as VenueOrder[]),
    getMarketData: vi.fn(async () => ({ price: 10 })),
    placeOrder: vi.fn(async (o: any) => ({ ...o, id: "1", status: "submitted" })),
    cancelOrder: vi.fn(async () => {}),
    getOrderStatus: vi.fn(async (o: VenueOrder) => o),
  } satisfies ExecutionVenue;
}
async function lab(v = mockVenue()) {
  const dir = await mkdtemp(join(tmpdir(), "nexus-trading-"));
  paths.push(dir);
  return {
    v,
    path: join(dir, "state.json"),
    lab: new TradingLab(join(dir, "state.json"), undefined, () => v),
  };
}
const reply = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
describe("official REST contracts", () => {
  it("Binance HMAC is deterministic", () => {
    expect(
      binanceSignature("NhqPtmdSJYdKjVHjA3hJg6kpXIvT2OvZXzhpVfD5y2hFJxXhCqHjMpR5D7D9lLx", "test"),
    ).toBe(
      createHmac("sha256", "NhqPtmdSJYdKjVHjA3hJg6kpXIvT2OvZXzhpVfD5y2hFJxXhCqHjMpR5D7D9lLx")
        .update("test")
        .digest("hex"),
    );
  });
  it("Binance signs the actual request and uses only testnet", async () => {
    const http = vi.fn(async () => reply({ balances: [] }));
    const v = new RestVenue(venueConfig, "test-key", "test-secret", http as typeof fetch);
    await v.getBalances();
    const [url, init] = http.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin).toBe("https://testnet.binance.vision");
    const signature = u.searchParams.get("signature");
    u.searchParams.delete("signature");
    expect(signature).toBe(
      createHmac("sha256", "test-secret").update(u.searchParams.toString()).digest("hex"),
    );
    expect(init.headers).toHaveProperty("X-MBX-APIKEY", "test-key");
  });
  it("Kraken signs path + sha256(nonce + exact form body)", async () => {
    const http = vi.fn(async () => reply({ error: [], result: { ZUSD: "100" } }));
    const v = new RestVenue(
      { ...venueConfig, id: "kraken", environment: "production" },
      "key",
      Buffer.from("secret").toString("base64"),
      http as typeof fetch,
    );
    await v.getBalances();
    const [url, init] = http.mock.calls[0] as unknown as [string, RequestInit];
    const nonce = new URLSearchParams(String(init.body)).get("nonce")!;
    const expected = createHmac("sha512", Buffer.from("secret"))
      .update(
        Buffer.concat([
          Buffer.from(new URL(url).pathname),
          createHash("sha256")
            .update(nonce + init.body)
            .digest(),
        ]),
      )
      .digest("base64");
    expect(init.headers).toHaveProperty("API-Sign", expected);
    expect(
      krakenSignature(
        Buffer.from("secret").toString("base64"),
        new URL(url).pathname,
        nonce,
        String(init.body),
      ),
    ).toBe(expected);
  });
  it("Kraken sandbox fails closed without HTTP", async () => {
    const http = vi.fn();
    await expect(
      new RestVenue({ ...venueConfig, id: "kraken" }, "k", "s", http).getBalances(),
    ).rejects.toThrow("unsupported");
    expect(http).not.toHaveBeenCalled();
  });
  it("maps authentication and network errors without echoing secrets", async () => {
    await expect(
      new RestVenue(
        venueConfig,
        "k",
        "s",
        vi.fn(async () => new Response("secret", { status: 401 })),
      ).getBalances(),
    ).rejects.toThrow("authentication");
    await expect(
      new RestVenue(
        venueConfig,
        "k",
        "s",
        vi.fn(async () => {
          throw new Error("secret");
        }),
      ).getBalances(),
    ).rejects.toThrow("unreachable");
    await expect(
      new RestVenue(
        { ...venueConfig, id: "kraken", environment: "production" },
        "k",
        "cw==",
        vi.fn(async () => reply({ error: ["EAPI:Invalid key"] })),
      ).getBalances(),
    ).rejects.toThrow("authentication");
  });
  it("IBKR verifies SSO and paper account before balances", async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(reply({ authenticated: true }))
      .mockResolvedValueOnce(reply([{ accountId: "DU123" }]))
      .mockResolvedValueOnce(reply({ USD: { cashbalance: 1000 } }));
    expect(
      await new RestVenue(
        { ...venueConfig, id: "ibkr", accountId: "DU123" },
        "",
        "",
        http,
      ).getBalances(),
    ).toEqual({ USD: 1000 });
    expect(String(http.mock.calls[0]?.[0])).toContain("/iserver/auth/status");
  });
  it("IBKR refuses live account in testnet and warning replies", async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(reply({ authenticated: true }))
      .mockResolvedValueOnce(reply([{ accountId: "U123" }]));
    await expect(
      new RestVenue({ ...venueConfig, id: "ibkr", accountId: "U123" }, "", "", http).getBalances(),
    ).rejects.toThrow("authentication");
    const warning = vi.fn(async () => reply([{ id: "reply-id", message: ["Confirm"] }]));
    await expect(
      new RestVenue({ ...venueConfig, id: "ibkr" }, "", "", warning).placeOrder({
        ...order(),
        clientOrderId: "intent",
      }),
    ).rejects.toThrow("contract");
    expect(warning).toHaveBeenCalledTimes(1);
  });
});
describe("persistent risk engine", () => {
  it("defaults to virtual and disabled", async () => {
    const { lab: l } = await lab();
    expect((await l.status()).config).toEqual({ mode: "virtual", enabled: false, venues: [] });
  });
  it("requires explicit production confirmation and persists timestamp", async () => {
    const { lab: l, path } = await lab();
    const c = config();
    c.venues[0]!.environment = "production";
    await expect(l.configure(c, false)).rejects.toThrow("confirmation");
    await l.configure(c, true);
    expect(Object.values((await l.status()).productionConfirmedAt)[0]).toMatch(/^\d{4}-/);
    expect(JSON.parse(await readFile(path, "utf8")).audit.length).toBe(2);
  });
  it("rejects max order and manual confirmation", async () => {
    const { lab: l, v } = await lab();
    await l.configure(config(), false);
    await expect(l.order({ ...order(), quantity: 3 })).rejects.toThrow("Max order");
    await expect(l.order({ ...order(), confirmed: false })).rejects.toThrow("confirmation");
    expect(v.placeOrder).not.toHaveBeenCalled();
  });
  it("daily loss triggers kill and cancels venue open orders", async () => {
    const { lab: l, v } = await lab();
    await l.configure(config(), false);
    await l.refresh();
    v.getBalances.mockResolvedValue({ USD: 960 });
    v.getOpenOrders.mockResolvedValue([
      { ...order(), id: "open", status: "open", clientOrderId: "x" },
    ]);
    await l.refresh();
    expect((await l.status()).killed).toBe(true);
    expect(v.cancelOrder).toHaveBeenCalled();
    await expect(l.order(order())).rejects.toThrow("kill switch");
  });
  it("drawdown triggers auto kill independently of daily limit", async () => {
    const { lab: l, v } = await lab();
    const c = config();
    c.venues[0]!.maxDailyLoss = 500;
    await l.configure(c, false);
    await l.refresh();
    v.getBalances.mockResolvedValue({ USD: 890 });
    await l.refresh();
    expect((await l.status()).killed).toBe(true);
  });
  it("unreachable venue never falls back to a paper fill", async () => {
    const { lab: l, v } = await lab();
    await l.configure(config(), false);
    v.getBalances.mockRejectedValue(new Error("offline"));
    await expect(l.order(order())).rejects.toThrow("offline");
    expect(v.placeOrder).not.toHaveBeenCalled();
    expect((await l.status()).venues.binance?.error).toBeTruthy();
  });
  it("persists live order/audit and prevents replay", async () => {
    const { lab: l, v } = await lab();
    await l.configure(config(), false);
    const o = order();
    await l.order(o);
    await expect(l.order(o)).rejects.toThrow("already processed");
    expect(v.placeOrder).toHaveBeenCalledTimes(1);
    expect((await l.status()).audit.entries).toBe(4);
  });
  it("global kill cancels orders even after switching mode", async () => {
    const { lab: l, v } = await lab();
    await l.configure(config(), false);
    await l.configure(config("virtual"), false);
    v.getOpenOrders.mockResolvedValue([
      { ...order(), id: "open", status: "open", clientOrderId: "x" },
    ]);
    await l.killSwitch();
    expect(v.cancelOrder).toHaveBeenCalled();
    expect((await l.status()).killed).toBe(true);
  });
  it("credentials never enter persisted state or response", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-trading-"));
    paths.push(dir);
    const vault = {
      set: vi.fn(async () => {}),
      get: vi.fn(async () => undefined),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => []),
    };
    const path = join(dir, "state.json");
    const l = new TradingLab(path, vault);
    await l.credentials("binance", "testnet", "private-key", "private-secret");
    expect(await readFile(path, "utf8")).not.toContain("private-");
    expect(JSON.stringify(await l.status())).not.toContain("private-");
  });
});

describe("risk regression cases", () => {
  it("virtual uses the common risk engine and never places a venue order", async () => {
    const { lab: l, v } = await lab();
    await l.configure(config("virtual"), false);
    await l.order(order());
    expect(v.placeOrder).not.toHaveBeenCalled();
    const s = await l.status();
    expect(s.venues.binance?.orders[0]?.status).toBe("filled");
    expect(s.venues.binance?.cash).toBe(990);
  });
  it("max position uses fresh market value rather than the submitted limit", async () => {
    const v = mockVenue();
    v.getPositions.mockResolvedValue([{ symbol: "BTC", quantity: 11 }] as never);
    const { lab: l } = await lab(v);
    await l.configure(config(), false);
    await expect(l.order({ ...order(), price: 1 })).rejects.toThrow("Position");
    expect(v.placeOrder).not.toHaveBeenCalled();
  });
  it("uncertain order submission latches kill instead of accepting another intent", async () => {
    const { lab: l, v } = await lab();
    await l.configure(config(), false);
    v.placeOrder.mockRejectedValue(new Error("network timeout"));
    await expect(l.order(order())).rejects.toThrow("network timeout");
    expect((await l.status()).killed).toBe(true);
    await expect(l.order(order())).rejects.toThrow("kill switch");
  });
  it("kill persists cancellation failures visibly", async () => {
    const { lab: l, v } = await lab();
    await l.configure(config(), false);
    v.getOpenOrders.mockRejectedValue(new Error("offline"));
    await l.killSwitch();
    expect((await l.status()).killErrors?.[0]).toContain("cancellation pending");
  });
  it("rejects a modified hash-chain entry", async () => {
    const { lab: l, path } = await lab();
    await l.configure(config(), false);
    const state = JSON.parse(await readFile(path, "utf8"));
    state.audit[0].event = "tampered";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify(state));
    await expect(l.status()).rejects.toThrow("integrity");
  });
});
