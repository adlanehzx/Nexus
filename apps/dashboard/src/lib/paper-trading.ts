import type { PaperMarketDetail, PaperOrder, PaperOrderInput } from "./api.js";

export function paperOrderInput(
  accountId: string,
  market: PaperMarketDetail,
  side: "yes" | "no",
  probability: string,
  confidence: string,
): PaperOrderInput {
  const p = Number(probability);
  const c = Number(confidence);
  if (!accountId || market.state !== "open" || Date.parse(market.close_at) <= Date.now()) {
    throw new Error("Select an account and an open market.");
  }
  if (!market.latest_quote) throw new Error("Record a quote before submitting an order.");
  if (!Number.isFinite(p) || p <= 0 || p >= 1 || !Number.isFinite(c) || c <= 0 || c > 1) {
    throw new Error("Probability must be between 0 and 1; confidence must be in (0, 1].");
  }
  const price = market.latest_quote.yes_price_ppm / 1_000_000;
  if ((side === "yes" && p <= price) || (side === "no" && p >= price)) {
    throw new Error("Model probability must support the selected side of the quote.");
  }
  return {
    account_id: accountId,
    market_id: market.id,
    model_probability: String(p),
    confidence: String(c),
  };
}

// Shares are denominated in micro-cents by the engine, including fees/slippage.
export function paperOrderPnl(
  order: PaperOrder,
  market: PaperMarketDetail | undefined,
): number | null {
  if (order.state === "settled" && order.payout_cents !== null)
    return order.payout_cents - order.stake_cents;
  if (order.state !== "filled" || !market?.latest_quote) return null;
  const yes = market.latest_quote.yes_price_ppm;
  return (
    Math.floor(
      (order.shares_micro * (order.outcome === "yes" ? yes : 1_000_000 - yes)) / 1_000_000_000_000,
    ) - order.stake_cents
  );
}
