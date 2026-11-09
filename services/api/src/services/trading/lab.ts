import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { SecretVault } from "../runtime-configuration.js";
import {
  PaperVenue,
  RestVenue,
  VenueError,
  type ExecutionVenue,
  type Position,
  type VenueConfig,
  type VenueOrder,
} from "./venues.js";

export const tradingConfigSchema = z.object({
  mode: z.enum(["virtual", "live"]).default("virtual"),
  enabled: z.boolean().default(false),
  venues: z
    .array(
      z.object({
        id: z.enum(["binance", "kraken", "ibkr"]),
        environment: z.enum(["testnet", "production"]),
        quoteCurrency: z.string().regex(/^[A-Z0-9]{2,12}$/),
        accountId: z.string().max(80).default(""),
        gatewayUrl: z.string().url().default("https://localhost:5000"),
        symbols: z
          .array(
            z.object({
              symbol: z.string().regex(/^[A-Za-z0-9._/-]{1,32}$/),
              baseAsset: z.string().regex(/^[A-Za-z0-9._]{1,32}$/),
            }),
          )
          .min(1)
          .max(50),
        allocatedCapital: z.number().positive().max(10000000),
        maxOrderSize: z.number().positive(),
        maxPositionSize: z.number().positive(),
        maxDailyLoss: z.number().positive(),
        maxDrawdown: z.number().positive().max(1),
        kellyFraction: z.number().positive().max(1),
        allowedOrderTypes: z.array(z.literal("limit")).min(1).max(1),
        manualConfirmation: z.boolean().default(true),
      }),
    )
    .max(3)
    .refine((v) => new Set(v.map((c) => c.id)).size === v.length, "Duplicate venue"),
});
export type TradingConfig = z.infer<typeof tradingConfigSchema>;
export const tradingOrderSchema = z.object({
  venue: z.enum(["binance", "kraken", "ibkr"]),
  symbol: z.string().max(32),
  side: z.enum(["buy", "sell"]),
  type: z.literal("limit"),
  quantity: z.number().positive(),
  price: z.number().positive(),
  winProbability: z.number().gt(0).lt(1),
  payoffRatio: z.number().positive(),
  confirmed: z.boolean().default(false),
  intentId: z.string().uuid(),
});
interface Audit {
  at: string;
  event: string;
  data: unknown;
  previous: string;
  hash: string;
}
interface VenueState {
  cash: number;
  positions: Position[];
  orders: VenueOrder[];
  day: string;
  dayEquity: number;
  peak: number;
  equity: number;
  history: { at: string; equity: number; cash: number; exposure: number }[];
  error: string | null;
}
interface State {
  executionConfigs?: TradingConfig["venues"];
  config: TradingConfig;
  productionConfirmedAt: Partial<Record<string, string>>;
  killed: boolean;
  killErrors?: string[];
  venues: Record<string, VenueState>;
  audit: Audit[];
  intents: Record<string, { status: string; order?: VenueOrder }>;
}
export class TradingLab {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  private readonly vault: SecretVault | undefined;
  private readonly factory: (c: VenueConfig, key: string, secret: string) => ExecutionVenue;
  constructor(
    path: string,
    vault: SecretVault | undefined,
    factory: (c: VenueConfig, key: string, secret: string) => ExecutionVenue = (c, k, s) =>
      new RestVenue(c, k, s),
  ) {
    this.path = path;
    this.vault = vault;
    this.factory = factory;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async load(): Promise<State> {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8")) as State;
      let previous = "0".repeat(64);
      for (const entry of state.audit) {
        const { hash, ...payload } = entry;
        if (
          payload.previous !== previous ||
          createHash("sha256").update(JSON.stringify(payload)).digest("hex") !== hash
        )
          throw new Error("Trading audit integrity failure");
        previous = hash;
      }
      state.config = tradingConfigSchema.parse(state.config);
      return state;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return {
        config: { mode: "virtual", enabled: false, venues: [] },
        productionConfirmedAt: {},
        killed: false,
        venues: {},
        audit: [],
        intents: {},
      };
    }
  }
  private async save(s: State) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
    await rename(tmp, this.path);
  }
  private audit(s: State, event: string, data: unknown) {
    const entry = {
      at: new Date().toISOString(),
      event,
      data,
      previous: s.audit.at(-1)?.hash ?? "0".repeat(64),
    };
    s.audit.push({
      ...entry,
      hash: createHash("sha256").update(JSON.stringify(entry)).digest("hex"),
    });
  }
  private key(c: TradingConfig["venues"][number], mode: string) {
    return `${mode}:${c.id}:${c.environment}:${c.accountId}:${c.quoteCurrency}`;
  }
  private venueState(s: State, c: TradingConfig["venues"][number]) {
    const key = this.key(c, s.config.mode);
    return (s.venues[key] ??= {
      cash: c.allocatedCapital,
      positions: [],
      orders: [],
      day: "",
      dayEquity: 0,
      peak: 0,
      equity: 0,
      history: [],
      error: null,
    });
  }
  private async venue(s: State, c: TradingConfig["venues"][number]): Promise<ExecutionVenue> {
    const ref = `trading-${c.id}-${c.environment}`;
    const raw = await this.vault?.get(`vault://nexus/${ref}`);
    let credentials: { apiKey?: string; apiSecret?: string };
    try {
      credentials = raw ? (JSON.parse(raw) as { apiKey?: string; apiSecret?: string }) : {};
      if (
        !credentials ||
        (credentials.apiKey !== undefined && typeof credentials.apiKey !== "string") ||
        (credentials.apiSecret !== undefined && typeof credentials.apiSecret !== "string")
      )
        throw new Error();
    } catch {
      throw new VenueError("authentication");
    }
    const live = this.factory(c, credentials.apiKey ?? "", credentials.apiSecret ?? "");
    if (s.config.mode === "live") return live;
    return new PaperVenue(this.venueState(s, c), live);
  }
  async configure(input: TradingConfig, confirmProduction: boolean) {
    return this.serial(async () => {
      const config = tradingConfigSchema.parse(input),
        s = await this.load();
      for (const c of config.venues) {
        const old = s.config.venues.find((v) => v.id === c.id);
        const confirmationKey = this.key(c, "live");
        if (
          config.mode === "live" &&
          config.enabled &&
          c.environment === "production" &&
          !s.productionConfirmedAt[confirmationKey]
        ) {
          if (!confirmProduction) throw new Error("Explicit production confirmation required");
          s.productionConfirmedAt[confirmationKey] = new Date().toISOString();
          this.audit(s, "production.confirmed", { venue: c.id, account: c.accountId });
        }
        if (old && old.allocatedCapital !== c.allocatedCapital && config.mode === "virtual") {
          const v = s.venues[this.key(c, "virtual")];
          if (v) {
            const delta = c.allocatedCapital - old.allocatedCapital;
            if (v.cash + delta < 0)
              throw new Error("Cannot withdraw allocated capital committed to positions");
            v.cash += delta;
            v.peak += delta;
            v.dayEquity += delta;
            v.equity += delta;
          }
        }
      }
      const registry = s.executionConfigs ?? [];
      for (const c of config.venues)
        if (
          config.mode === "live" &&
          !registry.some((v) => this.key(v, "live") === this.key(c, "live"))
        )
          registry.push(c);
        else if (config.mode === "live") {
          const index = registry.findIndex((v) => this.key(v, "live") === this.key(c, "live"));
          if (index >= 0) registry[index] = c;
        }
      s.executionConfigs = registry;
      s.config = config;
      this.audit(s, "config.saved", config);
      await this.save(s);
      return this.public(s);
    });
  }
  async credentials(venue: string, environment: string, apiKey: string, apiSecret: string) {
    return this.serial(async () => {
      if (!this.vault) throw new Error("Secrets vault unavailable");
      await this.vault.set(
        `trading-${venue}-${environment}`,
        JSON.stringify({ apiKey, apiSecret }),
      );
      const s = await this.load();
      for (const key of Object.keys(s.productionConfirmedAt))
        if (key.startsWith(`live:${venue}:${environment}:`)) delete s.productionConfirmedAt[key];
      this.audit(s, "credentials.updated", { venue, environment });
      await this.save(s);
      return { saved: true };
    });
  }
  private public(s: State) {
    return {
      config: s.config,
      killed: s.killed,
      killErrors: s.killErrors ?? [],
      productionConfirmedAt: s.productionConfirmedAt,
      venues: Object.fromEntries(
        s.config.venues.map((c) => [c.id, s.venues[this.key(c, s.config.mode)] ?? null]),
      ),
      audit: { entries: s.audit.length, head: s.audit.at(-1)?.hash ?? null },
    };
  }
  async status() {
    return this.serial(async () => this.public(await this.load()));
  }
  private async snapshot(s: State, c: TradingConfig["venues"][number], venue: ExecutionVenue) {
    const v = this.venueState(s, c);
    const balances = await venue.getBalances();
    const positions = await venue.getPositions();
    const orders = await venue.getOpenOrders();
    let equity = balances[s.config.mode === "virtual" ? "cash" : c.quoteCurrency];
    if (!Number.isFinite(equity) || equity! < 0) throw new VenueError("contract");
    for (const p of positions) {
      if (!Number.isFinite(p.quantity) || p.quantity < 0) throw new VenueError("contract");
      if (!p.quantity) continue;
      const symbol = c.symbols.find((x) => x.baseAsset === p.symbol || x.symbol === p.symbol);
      if (!symbol) throw new Error("Unvalued asset: configure all held assets before trading");
      equity! += p.quantity * (await venue.getMarketData(symbol.symbol)).price;
    }
    if (!Number.isFinite(equity) || equity! <= 0) throw new VenueError("contract");
    v.cash = balances[s.config.mode === "virtual" ? "cash" : c.quoteCurrency]!;
    v.positions = positions;
    for (const order of v.orders)
      if (
        !orders.some((o) => o.id === order.id) &&
        !["filled", "cancelled", "FILLED", "CANCELED", "closed", "Cancelled", "Filled"].includes(
          order.status,
        )
      )
        Object.assign(order, await venue.getOrderStatus(order));
    // Keep historical orders; replace only currently open orders by venue responses.
    v.orders = [...v.orders.filter((o) => !orders.some((n) => n.id === o.id)), ...orders];
    v.equity = equity!;
    v.peak = Math.max(v.peak, equity!);
    const day = new Date().toISOString().slice(0, 10);
    if (v.day !== day) {
      v.day = day;
      v.dayEquity = equity!;
    }
    v.history.push({
      at: new Date().toISOString(),
      equity: equity!,
      cash: v.cash,
      exposure: equity! - v.cash,
    });
    v.history = v.history.slice(-2000);
    v.error = null;
    return { v, orders };
  }
  private breached(c: TradingConfig["venues"][number], v: VenueState) {
    return (
      v.dayEquity - v.equity >= c.maxDailyLoss || (v.peak - v.equity) / v.peak >= c.maxDrawdown
    );
  }
  private async kill(s: State) {
    s.killed = true;
    this.audit(s, "kill.activated", {});
    await this.save(s);
    const errors: string[] = [];
    // Include previously configured live venues, so switching modes cannot hide their open orders.
    const targets = [
      ...(s.executionConfigs ?? []).map((c) => ({ c, mode: "live" as const })),
      ...s.config.venues.map((c) => ({ c, mode: s.config.mode })),
    ];
    for (const { c, mode } of targets) {
      try {
        const venue = await this.venue({ ...s, config: { ...s.config, mode } }, c);
        for (const o of await venue.getOpenOrders()) {
          try {
            await venue.cancelOrder(o);
            this.audit(s, "order.cancelled", { venue: c.id, id: o.id });
          } catch {
            errors.push(`${c.id}: cancellation failed`);
          }
        }
      } catch {
        errors.push(`${c.id}: unreachable; cancellation pending`);
      }
    }
    s.killErrors = errors;
    this.audit(s, "kill.completed", { errors });
    await this.save(s);
    return { killed: true, errors };
  }
  async killSwitch() {
    return this.serial(async () => this.kill(await this.load()));
  }
  async refresh() {
    return this.serial(async () => {
      const s = await this.load();
      const targets = [
        ...s.config.venues.map((c) => ({ c, mode: s.config.mode })),
        ...(s.executionConfigs ?? [])
          .filter(
            (c) =>
              s.config.mode !== "live" ||
              !s.config.venues.some((v) => this.key(v, "live") === this.key(c, "live")),
          )
          .map((c) => ({ c, mode: "live" as const })),
      ];
      for (const { c, mode } of targets) {
        const scope = { ...s, config: { ...s.config, mode } };
        try {
          const { v } = await this.snapshot(scope, c, await this.venue(scope, c));
          this.audit(s, "risk.monitor", {
            venue: c.id,
            mode,
            equity: v.equity,
            breached: this.breached(c, v),
          });
          if (!s.killed && this.breached(c, v)) await this.kill(s);
        } catch (e) {
          this.venueState(scope, c).error =
            e instanceof VenueError ? e.message : "Venue valuation unavailable";
        }
      }
      await this.save(s);
      return this.public(s);
    });
  }
  async order(input: z.infer<typeof tradingOrderSchema>) {
    return this.serial(async () => {
      const o = tradingOrderSchema.parse(input),
        s = await this.load();
      if (s.intents[o.intentId])
        throw new Error("Intent already processed; reconcile before retrying");
      const c = s.config.venues.find((v) => v.id === o.venue);
      if (!c) throw new Error("Venue not configured");
      const v = this.venueState(s, c);
      try {
        if (s.killed || !s.config.enabled)
          throw new Error("Trading disabled or kill switch active");
        if (
          s.config.mode === "live" &&
          c.environment === "production" &&
          !s.productionConfirmedAt[this.key(c, "live")]
        )
          throw new Error("Production confirmation required");
        if (c.manualConfirmation && !o.confirmed)
          throw new Error("Per-order confirmation required");
        const symbol = c.symbols.find((x) => x.symbol === o.symbol);
        if (!symbol || !c.allowedOrderTypes.includes(o.type))
          throw new Error("Symbol or order type denied");
        const venue = await this.venue(s, c);
        const { orders } = await this.snapshot(s, c, venue);
        if (this.breached(c, v)) {
          await this.kill(s);
          throw new Error("Daily loss or drawdown kill");
        }
        // Conservative reservation: reject while any venue order is open, including external orders.
        if (orders.length) throw new Error("Open orders must be reconciled or cancelled first");
        const quote = await venue.getMarketData(o.symbol);
        const notional = o.quantity * o.price;
        const kelly = Math.max(
          0,
          (o.winProbability - (1 - o.winProbability) / o.payoffRatio) * c.kellyFraction,
        );
        const exposure = v.positions
          .filter((p) => p.symbol === symbol.baseAsset || p.symbol === symbol.symbol)
          .reduce((a, p) => a + p.quantity * quote.price, 0);
        if (
          !Number.isFinite(notional) ||
          notional > c.maxOrderSize ||
          notional > c.allocatedCapital * kelly
        )
          throw new Error("Max order / Kelly limit");
        if (
          o.side === "buy" &&
          (exposure + notional > c.maxPositionSize ||
            notional > v.cash ||
            v.equity - v.cash + notional > c.allocatedCapital)
        )
          throw new Error("Position / capital limit");
        if (o.side === "sell" && o.quantity > exposure / quote.price)
          throw new Error("Short selling disabled");
        // Market orders excluded: a limit order bounds the maximum spend.
        if (o.side === "buy" && o.price > quote.price * 1.05)
          throw new Error("Limit price exceeds fresh quote by 5%");
        this.audit(s, "risk.decision", {
          intentId: o.intentId,
          allowed: true,
          notional,
          kelly,
          mode: s.config.mode,
          venue: c.id,
        });
        s.intents[o.intentId] = { status: "submitting" };
        this.audit(s, "order.submitting", { ...o, mode: s.config.mode });
        await this.save(s);
        const order = await venue.placeOrder({ ...o, clientOrderId: o.intentId });
        if (!v.orders.some((x) => x.id === order.id)) v.orders.push(order);
        s.intents[o.intentId] = { status: "submitted", order };
        this.audit(s, "order.submitted", { venue: c.id, order });
        await this.save(s);
        return order;
      } catch (e) {
        if (s.intents[o.intentId]?.status === "submitting") await this.kill(s);
        v.error =
          e instanceof VenueError ? e.message : e instanceof Error ? e.message : "Order failed";
        this.audit(s, "risk.decision", { intentId: o.intentId, allowed: false, reason: v.error });
        await this.save(s);
        throw new Error(v.error, { cause: e });
      }
    });
  }
}
