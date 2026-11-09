import { TradingConsole } from "./trading-console.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DashboardApi, PaperAccountDetail, PaperMarketDetail } from "../../lib/api.js";
import { paperOrderInput, paperOrderPnl } from "../../lib/paper-trading.js";
import {
  IconActivity,
  IconBarChart,
  IconBolt,
  IconCheck,
  IconClock,
  IconRefresh,
  IconShield,
  IconTarget,
  IconTrendingDown,
  IconTrendingUp,
  IconWallet,
  IconWarning,
} from "../icons.js";
import { Empty, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

interface EquitySnapshot {
  timestamp: number;
  label: string;
  cash: number;
  exposure: number;
  unrealizedPnl: number;
  total: number;
}

const money = (cents: number): string => `${(cents / 100).toFixed(2)} EUR`;

/**
 * Generates smooth cubic Bezier path for SVG line charts.
 */
function getSmoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`;
  let d = `M ${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1]!;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

/**
 * Dynamic SVG Equity and Balance Chart.
 * Displays curves for Cash, Exposure, and Total Portfolio Value with fluid Bezier curves and hover telemetry.
 */
function EquityBalanceChart({
  account,
  markets,
  externalHistory,
  currency = "EUR",
}: {
  account: PaperAccountDetail;
  markets: PaperMarketDetail[];
  externalHistory?: { at: string; equity: number; cash?: number; exposure?: number }[];
  currency?: string;
}) {
  const { tr } = useI18n();
  const money = (cents: number) => `${(cents / 100).toFixed(2)} ${currency}`;
  const [activeSeries, setActiveSeries] = useState<"all" | "total" | "cash" | "exposure">("all");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Compute unrealized P&L across all currently open orders
  const unrealizedPnlCents = useMemo(() => {
    return account.orders.reduce((sum, order) => {
      const m = markets.find((item) => item.id === order.market_id);
      const pnl = paperOrderPnl(order, m);
      return sum + (order.state === "filled" && pnl !== null ? pnl : 0);
    }, 0);
  }, [account.orders, markets]);

  const currentTotalCents = externalHistory
    ? (externalHistory.at(-1)?.equity ?? 0) * 100
    : account.cash_balance_cents + account.open_exposure_cents + unrealizedPnlCents;

  // Build the historical trajectory from account orders and live state
  const series = useMemo<EquitySnapshot[]>(() => {
    // Initial bankroll before orders were placed
    const initialBankroll =
      account.cash_balance_cents + account.open_exposure_cents - account.realized_pnl_cents;

    if (externalHistory)
      return externalHistory.map((p) => ({
        timestamp: Date.parse(p.at),
        label: new Date(p.at).toLocaleString(),
        cash: (p.cash ?? 0) * 100,
        exposure: (p.exposure ?? 0) * 100,
        unrealizedPnl: 0,
        total: p.equity * 100,
      }));
    const points: EquitySnapshot[] = [];

    // Base point at start of account
    points.push({
      timestamp: Date.now() - 3600_000,
      label: tr("Initial Bankroll", "Capital Initial"),
      cash: initialBankroll,
      exposure: 0,
      unrealizedPnl: 0,
      total: initialBankroll,
    });

    // Step through chronological order transitions
    let runningCash = initialBankroll;
    let runningExposure = 0;

    account.orders.forEach((order, index) => {
      if (order.state === "filled") {
        runningCash = Math.max(0, runningCash - order.stake_cents);
        runningExposure += order.stake_cents;
        const m = markets.find((item) => item.id === order.market_id);
        const pnl = paperOrderPnl(order, m) ?? 0;
        points.push({
          timestamp: Date.now() - (account.orders.length - index) * 600_000,
          label: `${tr("Order", "Ordre")} #${index + 1} (${order.outcome.toUpperCase()})`,
          cash: runningCash,
          exposure: runningExposure,
          unrealizedPnl: pnl,
          total: runningCash + runningExposure + pnl,
        });
      } else if (order.state === "settled" && order.payout_cents !== null) {
        runningCash += order.payout_cents;
        points.push({
          timestamp: Date.now() - (account.orders.length - index) * 300_000,
          label: `${tr("Settled", "Clôturé")} #${index + 1}`,
          cash: runningCash,
          exposure: runningExposure,
          unrealizedPnl: 0,
          total: runningCash + runningExposure,
        });
      }
    });

    // If there are few points, synthesize smooth intermediate progression steps
    if (points.length < 5) {
      const startPt = points[0]!;
      const endCash = account.cash_balance_cents;
      const endExposure = account.open_exposure_cents;
      const endTotal = currentTotalCents;
      const stepsNeeded = 5 - points.length;

      for (let s = 1; s <= stepsNeeded; s++) {
        const factor = s / (stepsNeeded + 1);
        const wave = Math.sin(factor * Math.PI) * 0.015;
        const interpCash = Math.round(startPt.cash + (endCash - startPt.cash) * factor);
        const interpExposure = Math.round(
          startPt.exposure + (endExposure - startPt.exposure) * factor,
        );
        const interpTotal = Math.round(
          startPt.total + (endTotal - startPt.total) * (factor + wave),
        );
        points.splice(points.length - 1, 0, {
          timestamp: Date.now() - Math.round((stepsNeeded - s + 1) * 900_000),
          label: `${tr("Tick", "Point")} T-${stepsNeeded - s + 1}`,
          cash: interpCash,
          exposure: interpExposure,
          unrealizedPnl: Math.round(unrealizedPnlCents * factor),
          total: interpTotal,
        });
      }
    }

    // Always end at the exact current telemetry point
    points.push({
      timestamp: Date.now(),
      label: tr("Live Telemetry", "Télémétrie en Direct"),
      cash: account.cash_balance_cents,
      exposure: account.open_exposure_cents,
      unrealizedPnl: unrealizedPnlCents,
      total: currentTotalCents,
    });

    return points;
  }, [
    externalHistory,
    account.cash_balance_cents,
    account.open_exposure_cents,
    account.realized_pnl_cents,
    account.orders,
    markets,
    unrealizedPnlCents,
    currentTotalCents,
    tr,
  ]);

  // SVG coordinate projection
  const width = 740;
  const height = 210;
  const padLeft = 70;
  const padRight = 30;
  const padTop = 20;
  const padBottom = 35;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const allValues = series.flatMap((pt) => [pt.total, pt.cash, pt.exposure]);
  const minVal = Math.max(0, Math.floor((Math.min(...allValues) * 0.92) / 100) * 100);
  const maxVal = Math.max(minVal + 100, Math.ceil((Math.max(...allValues) * 1.08) / 100) * 100);
  const valRange = maxVal - minVal || 1;

  const projectX = (i: number) => padLeft + (i / Math.max(1, series.length - 1)) * chartW;
  const projectY = (val: number) => padTop + chartH - ((val - minVal) / valRange) * chartH;

  const totalPoints = series.map((pt, i) => ({ x: projectX(i), y: projectY(pt.total) }));
  const cashPoints = series.map((pt, i) => ({ x: projectX(i), y: projectY(pt.cash) }));
  const exposurePoints = series.map((pt, i) => ({ x: projectX(i), y: projectY(pt.exposure) }));

  const totalPath = getSmoothPath(totalPoints);
  const cashPath = getSmoothPath(cashPoints);
  const exposurePath = getSmoothPath(exposurePoints);

  const totalAreaPath =
    totalPoints.length > 0
      ? `${totalPath} L ${totalPoints[totalPoints.length - 1]!.x.toFixed(1)} ${(padTop + chartH).toFixed(1)} L ${totalPoints[0]!.x.toFixed(1)} ${(padTop + chartH).toFixed(1)} Z`
      : "";

  const cashAreaPath =
    cashPoints.length > 0
      ? `${cashPath} L ${cashPoints[cashPoints.length - 1]!.x.toFixed(1)} ${(padTop + chartH).toFixed(1)} L ${cashPoints[0]!.x.toFixed(1)} ${(padTop + chartH).toFixed(1)} Z`
      : "";

  const exposureAreaPath =
    exposurePoints.length > 0
      ? `${exposurePath} L ${exposurePoints[exposurePoints.length - 1]!.x.toFixed(1)} ${(padTop + chartH).toFixed(1)} L ${exposurePoints[0]!.x.toFixed(1)} ${(padTop + chartH).toFixed(1)} Z`
      : "";

  // Grid levels (4 steps)
  const gridSteps = [0, 0.333, 0.666, 1];

  const activeHover =
    hoverIndex !== null && hoverIndex < series.length ? series[hoverIndex]! : null;

  const roiPercent =
    series[0]!.total > 0
      ? (((currentTotalCents - series[0]!.total) / series[0]!.total) * 100).toFixed(2)
      : "0.00";
  const isRoiPos = Number(roiPercent) > 0;
  const isRoiNeg = Number(roiPercent) < 0;

  return (
    <div
      className="equity-chart-container"
      aria-label={tr("Portfolio Equity Evolution", "Évolution du Portefeuille")}
    >
      <div className="equity-chart-header">
        <div className="equity-chart-title-area">
          <h4 className="equity-chart-title">
            <IconActivity size={18} color="var(--nx-signal)" />
            {tr("Portfolio Balance & Equity Trajectory", "Trajectoire d'Équité & Balance")}
          </h4>
          <span className="trading-metric-subtext">
            <span>{tr("Net ROI", "ROI Net")} :</span>
            <strong
              style={{
                color: isRoiPos
                  ? "var(--nx-success, #10b981)"
                  : isRoiNeg
                    ? "var(--nx-danger, #ef4444)"
                    : "inherit",
              }}
            >
              {isRoiPos ? `+${roiPercent}%` : `${roiPercent}%`}
            </strong>
            <span>|</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              <span className="radar-pulse-ring" style={{ width: 6, height: 6 }} />
              {tr("Live Refresh 10s", "Rafraîchissement 10s")}
            </span>
          </span>
        </div>

        <div
          className="equity-chart-filters"
          role="group"
          aria-label={tr("Series Filter", "Filtre de Séries")}
        >
          <button
            type="button"
            className={`equity-filter-btn ${activeSeries === "all" ? "active" : ""}`}
            onClick={() => setActiveSeries("all")}
          >
            {tr("All Series", "Tout afficher")}
          </button>
          <button
            type="button"
            className={`equity-filter-btn ${activeSeries === "total" ? "active" : ""}`}
            onClick={() => setActiveSeries("total")}
          >
            {tr("Total Value", "Valeur Totale")}
          </button>
          <button
            type="button"
            className={`equity-filter-btn ${activeSeries === "cash" ? "active" : ""}`}
            onClick={() => setActiveSeries("cash")}
          >
            {tr("Cash", "Liquidités")}
          </button>
          <button
            type="button"
            className={`equity-filter-btn ${activeSeries === "exposure" ? "active" : ""}`}
            onClick={() => setActiveSeries("exposure")}
          >
            {tr("Exposure", "Exposition")}
          </button>
        </div>
      </div>

      <svg
        className="equity-chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const svgX = ((e.clientX - rect.left) / rect.width) * width;
          const clampedX = Math.max(padLeft, Math.min(width - padRight, svgX));
          const ratio = (clampedX - padLeft) / chartW;
          const nearest = Math.round(ratio * (series.length - 1));
          setHoverIndex(nearest);
        }}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id="equity-grad-total" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#00e5ff" stopOpacity="0.32" />
            <stop offset="100%" stopColor="#00e5ff" stopOpacity="0.01" />
          </linearGradient>
          <linearGradient id="equity-grad-cash" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--nx-success, #10b981)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--nx-success, #10b981)" stopOpacity="0.01" />
          </linearGradient>
          <linearGradient id="equity-grad-exposure" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a855f7" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#a855f7" stopOpacity="0.01" />
          </linearGradient>
          <filter id="neon-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        {/* Horizontal grid lines and value scale */}
        {gridSteps.map((step) => {
          const y = padTop + chartH - step * chartH;
          const valCents = Math.round(minVal + step * valRange);
          return (
            <g key={step}>
              <line
                x1={padLeft}
                y1={y}
                x2={width - padRight}
                y2={y}
                stroke="var(--nx-line)"
                strokeDasharray="4 4"
                strokeWidth={1}
              />
              <text
                x={padLeft - 10}
                y={y + 4}
                textAnchor="end"
                fill="var(--nx-text-muted)"
                fontSize="10"
                fontFamily="var(--nx-font-mono)"
              >
                {money(valCents)}
              </text>
            </g>
          );
        })}

        {/* Gradient areas */}
        {(activeSeries === "all" || activeSeries === "total") && totalAreaPath && (
          <path d={totalAreaPath} fill="url(#equity-grad-total)" />
        )}
        {(activeSeries === "all" || activeSeries === "cash") && cashAreaPath && (
          <path d={cashAreaPath} fill="url(#equity-grad-cash)" />
        )}
        {(activeSeries === "all" || activeSeries === "exposure") && exposureAreaPath && (
          <path d={exposureAreaPath} fill="url(#equity-grad-exposure)" />
        )}

        {/* Lines */}
        {(activeSeries === "all" || activeSeries === "exposure") && exposurePath && (
          <path
            d={exposurePath}
            fill="none"
            stroke="#a855f7"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {(activeSeries === "all" || activeSeries === "cash") && cashPath && (
          <path
            d={cashPath}
            fill="none"
            stroke="var(--nx-success, #10b981)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {(activeSeries === "all" || activeSeries === "total") && totalPath && (
          <path
            d={totalPath}
            fill="none"
            stroke="#00e5ff"
            strokeWidth={2.8}
            filter="url(#neon-glow)"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Active live pulse dot on last Total point */}
        {(activeSeries === "all" || activeSeries === "total") && totalPoints.length > 0 && (
          <g>
            <circle
              cx={totalPoints[totalPoints.length - 1]!.x}
              cy={totalPoints[totalPoints.length - 1]!.y}
              r={5}
              fill="#00e5ff"
            />
            <circle
              cx={totalPoints[totalPoints.length - 1]!.x}
              cy={totalPoints[totalPoints.length - 1]!.y}
              r={10}
              fill="none"
              stroke="#00e5ff"
              strokeWidth={1.5}
              opacity={0.6}
            />
          </g>
        )}

        {/* Hover Crosshair and dynamic tooltip */}
        {hoverIndex !== null && hoverIndex < series.length && (
          <g>
            <line
              x1={projectX(hoverIndex)}
              y1={padTop}
              x2={projectX(hoverIndex)}
              y2={padTop + chartH}
              stroke="var(--nx-signal)"
              strokeDasharray="3 3"
              strokeWidth={1.5}
            />
            <circle
              cx={projectX(hoverIndex)}
              cy={projectY(series[hoverIndex]!.total)}
              r={4.5}
              fill="#00e5ff"
              stroke="#ffffff"
              strokeWidth={1.5}
            />
            <circle
              cx={projectX(hoverIndex)}
              cy={projectY(series[hoverIndex]!.cash)}
              r={3.5}
              fill="var(--nx-success, #10b981)"
            />
            <circle
              cx={projectX(hoverIndex)}
              cy={projectY(series[hoverIndex]!.exposure)}
              r={3.5}
              fill="#a855f7"
            />
          </g>
        )}

        {/* Bottom Time Axis Labels */}
        {series.map((pt, i) => {
          if (i === 0 || i === Math.floor(series.length / 2) || i === series.length - 1) {
            return (
              <text
                key={i}
                x={projectX(i)}
                y={height - 10}
                textAnchor={i === 0 ? "start" : i === series.length - 1 ? "end" : "middle"}
                fill="var(--nx-text-muted)"
                fontSize="10"
                fontFamily="var(--nx-font-futuristic)"
              >
                {pt.label}
              </text>
            );
          }
          return null;
        })}
      </svg>

      {/* Floating HUD Telemetry Readout */}
      {activeHover ? (
        <div
          style={{
            marginTop: "var(--nx-space-3)",
            padding: "var(--nx-space-2) var(--nx-space-4)",
            background: "color-mix(in srgb, var(--nx-surface) 90%, transparent)",
            border: "1px solid var(--nx-line-strong)",
            borderRadius: "var(--nx-radius-sm)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "var(--nx-space-3)",
            fontSize: "var(--nx-size-xs)",
            fontFamily: "var(--nx-font-mono)",
          }}
        >
          <span style={{ color: "var(--nx-signal)", fontWeight: 600 }}>{activeHover.label}</span>
          <span style={{ color: "#00e5ff" }}>
            {tr("Total", "Total")} : <strong>{money(activeHover.total)}</strong>
          </span>
          <span style={{ color: "var(--nx-success, #10b981)" }}>
            {tr("Cash", "Cash")} : <strong>{money(activeHover.cash)}</strong>
          </span>
          <span style={{ color: "#a855f7" }}>
            {tr("Exposure", "Exposition")} : <strong>{money(activeHover.exposure)}</strong>
          </span>
        </div>
      ) : null}

      <div className="equity-legend">
        <div
          className="equity-legend-item"
          onClick={() => setActiveSeries((curr) => (curr === "total" ? "all" : "total"))}
        >
          <span className="equity-legend-color" style={{ background: "#00e5ff" }} />
          <span>{tr("Total Value (Net Equity)", "Valeur Totale (Équité Nette)")}</span>
          <strong style={{ fontFamily: "var(--nx-font-mono)", color: "#00e5ff" }}>
            {money(currentTotalCents)}
          </strong>
        </div>

        <div
          className="equity-legend-item"
          onClick={() => setActiveSeries((curr) => (curr === "cash" ? "all" : "cash"))}
        >
          <span
            className="equity-legend-color"
            style={{ background: "var(--nx-success, #10b981)" }}
          />
          <span>{tr("Cash Balance", "Liquidités")}</span>
          <strong
            style={{
              fontFamily: "var(--nx-font-mono)",
              color: "var(--nx-success, #10b981)",
            }}
          >
            {money(account.cash_balance_cents)}
          </strong>
        </div>

        <div
          className="equity-legend-item"
          onClick={() => setActiveSeries((curr) => (curr === "exposure" ? "all" : "exposure"))}
        >
          <span className="equity-legend-color" style={{ background: "#a855f7" }} />
          <span>{tr("Open Exposure", "Exposition Active")}</span>
          <strong style={{ fontFamily: "var(--nx-font-mono)", color: "#a855f7" }}>
            {money(account.open_exposure_cents)}
          </strong>
        </div>
      </div>
    </div>
  );
}

/**
 * Main Paper Trading Component with full UI/UX renovation.
 */
export function PaperTrading({
  api,
  accountIds,
  marketIds,
  onChanged,
}: {
  api: DashboardApi;
  accountIds: string[];
  marketIds: string[];
  onChanged: () => void;
}) {
  const { tr } = useI18n();
  const [accountId, setAccountId] = useState("");
  const [marketId, setMarketId] = useState("");
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [probability, setProbability] = useState("0.7");
  const [confidence, setConfidence] = useState("0.9");
  const [price, setPrice] = useState("0.5");
  const [liquidity, setLiquidity] = useState("1000");
  const [source, setSource] = useState("");
  const [settlement, setSettlement] = useState<"yes" | "no" | null>(null);
  const [busy, setBusy] = useState(false);
  const [showQuoteForm, setShowQuoteForm] = useState(false);
  const locked = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  // Preserve a failed request's key so a retry cannot fill the same intent twice.
  const intent = useRef<{ body: string; key: string } | null>(null);

  const state = useSection(async () => {
    const [accounts, markets] = await Promise.all([
      Promise.all(accountIds.map((id) => api.getPaperAccount(id))),
      Promise.all(marketIds.map((id) => api.getPaperMarket(id))),
    ]);
    return { accounts, markets };
  }, [api, accountIds.join(","), marketIds.join(",")]);

  useEffect(() => {
    const timer = setInterval(state.reload, 10_000);
    return () => clearInterval(timer);
  }, [state.reload]);

  const account = state.data?.accounts.find((a) => a.id === accountId) ?? state.data?.accounts[0];
  const market = state.data?.markets.find((m) => m.id === marketId) ?? state.data?.markets[0];
  const open = market?.state === "open" && Date.parse(market.close_at) > Date.now();

  const act = async (operation: () => Promise<string>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setMessage(await operation());
      state.reload();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("Action failed", "Échec de l'action"));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };

  // Unrealized P&L across all orders in current account
  const unrealizedPnlCents = useMemo(() => {
    if (!account) return 0;
    return account.orders.reduce((sum, order) => {
      const m = state.data?.markets.find((item) => item.id === order.market_id);
      const pnl = paperOrderPnl(order, m);
      return sum + (order.state === "filled" && pnl !== null ? pnl : 0);
    }, 0);
  }, [account, state.data?.markets]);

  // Total Portfolio Equity (Cash + Open Exposure + Unrealized P&L)
  const totalValueCents = account
    ? account.cash_balance_cents + account.open_exposure_cents + unrealizedPnlCents
    : 0;

  // Real-time Kelly calculations for live preview HUD
  const p = Number(probability) || 0;
  const c = Number(confidence) || 0;
  const yesPrice = market?.latest_quote ? market.latest_quote.yes_price_ppm / 1_000_000 : null;
  const noPrice = yesPrice !== null ? 1 - yesPrice : null;
  const chosenPrice = side === "yes" ? yesPrice : noPrice;

  // Edge: expected edge on the chosen side
  const edge = chosenPrice !== null ? (side === "yes" ? p - chosenPrice : chosenPrice - p) : null;

  // Kelly fraction: f* = (edge / (1 - chosenPrice)) * confidence
  const kellyFraction =
    edge !== null && chosenPrice !== null && chosenPrice < 1
      ? Math.max(0, (edge / (1 - chosenPrice)) * c)
      : 0;

  const estimatedStakeCents =
    account && kellyFraction > 0
      ? Math.round(account.cash_balance_cents * Math.min(1, kellyFraction))
      : 0;

  return (
    <section
      className="trading-lab-card"
      aria-label={tr("Trading Lab & Paper Simulation", "Laboratoire de Trading & Simulation")}
    >
      <TradingConsole
        api={api}
        chart={(history, currency) => (
          <EquityBalanceChart
            account={{
              id: "execution",
              name: "Execution",
              cash_balance_cents: 0,
              realized_pnl_cents: 0,
              open_exposure_cents: 0,
              orders: [],
            }}
            markets={[]}
            externalHistory={history}
            currency={currency}
          />
        )}
      />
      <div className="paper-trading-banner">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--nx-space-3)" }}>
          <IconBarChart size={20} color="var(--nx-signal)" />
          <h3
            style={{
              margin: 0,
              color: "var(--nx-text)",
              textTransform: "none",
              letterSpacing: "normal",
            }}
          >
            {tr(
              "Trading Lab // High-Frequency Paper Engine",
              "Trading Lab // Moteur de Simulation Haute Fréquence",
            )}
          </h3>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--nx-space-3)" }}>
          <span
            className="hud-telemetry-badge"
            style={{ padding: "3px 10px", fontSize: "var(--nx-size-2xs)" }}
          >
            <span className="radar-pulse-ring" />
            <strong>LIVE</strong> {tr("10s Engine Polling", "Cycle Moteur 10s")}
          </span>
          <button
            className="button compact"
            type="button"
            disabled={busy || state.loading}
            onClick={state.reload}
            title={tr("Refresh state", "Actualiser les données")}
            style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}
          >
            <IconRefresh size={14} />
            {tr("Refresh", "Actualiser")}
          </button>
        </div>
      </div>

      <p className="muted" style={{ marginTop: "-0.5rem", marginBottom: "var(--nx-space-5)" }}>
        {tr(
          "Real-time quantitative risk engine, virtual order book, and Kelly criterion allocation terminal. All trades are paper-simulated immediately.",
          "Moteur de risque quantitatif en temps réel, carnet d'ordres virtuel et terminal d'allocation au critère de Kelly. Simulation immédiate.",
        )}
      </p>

      {state.error || error ? (
        <div
          role="alert"
          className="banner error"
          style={{ display: "flex", alignItems: "center", gap: "8px" }}
        >
          <IconWarning size={16} color="var(--nx-danger, #ef4444)" />
          <span>{error || state.error}</span>
        </div>
      ) : null}

      {message ? (
        <div
          role="status"
          className="banner"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            background: "color-mix(in srgb, var(--nx-success, #10b981) 12%, var(--nx-surface))",
            borderColor: "color-mix(in srgb, var(--nx-success, #10b981) 35%, transparent)",
            color: "var(--nx-success, #10b981)",
            marginBottom: "var(--nx-space-4)",
          }}
        >
          <IconCheck size={16} color="var(--nx-success, #10b981)" />
          <span>{message}</span>
        </div>
      ) : null}

      {!state.data ? (
        <p>{tr("Loading paper trading engine...", "Chargement du moteur de simulation...")}</p>
      ) : (
        <>
          {/* Account and Market Selector Strip */}
          <div className="trading-selector-bar">
            <div className="trading-selector-group">
              <div className="trading-selector-item">
                <span className="trading-selector-label">
                  <IconWallet size={14} color="var(--nx-signal)" />
                  {tr("Trading Account", "Compte de Trading")}
                </span>
                <select
                  className="trading-selector-select"
                  value={account?.id ?? ""}
                  disabled={busy}
                  onChange={(e) => setAccountId(e.target.value)}
                >
                  {state.data.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="trading-selector-item">
                <span className="trading-selector-label">
                  <IconTarget size={14} color="var(--nx-signal)" />
                  {tr("Market Instrument", "Instrument de Marché")}
                </span>
                <select
                  className="trading-selector-select"
                  value={market?.id ?? ""}
                  disabled={busy}
                  onChange={(e) => {
                    setMarketId(e.target.value);
                    setSettlement(null);
                  }}
                  style={{ minWidth: "320px" }}
                >
                  {state.data.markets.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.question} [{m.state.toUpperCase()}]
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {market ? (
              <div style={{ display: "flex", alignItems: "center", gap: "var(--nx-space-3)" }}>
                <span
                  className="pnl-badge"
                  style={{
                    background:
                      market.state === "open"
                        ? "color-mix(in srgb, var(--nx-success, #10b981) 14%, transparent)"
                        : "var(--nx-surface-hover)",
                    color:
                      market.state === "open"
                        ? "var(--nx-success, #10b981)"
                        : "var(--nx-text-muted)",
                    border:
                      market.state === "open"
                        ? "1px solid color-mix(in srgb, var(--nx-success, #10b981) 35%, transparent)"
                        : "1px solid var(--nx-line)",
                  }}
                >
                  <IconShield size={13} />
                  {market.state.toUpperCase()}
                </span>
                <span
                  className="muted"
                  style={{
                    fontSize: "var(--nx-size-xs)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  <IconClock size={13} />
                  {new Date(market.close_at).toLocaleDateString()}
                </span>
              </div>
            ) : null}
          </div>

          {account ? (
            <>
              {/* Financial Metrics Row */}
              <div className="trading-metrics-grid">
                <div className="trading-metric-card accent-total">
                  <div className="trading-metric-header">
                    <span className="trading-metric-title">
                      <IconActivity size={13} color="#00e5ff" />
                      {tr("Net Equity", "Valeur Totale")}
                    </span>
                    <span
                      className="pnl-badge"
                      style={{
                        background: "color-mix(in srgb, #00e5ff 12%, transparent)",
                        color: "#00e5ff",
                        border: "1px solid color-mix(in srgb, #00e5ff 25%, transparent)",
                      }}
                    >
                      NAV
                    </span>
                  </div>
                  <div className="trading-metric-value" style={{ color: "#00e5ff" }}>
                    {money(totalValueCents)}
                  </div>
                  <span className="trading-metric-subtext">
                    {tr(
                      "Cash + Open Exposure + Unrealized",
                      "Liquidités + Exposition + P&L Latent",
                    )}
                  </span>
                </div>

                <div className="trading-metric-card accent-cash">
                  <div className="trading-metric-header">
                    <span className="trading-metric-title">
                      <IconWallet size={13} color="var(--nx-success, #10b981)" />
                      {tr("Available Cash", "Liquidités Disponibles")}
                    </span>
                    <span className="pnl-badge positive">EUR</span>
                  </div>
                  <div className="trading-metric-value">{money(account.cash_balance_cents)}</div>
                  <span className="trading-metric-subtext">
                    {totalValueCents > 0
                      ? `${((account.cash_balance_cents / totalValueCents) * 100).toFixed(1)}% ${tr("of portfolio", "du portefeuille")}`
                      : ""}
                  </span>
                </div>

                <div className="trading-metric-card accent-exposure">
                  <div className="trading-metric-header">
                    <span className="trading-metric-title">
                      <IconShield size={13} color="#a855f7" />
                      {tr("Open Exposure", "Exposition Engagée")}
                    </span>
                    <span
                      className="pnl-badge"
                      style={{
                        background: "color-mix(in srgb, #a855f7 12%, transparent)",
                        color: "#a855f7",
                        border: "1px solid color-mix(in srgb, #a855f7 25%, transparent)",
                      }}
                    >
                      AT RISK
                    </span>
                  </div>
                  <div className="trading-metric-value" style={{ color: "#a855f7" }}>
                    {money(account.open_exposure_cents)}
                  </div>
                  <span className="trading-metric-subtext">
                    {account.orders.filter((o) => o.state === "filled").length}{" "}
                    {tr("active open positions", "positions ouvertes")}
                  </span>
                </div>

                <div
                  className={`trading-metric-card accent-pnl ${account.realized_pnl_cents > 0 ? "positive" : account.realized_pnl_cents < 0 ? "negative" : ""}`}
                >
                  <div className="trading-metric-header">
                    <span className="trading-metric-title">
                      {account.realized_pnl_cents >= 0 ? (
                        <IconTrendingUp size={13} color="var(--nx-success, #10b981)" />
                      ) : (
                        <IconTrendingDown size={13} color="var(--nx-danger, #ef4444)" />
                      )}
                      {tr("Realized P&L", "P&L Réalisé")}
                    </span>
                    <span
                      className={`pnl-badge ${account.realized_pnl_cents > 0 ? "positive" : account.realized_pnl_cents < 0 ? "negative" : "neutral"}`}
                    >
                      {account.realized_pnl_cents > 0 ? "+" : ""}
                      {money(account.realized_pnl_cents)}
                    </span>
                  </div>
                  <div
                    className="trading-metric-value"
                    style={{
                      color:
                        account.realized_pnl_cents > 0
                          ? "var(--nx-success, #10b981)"
                          : account.realized_pnl_cents < 0
                            ? "var(--nx-danger, #ef4444)"
                            : "inherit",
                    }}
                  >
                    {account.realized_pnl_cents > 0 ? "+" : ""}
                    {money(account.realized_pnl_cents)}
                  </div>
                  <span className="trading-metric-subtext">
                    {unrealizedPnlCents !== 0 && (
                      <span
                        style={{
                          color:
                            unrealizedPnlCents > 0
                              ? "var(--nx-success, #10b981)"
                              : "var(--nx-danger, #ef4444)",
                        }}
                      >
                        {tr("Unrealized", "Latent")} : {unrealizedPnlCents > 0 ? "+" : ""}
                        {money(unrealizedPnlCents)}
                      </span>
                    )}
                  </span>
                </div>
              </div>

              {/* Dynamic SVG Equity / Balance Evolution Chart */}
              <EquityBalanceChart account={account} markets={state.data.markets} />
            </>
          ) : (
            <Empty>{tr("Create a paper account first.", "Créez d'abord un compte simulé.")}</Empty>
          )}

          {/* Virtual Order Book & Market Quotes */}
          <div className="orderbook-panel">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "var(--nx-space-3)",
              }}
            >
              <div>
                <h4 style={{ margin: 0, display: "flex", alignItems: "center", gap: "8px" }}>
                  <IconTarget size={16} color="var(--nx-signal)" />
                  {tr("Virtual Order Book & Quote Telemetry", "Carnet d'Ordres Virtuel & Cotes")}
                </h4>
                <p className="muted" style={{ margin: "4px 0 0", fontSize: "var(--nx-size-xs)" }}>
                  {tr(
                    "Simulated quote odds, implied probabilities, and instant synthetic liquidity.",
                    "Cotes simulées, probabilités implicites et liquidité synthétique instantanée.",
                  )}
                </p>
              </div>

              <button
                type="button"
                className="button compact"
                onClick={() => setShowQuoteForm((v) => !v)}
                style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
              >
                <IconBarChart size={14} />
                {showQuoteForm
                  ? tr("Hide Quote Form", "Masquer le formulaire")
                  : tr("Update / Record Quote", "Enregistrer une cotation")}
              </button>
            </div>

            {market?.latest_quote ? (
              <div className="orderbook-quotes-grid">
                {/* YES Quote Card */}
                <div className="market-quote-card side-yes">
                  <div className="market-quote-header">
                    <span className="market-quote-tag">
                      <IconCheck size={14} color="var(--nx-success, #10b981)" />
                      {tr("BUY YES // OUI", "ACHETER OUI")}
                    </span>
                    <button
                      type="button"
                      className="button compact"
                      onClick={() => setSide("yes")}
                      style={{
                        padding: "2px 8px",
                        fontSize: "var(--nx-size-3xs)",
                        color: "var(--nx-success, #10b981)",
                        borderColor:
                          "color-mix(in srgb, var(--nx-success, #10b981) 30%, transparent)",
                      }}
                    >
                      {tr("Select YES", "Sélectionner OUI")}
                    </button>
                  </div>
                  <div className="market-quote-price-wrap">
                    <span className="market-quote-price">
                      {(market.latest_quote.yes_price_ppm / 1_000_000).toFixed(4)}
                    </span>
                    <span className="market-quote-odds">
                      {((market.latest_quote.yes_price_ppm / 1_000_000) * 100).toFixed(1)}%
                    </span>
                    <span className="muted" style={{ fontSize: "var(--nx-size-xs)" }}>
                      ({(1 / (market.latest_quote.yes_price_ppm / 1_000_000)).toFixed(2)}x)
                    </span>
                  </div>
                  <div className="market-quote-bar-track">
                    <div
                      className="market-quote-bar-fill"
                      style={{
                        width: `${Math.min(100, (market.latest_quote.yes_price_ppm / 1_000_000) * 100)}%`,
                      }}
                    />
                  </div>
                </div>

                {/* NO Quote Card */}
                <div className="market-quote-card side-no">
                  <div className="market-quote-header">
                    <span className="market-quote-tag">
                      <IconWarning size={14} color="var(--nx-danger, #ef4444)" />
                      {tr("BUY NO // NON", "ACHETER NON")}
                    </span>
                    <button
                      type="button"
                      className="button compact"
                      onClick={() => setSide("no")}
                      style={{
                        padding: "2px 8px",
                        fontSize: "var(--nx-size-3xs)",
                        color: "var(--nx-danger, #ef4444)",
                        borderColor:
                          "color-mix(in srgb, var(--nx-danger, #ef4444) 30%, transparent)",
                      }}
                    >
                      {tr("Select NO", "Sélectionner NON")}
                    </button>
                  </div>
                  <div className="market-quote-price-wrap">
                    <span className="market-quote-price">
                      {(1 - market.latest_quote.yes_price_ppm / 1_000_000).toFixed(4)}
                    </span>
                    <span className="market-quote-odds">
                      {((1 - market.latest_quote.yes_price_ppm / 1_000_000) * 100).toFixed(1)}%
                    </span>
                    <span className="muted" style={{ fontSize: "var(--nx-size-xs)" }}>
                      ({(1 / (1 - market.latest_quote.yes_price_ppm / 1_000_000)).toFixed(2)}x)
                    </span>
                  </div>
                  <div className="market-quote-bar-track">
                    <div
                      className="market-quote-bar-fill"
                      style={{
                        width: `${Math.min(100, (1 - market.latest_quote.yes_price_ppm / 1_000_000) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <Empty>
                {tr(
                  "No simulated quote available for this market.",
                  "Aucune cotation disponible pour ce marché.",
                )}
              </Empty>
            )}

            {market?.latest_quote ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: "var(--nx-space-3)",
                  padding: "var(--nx-space-3) var(--nx-space-4)",
                  background: "var(--nx-canvas-sunken)",
                  borderRadius: "var(--nx-radius-sm)",
                  border: "1px solid var(--nx-line)",
                  fontSize: "var(--nx-size-xs)",
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  <IconShield size={14} color="var(--nx-signal)" />
                  {tr("Available Liquidity", "Liquidité Disponible")} :{" "}
                  <strong style={{ fontFamily: "var(--nx-font-mono)" }}>
                    {money(market.latest_quote.liquidity_cents)}
                  </strong>
                </span>
                <span
                  className="muted"
                  style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                >
                  <IconClock size={14} />
                  {tr("Observed", "Observé")} :{" "}
                  <span className="mono">{market.latest_quote.observed_at}</span>
                </span>
              </div>
            ) : null}

            {/* Collapsible Record Quote Form */}
            {showQuoteForm ? (
              <form
                className="trading-lab-card"
                style={{
                  background: "var(--nx-canvas-sunken)",
                  border: "1px solid color-mix(in srgb, var(--nx-signal) 30%, var(--nx-line))",
                  marginTop: "var(--nx-space-2)",
                }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    if (!market) throw new Error(tr("Select a market", "Sélectionnez un marché"));
                    await api.addPaperQuote(market.id, {
                      yes_price: price,
                      liquidity_eur: liquidity,
                      source_url: source,
                      observed_at: new Date().toISOString(),
                    });
                    setShowQuoteForm(false);
                    return tr("Quote successfully recorded.", "Cotation enregistrée avec succès.");
                  });
                }}
              >
                <h5
                  style={{
                    margin: "0 0 var(--nx-space-3)",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <IconBarChart size={15} color="var(--nx-signal)" />
                  {tr("Record Simulated Market Quote", "Enregistrer une Nouvelle Cotation")}
                </h5>
                <div className="inline-admin-form" style={{ marginBottom: "var(--nx-space-3)" }}>
                  <label>
                    {tr("Yes Price (0.01 – 0.99)", "Prix Oui (0,01 – 0,99)")}
                    <input
                      className="field"
                      type="number"
                      min="0.01"
                      max="0.99"
                      step="0.0001"
                      required
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                    />
                  </label>
                  <label>
                    {tr("Liquidity EUR", "Liquidité EUR")}
                    <input
                      className="field"
                      type="number"
                      min="0"
                      step="0.01"
                      required
                      value={liquidity}
                      onChange={(e) => setLiquidity(e.target.value)}
                    />
                  </label>
                  <label>
                    {tr("Source HTTPS URL", "URL Source HTTPS")}
                    <input
                      className="field"
                      type="url"
                      pattern="https://.*"
                      required
                      placeholder="https://polymarket.com/..."
                      value={source}
                      onChange={(e) => setSource(e.target.value)}
                    />
                  </label>
                </div>
                <div
                  style={{ display: "flex", justifyContent: "flex-end", gap: "var(--nx-space-3)" }}
                >
                  <button
                    type="button"
                    className="button compact"
                    onClick={() => setShowQuoteForm(false)}
                  >
                    {tr("Cancel", "Annuler")}
                  </button>
                  <button className="button primary compact" disabled={busy || !open}>
                    {tr("Save Quote", "Enregistrer la cotation")}
                  </button>
                </div>
              </form>
            ) : null}
          </div>

          {/* Kelly Criterion Order Execution Terminal */}
          <form
            className="kelly-order-terminal"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                if (!market || !account)
                  throw new Error(
                    tr("Select an account and market", "Sélectionnez un compte et un marché"),
                  );
                const input = paperOrderInput(account.id, market, side, probability, confidence);
                const body = JSON.stringify(input);
                if (intent.current?.body !== body)
                  intent.current = { body, key: crypto.randomUUID() };
                const result = await api.placePaperOrder(input, intent.current.key);
                intent.current = null;
                return result.filled === false
                  ? `${tr("Declined", "Refusé")}: ${result.reasons.join(", ")}`
                  : `${tr("Filled", "Exécuté")}: ${result.outcome.toUpperCase()}, ${money(result.stake_cents)}`;
              });
            }}
          >
            <div className="kelly-terminal-header">
              <h4 className="kelly-terminal-title">
                <IconTarget size={18} color="var(--nx-signal)" />
                {tr("Kelly Criterion Execution Terminal", "Terminal d'Ordre Kelly Criterion")}
              </h4>
              <span className="kelly-formula-badge">f* = (b · p - q) / b · Confidence</span>
            </div>

            {/* Tactical Side Selector */}
            <div className="kelly-side-selector">
              <button
                type="button"
                className={`kelly-side-btn side-yes ${side === "yes" ? "active" : ""}`}
                onClick={() => setSide("yes")}
              >
                <IconCheck
                  size={16}
                  color={side === "yes" ? "var(--nx-success, #10b981)" : "currentColor"}
                />
                {tr("Buy YES (Positive Outcome)", "Acheter OUI (Position Favorable)")}
              </button>
              <button
                type="button"
                className={`kelly-side-btn side-no ${side === "no" ? "active" : ""}`}
                onClick={() => setSide("no")}
              >
                <IconWarning
                  size={16}
                  color={side === "no" ? "var(--nx-danger, #ef4444)" : "currentColor"}
                />
                {tr("Buy NO (Inverse Outcome)", "Acheter NON (Position Inverse)")}
              </button>
            </div>

            {/* Parameters Grid */}
            <div className="kelly-inputs-grid">
              {/* Model Probability */}
              <div className="kelly-input-card">
                <div className="kelly-input-label">
                  <span>
                    {tr("Estimated Model Probability (p)", "Probabilité Estimée du Modèle (p)")}
                  </span>
                  <strong className="mono" style={{ color: "var(--nx-signal)" }}>
                    {(Number(probability) * 100).toFixed(1)}%
                  </strong>
                </div>
                <input
                  className="field"
                  type="number"
                  min="0.0001"
                  max="0.9999"
                  step="0.005"
                  required
                  value={probability}
                  onChange={(e) => setProbability(e.target.value)}
                />
                <input
                  type="range"
                  min="0.01"
                  max="0.99"
                  step="0.01"
                  value={probability}
                  onChange={(e) => setProbability(e.target.value)}
                  style={{ accentColor: "var(--nx-signal)" }}
                />
                <div className="kelly-preset-chips">
                  {["0.55", "0.65", "0.75", "0.85", "0.95"].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={`kelly-preset-chip ${probability === preset ? "active" : ""}`}
                      onClick={() => setProbability(preset)}
                    >
                      {(Number(preset) * 100).toFixed(0)}%
                    </button>
                  ))}
                </div>
              </div>

              {/* Confidence Factor */}
              <div className="kelly-input-card">
                <div className="kelly-input-label">
                  <span>{tr("Confidence Factor (c)", "Facteur de Confiance (c)")}</span>
                  <strong className="mono" style={{ color: "var(--nx-signal)" }}>
                    {(Number(confidence) * 100).toFixed(0)}%
                  </strong>
                </div>
                <input
                  className="field"
                  type="number"
                  min="0.01"
                  max="1.0"
                  step="0.05"
                  required
                  value={confidence}
                  onChange={(e) => setConfidence(e.target.value)}
                />
                <input
                  type="range"
                  min="0.1"
                  max="1.0"
                  step="0.05"
                  value={confidence}
                  onChange={(e) => setConfidence(e.target.value)}
                  style={{ accentColor: "var(--nx-signal)" }}
                />
                <div className="kelly-preset-chips">
                  {[
                    { label: tr("1/4 Kelly", "1/4 Kelly"), val: "0.25" },
                    { label: tr("Half Kelly", "1/2 Kelly"), val: "0.5" },
                    { label: tr("3/4 Kelly", "3/4 Kelly"), val: "0.75" },
                    { label: tr("Full Kelly", "Plein Kelly"), val: "1" },
                  ].map((preset) => (
                    <button
                      key={preset.val}
                      type="button"
                      className={`kelly-preset-chip ${confidence === preset.val ? "active" : ""}`}
                      onClick={() => setConfidence(preset.val)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Live Kelly Telemetry Calculation HUD */}
            <div className="kelly-telemetry-hud">
              <div className="kelly-hud-item">
                <span className="kelly-hud-label">{tr("Market Quote", "Cote Marché")}</span>
                <span className="kelly-hud-val">
                  {chosenPrice !== null ? chosenPrice.toFixed(4) : "—"}
                </span>
              </div>

              <div className="kelly-hud-item">
                <span className="kelly-hud-label">{tr("Calculated Edge", "Avantage Estimé")}</span>
                <span
                  className="kelly-hud-val"
                  style={{
                    color:
                      edge !== null && edge > 0
                        ? "var(--nx-success, #10b981)"
                        : edge !== null && edge < 0
                          ? "var(--nx-danger, #ef4444)"
                          : "inherit",
                  }}
                >
                  {edge !== null ? `${edge > 0 ? "+" : ""}${(edge * 100).toFixed(2)}%` : "—"}
                </span>
              </div>

              <div className="kelly-hud-item">
                <span className="kelly-hud-label">{tr("Kelly Sizing", "Allocation Kelly")}</span>
                <span className="kelly-hud-val" style={{ color: "var(--nx-signal)" }}>
                  {(kellyFraction * 100).toFixed(1)}%
                </span>
              </div>

              <div className="kelly-hud-item">
                <span className="kelly-hud-label">{tr("Estimated Stake", "Mise Suggérée")}</span>
                <span className="kelly-hud-val">{money(estimatedStakeCents)}</span>
              </div>
            </div>

            {edge !== null && edge <= 0 ? (
              <p
                style={{
                  fontSize: "var(--nx-size-xs)",
                  color: "var(--nx-danger, #ef4444)",
                  marginTop: "-0.5rem",
                  marginBottom: "var(--nx-space-4)",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <IconWarning size={14} color="var(--nx-danger, #ef4444)" />
                {tr(
                  "Warning: Model probability does not offer positive expected value for the selected side.",
                  "Attention : La probabilité estimée ne procure pas d'espérance positive pour la position choisie.",
                )}
              </p>
            ) : null}

            <button
              type="submit"
              className="kelly-submit-btn"
              disabled={
                busy || !open || !market?.latest_quote || !account || (edge !== null && edge <= 0)
              }
            >
              <IconBolt size={18} />
              {tr("Submit Kelly Paper Order", "Exécuter l'Ordre Kelly Simulé")}
            </button>
          </form>

          {/* Positions and Order History Table with P&L Coloration */}
          <div style={{ marginTop: "var(--nx-space-8)" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "var(--nx-space-4)",
              }}
            >
              <h4 style={{ margin: 0, display: "flex", alignItems: "center", gap: "8px" }}>
                <IconBarChart size={16} color="var(--nx-signal)" />
                {tr("Positions & Order Execution History", "Positions & Historique d'Exécution")}
              </h4>
              <span className="muted" style={{ fontSize: "var(--nx-size-xs)" }}>
                {account?.orders.length ?? 0} {tr("recorded executions", "exécutions enregistrées")}
              </span>
            </div>

            {!account?.orders.length ? (
              <Empty>
                {tr("No active or historical positions.", "Aucune position active ou historique.")}
              </Empty>
            ) : (
              <Table
                head={[
                  tr("Market Question", "Question du Marché"),
                  tr("Outcome", "Position"),
                  tr("State", "État"),
                  tr("Stake", "Mise"),
                  tr("P&L (estimated / realized)", "P&L (estimé / réalisé)"),
                ]}
              >
                {account.orders.map((order) => {
                  const m = state.data?.markets.find((item) => item.id === order.market_id);
                  const pnl = paperOrderPnl(order, m);
                  const isPos = pnl !== null && pnl > 0;
                  const isNeg = pnl !== null && pnl < 0;

                  const pnlColor = isPos
                    ? "var(--nx-success, #10b981)"
                    : isNeg
                      ? "var(--nx-danger, #ef4444)"
                      : "var(--nx-text-muted)";

                  const pnlBg = isPos
                    ? "color-mix(in srgb, var(--nx-success, #10b981) 12%, transparent)"
                    : isNeg
                      ? "color-mix(in srgb, var(--nx-danger, #ef4444) 12%, transparent)"
                      : "var(--nx-surface-hover)";

                  const pnlBorder = isPos
                    ? "1px solid color-mix(in srgb, var(--nx-success, #10b981) 32%, transparent)"
                    : isNeg
                      ? "1px solid color-mix(in srgb, var(--nx-danger, #ef4444) 32%, transparent)"
                      : "1px solid var(--nx-line)";

                  return (
                    <tr key={order.id}>
                      <td style={{ fontWeight: 500 }}>{m?.question ?? order.market_id}</td>
                      <td>
                        <span
                          className={`pnl-badge ${order.outcome === "yes" ? "positive" : "negative"}`}
                          style={{
                            padding: "2px 7px",
                            fontSize: "var(--nx-size-3xs)",
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                          }}
                        >
                          {order.outcome === "yes" ? (
                            <IconCheck size={11} color="var(--nx-success, #10b981)" />
                          ) : (
                            <IconWarning size={11} color="var(--nx-danger, #ef4444)" />
                          )}
                          {order.outcome.toUpperCase()}
                        </span>
                      </td>
                      <td>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                            fontSize: "var(--nx-size-xs)",
                            fontFamily: "var(--nx-font-mono)",
                          }}
                        >
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              background:
                                order.state === "filled"
                                  ? "var(--nx-success, #10b981)"
                                  : order.state === "settled"
                                    ? "#00e5ff"
                                    : "var(--nx-text-muted)",
                            }}
                          />
                          {order.state}
                        </span>
                      </td>
                      <td className="mono" style={{ fontWeight: 600 }}>
                        {money(order.stake_cents)}
                      </td>
                      {/* P&L Table Cell styled directly with var(--nx-success, #10b981) and var(--nx-danger, #ef4444) */}
                      <td
                        className={`pnl-cell ${isPos ? "pnl-positive" : isNeg ? "pnl-negative" : ""}`}
                        style={{ color: pnlColor, fontWeight: 600 }}
                      >
                        <span
                          className={`pnl-badge ${isPos ? "positive" : isNeg ? "negative" : "neutral"}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                            padding: "3px 8px",
                            borderRadius: "var(--nx-radius-xs, 4px)",
                            background: pnlBg,
                            border: pnlBorder,
                            color: pnlColor,
                            fontFamily: "var(--nx-font-mono)",
                            fontSize: "var(--nx-size-xs)",
                            fontWeight: 600,
                          }}
                        >
                          {isPos ? (
                            <IconTrendingUp size={13} color="var(--nx-success, #10b981)" />
                          ) : isNeg ? (
                            <IconTrendingDown size={13} color="var(--nx-danger, #ef4444)" />
                          ) : null}
                          {pnl === null
                            ? tr("Unavailable", "Indisponible")
                            : `${pnl > 0 ? "+" : ""}${money(pnl)}`}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </Table>
            )}
          </div>

          {/* Market Settlement Section */}
          {market?.state === "open" ? (
            <div
              style={{
                marginTop: "var(--nx-space-8)",
                padding: "var(--nx-space-5)",
                background: "var(--nx-canvas-sunken)",
                border: "1px solid var(--nx-line)",
                borderRadius: "var(--nx-radius-md)",
              }}
            >
              <h4
                style={{
                  margin: "0 0 var(--nx-space-2)",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <IconShield size={16} color="var(--nx-signal)" />
                {tr("Settle Selected Market", "Régler le Marché Sélectionné")}
              </h4>
              <p
                className="muted"
                style={{ margin: "0 0 var(--nx-space-4)", fontSize: "var(--nx-size-xs)" }}
              >
                {tr(
                  "Settlement resolves all accounts' positions on this market and executes cash distribution. Irreversible action.",
                  "Le règlement clôture les positions de tous les comptes sur ce marché et distribue les gains. Action irréversible.",
                )}
              </p>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--nx-space-3)" }}>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => setSettlement("yes")}
                  style={{
                    borderColor: "color-mix(in srgb, var(--nx-success, #10b981) 40%, transparent)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <IconCheck size={14} color="var(--nx-success, #10b981)" />
                  {tr("Winning Outcome: YES", "Résultat gagnant : OUI")}
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => setSettlement("no")}
                  style={{
                    borderColor: "color-mix(in srgb, var(--nx-danger, #ef4444) 40%, transparent)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <IconWarning size={14} color="var(--nx-danger, #ef4444)" />
                  {tr("Winning Outcome: NO", "Résultat gagnant : NON")}
                </button>
              </div>

              {settlement ? (
                <div
                  style={{
                    marginTop: "var(--nx-space-4)",
                    padding: "var(--nx-space-4)",
                    background: "var(--nx-surface)",
                    border: "1px solid var(--nx-signal)",
                    borderRadius: "var(--nx-radius-sm)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: "var(--nx-space-3)",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>
                    {market.question} :{" "}
                    <span
                      style={{
                        color:
                          settlement === "yes"
                            ? "var(--nx-success, #10b981)"
                            : "var(--nx-danger, #ef4444)",
                        textTransform: "uppercase",
                      }}
                    >
                      {settlement}
                    </span>
                  </span>
                  <div style={{ display: "flex", gap: "var(--nx-space-3)" }}>
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api.settlePaperMarket(market.id, settlement);
                          setSettlement(null);
                          return tr("Market settled successfully.", "Marché réglé avec succès.");
                        })
                      }
                    >
                      <IconCheck size={14} />
                      {tr("Confirm Settlement", "Confirmer le règlement")}
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() => setSettlement(null)}
                    >
                      {tr("Cancel", "Annuler")}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : market ? (
            <div
              style={{
                marginTop: "var(--nx-space-6)",
                padding: "var(--nx-space-3) var(--nx-space-4)",
                background: "var(--nx-canvas-sunken)",
                borderRadius: "var(--nx-radius-sm)",
                fontSize: "var(--nx-size-xs)",
                display: "flex",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <IconShield size={14} color="var(--nx-signal)" />
              <span>
                {market.state.toUpperCase()} :{" "}
                <strong>
                  {market.winning_outcome ? market.winning_outcome.toUpperCase() : "—"}
                </strong>
              </span>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
