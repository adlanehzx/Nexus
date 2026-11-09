/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return --
   Venue REST responses are untyped external JSON, and PaperVenue implements async interface methods synchronously; every field is coerced (String/Number) or checked at its use site. */
import { createHash, createHmac } from "node:crypto";

export type VenueId = "binance" | "kraken" | "ibkr";
export interface VenueConfig {
  id: VenueId;
  environment: "testnet" | "production";
  quoteCurrency: string;
  accountId: string;
  gatewayUrl: string;
}
export interface OrderIntent {
  symbol: string;
  side: "buy" | "sell";
  type: "limit";
  quantity: number;
  price: number;
  clientOrderId: string;
}
export interface VenueOrder extends OrderIntent {
  id: string;
  status: string;
}
export interface Position {
  symbol: string;
  quantity: number;
}
export interface ExecutionVenue {
  getOpenOrders(): Promise<VenueOrder[]>;
  getBalances(): Promise<Record<string, number>>;
  getPositions(): Promise<Position[]>;
  placeOrder(order: OrderIntent): Promise<VenueOrder>;
  cancelOrder(order: VenueOrder): Promise<void>;
  getOrderStatus(order: VenueOrder): Promise<VenueOrder>;
  getMarketData(symbol: string): Promise<{ price: number }>;
}
export class VenueError extends Error {
  readonly code: "unreachable" | "authentication" | "rejected" | "unsupported" | "contract";
  constructor(code: VenueError["code"]) {
    super(`Trading venue: ${code}`);
    this.code = code;
  }
}
export function binanceSignature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
export function krakenSignature(
  secret: string,
  path: string,
  nonce: string,
  payload: string,
): string {
  const digest = createHash("sha256")
    .update(nonce + payload)
    .digest();
  return createHmac("sha512", Buffer.from(secret, "base64"))
    .update(Buffer.concat([Buffer.from(path), digest]))
    .digest("base64");
}
// Responses are never included in errors: exchanges may echo credentials or signed URLs.
export class RestVenue implements ExecutionVenue {
  private nonce = Date.now() * 1000;
  readonly config: VenueConfig;
  private readonly key: string;
  private readonly secret: string;
  private readonly http: typeof fetch;
  constructor(config: VenueConfig, key: string, secret: string, http: typeof fetch = fetch) {
    this.config = config;
    this.key = key;
    this.secret = secret;
    this.http = http;
  }
  private async request(
    path: string,
    data: Record<string, string> = {},
    method = "GET",
    authenticated = true,
  ): Promise<any> {
    const c = this.config;
    if (c.id === "kraken" && c.environment === "testnet") throw new VenueError("unsupported");
    let base =
      c.id === "binance"
        ? c.environment === "testnet"
          ? "https://testnet.binance.vision"
          : "https://api.binance.com"
        : "https://api.kraken.com";
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (c.id === "ibkr") {
      const url = new URL(c.gatewayUrl);
      if (
        url.protocol !== "https:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new VenueError("unsupported");
      base = url.origin;
      // Gateway SSO, not fabricated API-key/HMAC authentication. TLS verification stays enabled.
      if (method !== "GET") {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(data);
      }
    } else if (c.id === "binance") {
      const params = new URLSearchParams(data);
      if (authenticated) {
        if (!this.key || !this.secret) throw new VenueError("authentication");
        params.set("timestamp", String(Date.now()));
        params.set("recvWindow", "5000");
        params.set("signature", binanceSignature(this.secret, params.toString()));
        headers["X-MBX-APIKEY"] = this.key;
      }
      path += `?${params.toString()}`;
    } else {
      if (authenticated) {
        if (!this.key || !this.secret) throw new VenueError("authentication");
        method = "POST";
        const nonce = String(++this.nonce);
        body = new URLSearchParams({ nonce, ...data }).toString();
        headers["API-Key"] = this.key;
        headers["API-Sign"] = krakenSignature(this.secret, path, nonce, body);
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      } else path += `?${new URLSearchParams(data).toString()}`;
    }
    try {
      const response = await this.http(base + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (response.status === 401 || response.status === 403)
        throw new VenueError("authentication");
      if (response.status >= 500) throw new VenueError("unreachable");
      const result: any = await response.json();
      if (c.id === "binance" && [-2014, -2015, -1022].includes(result.code))
        throw new VenueError("authentication");
      if (!response.ok) throw new VenueError("rejected");
      if (c.id === "kraken") {
        if (!Array.isArray(result.error)) throw new VenueError("contract");
        if (result.error.length)
          throw new VenueError(
            result.error.some((e: string) => e.startsWith("EAPI:")) ? "authentication" : "rejected",
          );
        return result.result;
      }
      if (result.error || (typeof result.code === "number" && result.code < 0))
        throw new VenueError("rejected");
      return result;
    } catch (error) {
      if (error instanceof VenueError) throw error;
      throw new VenueError("unreachable");
    }
  }
  async getOpenOrders(): Promise<VenueOrder[]> {
    let rows: any[];
    if (this.config.id === "binance") rows = await this.request("/api/v3/openOrders");
    else if (this.config.id === "kraken") {
      const r = await this.request("/0/private/OpenOrders");
      rows = Object.entries(r.open).map(([id, v]: [string, any]) => ({ ...v, id }));
    } else
      rows = (await this.request("/v1/api/iserver/account/orders?force=true")).orders.filter(
        (o: any) =>
          (o.acct ?? o.account ?? o.accountId) === this.config.accountId &&
          !["Filled", "Cancelled", "Inactive"].includes(o.status),
      );
    return rows.map((r: any) => ({
      id: String(r.orderId ?? r.id ?? r.order_id),
      symbol: String(r.symbol ?? r.descr?.pair ?? r.conid),
      side: String(r.side ?? r.descr?.type).toLowerCase() === "sell" ? "sell" : "buy",
      type: "limit",
      price: Number(r.price ?? r.descr?.price),
      quantity: Number(r.origQty ?? r.vol ?? r.totalSize),
      clientOrderId: String(r.clientOrderId ?? r.cl_ord_id ?? r.order_ref ?? ""),
      status: "open",
    }));
  }
  async getBalances(): Promise<Record<string, number>> {
    if (this.config.id === "binance") {
      const r = await this.request("/api/v3/account");
      return Object.fromEntries(
        r.balances.map((b: any) => [b.asset, Number(b.free) + Number(b.locked)]),
      );
    }
    if (this.config.id === "kraken")
      return Object.fromEntries(
        Object.entries(await this.request("/0/private/Balance")).map(([k, v]) => [k, Number(v)]),
      );
    const auth = await this.request("/v1/api/iserver/auth/status", {}, "POST");
    if (!auth.authenticated || auth.competing) throw new VenueError("authentication");
    const accounts = await this.request("/v1/api/portfolio/accounts");
    const account = accounts.find((a: any) => a.accountId === this.config.accountId);
    // Paper accounts use DU identifiers. Never allow a live account through a testnet configuration.
    if (
      !account ||
      (this.config.environment === "testnet" && !String(account.accountId).startsWith("DU"))
    )
      throw new VenueError("authentication");
    const r = await this.request(
      `/v1/api/portfolio/${encodeURIComponent(this.config.accountId)}/ledger`,
    );
    const ledger = r[this.config.quoteCurrency];
    if (!ledger || !Number.isFinite(ledger.cashbalance)) throw new VenueError("contract");
    return { [this.config.quoteCurrency]: ledger.cashbalance };
  }
  async getPositions(): Promise<Position[]> {
    if (this.config.id !== "ibkr")
      return Object.entries(await this.getBalances())
        .filter(([s]) => s !== this.config.quoteCurrency)
        .map(([symbol, quantity]) => ({ symbol, quantity }));
    const r = await this.request(
      `/v1/api/portfolio/${encodeURIComponent(this.config.accountId)}/positions/0`,
    );
    if (r.length >= 100) throw new VenueError("unsupported"); // Fail closed until pagination is implemented.
    return r.map((p: any) => ({ symbol: String(p.conid), quantity: Number(p.position) }));
  }
  async placeOrder(o: OrderIntent): Promise<VenueOrder> {
    let r: any;
    let id: string;
    if (this.config.id === "binance") {
      r = await this.request(
        "/api/v3/order",
        {
          symbol: o.symbol,
          side: o.side.toUpperCase(),
          type: "LIMIT",
          timeInForce: "GTC",
          quantity: String(o.quantity),
          price: String(o.price),
          newClientOrderId: o.clientOrderId,
        },
        "POST",
      );
      id = String(r.orderId);
    } else if (this.config.id === "kraken") {
      r = await this.request("/0/private/AddOrder", {
        pair: o.symbol,
        type: o.side,
        ordertype: "limit",
        volume: String(o.quantity),
        price: String(o.price),
        cl_ord_id: o.clientOrderId,
      });
      id = r.txid?.[0];
    } else {
      // JSON orders are typed separately from query/form fields.
      r = await this.request(
        `/v1/api/iserver/account/${encodeURIComponent(this.config.accountId)}/orders`,
        {
          orders: [
            {
              conid: Number(o.symbol),
              side: o.side.toUpperCase(),
              orderType: "LMT",
              tif: "DAY",
              quantity: o.quantity,
              price: o.price,
              cOID: o.clientOrderId,
            },
          ],
        } as any,
        "POST",
      );
      // IBKR warning replies require a separate explicit workflow; never auto-confirm them.
      id = r[0]?.order_id;
    }
    if (!id || id === "undefined") throw new VenueError("contract");
    return { ...o, id: String(id), status: "submitted" };
  }
  async cancelOrder(o: VenueOrder): Promise<void> {
    if (this.config.id === "binance")
      await this.request("/api/v3/order", { symbol: o.symbol, orderId: o.id }, "DELETE");
    else if (this.config.id === "kraken")
      await this.request("/0/private/CancelOrder", { txid: o.id });
    else
      await this.request(
        `/v1/api/iserver/account/${encodeURIComponent(this.config.accountId)}/order/${encodeURIComponent(o.id)}`,
        {},
        "DELETE",
      );
  }
  async getOrderStatus(o: VenueOrder): Promise<VenueOrder> {
    let status: string;
    if (this.config.id === "binance")
      status = (await this.request("/api/v3/order", { symbol: o.symbol, orderId: o.id })).status;
    else if (this.config.id === "kraken")
      status = (await this.request("/0/private/QueryOrders", { txid: o.id }))[o.id]?.status;
    else
      status = (
        await this.request(`/v1/api/iserver/account/order/status/${encodeURIComponent(o.id)}`)
      ).order_status;
    if (!status) throw new VenueError("contract");
    return { ...o, status };
  }
  async getMarketData(symbol: string): Promise<{ price: number }> {
    let price: number;
    if (this.config.id === "binance")
      price = Number((await this.request("/api/v3/ticker/price", { symbol }, "GET", false)).price);
    else if (this.config.id === "kraken")
      price = Number(
        Object.values(await this.request("/0/public/Ticker", { pair: symbol }, "GET", false)).map(
          (v: any) => v.c[0],
        )[0],
      );
    else {
      const r = await this.request(
        `/v1/api/iserver/marketdata/snapshot?conids=${encodeURIComponent(symbol)}&fields=31`,
      );
      price = Number(r[0]?.["31"]);
    }
    if (!Number.isFinite(price) || price <= 0) throw new VenueError("contract");
    return { price };
  }
}

/** Virtual execution uses the same order/risk interface, with explicit simulated fills. */
export class PaperVenue implements ExecutionVenue {
  private readonly state: { cash: number; positions: Position[]; orders: VenueOrder[] };
  private readonly quotes: ExecutionVenue;
  constructor(
    state: { cash: number; positions: Position[]; orders: VenueOrder[] },
    quotes: ExecutionVenue,
  ) {
    this.state = state;
    this.quotes = quotes;
  }
  async getOpenOrders() {
    return this.state.orders.filter((o) => o.status !== "filled" && o.status !== "cancelled");
  }
  async getBalances() {
    return { cash: this.state.cash };
  }
  async getPositions() {
    return this.state.positions;
  }
  async getMarketData(symbol: string) {
    return this.quotes.getMarketData(symbol);
  }
  async placeOrder(o: OrderIntent) {
    const quote = await this.getMarketData(o.symbol);
    if ((o.side === "buy" && o.price < quote.price) || (o.side === "sell" && o.price > quote.price))
      throw new VenueError("unsupported");
    const cost = o.quantity * o.price;
    if (o.side === "buy" && cost > this.state.cash) throw new VenueError("rejected");
    const position = this.state.positions.find((p) => p.symbol === o.symbol);
    if (o.side === "sell" && (position?.quantity ?? 0) < o.quantity)
      throw new VenueError("rejected");
    this.state.cash += o.side === "buy" ? -cost : cost;
    if (position) position.quantity += o.side === "buy" ? o.quantity : -o.quantity;
    else this.state.positions.push({ symbol: o.symbol, quantity: o.quantity });
    const result = { ...o, id: o.clientOrderId, status: "filled" };
    this.state.orders.push(result);
    return result;
  }
  async cancelOrder(o: VenueOrder) {
    if (o.status !== "filled") o.status = "cancelled";
  }
  async getOrderStatus(o: VenueOrder) {
    return o;
  }
}
