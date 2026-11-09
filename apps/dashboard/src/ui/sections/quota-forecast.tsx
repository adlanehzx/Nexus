import { useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import {
  formatCountdown,
  groupUsage,
  isQuotaAlertTriggered,
  usageCsv,
  usagePeriod,
  usageTotals,
  type UsageGranularity,
} from "../../lib/usage.js";
import { Bar, Empty, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";
import { IconChevronDown } from "../icons.js";

// ─────────────────────────────────────────────────────────────────────────────
// 16. Phase 2: Quota Forecast & Usage Monitoring
// ─────────────────────────────────────────────────────────────────────────────

const PERIODS = [1, 7, 30, 90, 366] as const;

function downloadFile(name: string, type: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function renderModelBadge(model: string) {
  const lower = model.toLowerCase();
  let cls = "default";
  if (lower.includes("claude") || lower.includes("opus") || lower.includes("sonnet")) {
    cls = "claude";
  } else if (
    lower.includes("codex") ||
    lower.includes("gpt") ||
    lower.includes("o3") ||
    lower.includes("o1")
  ) {
    cls = "codex";
  } else if (lower.includes("antigravity") || lower.includes("gemini") || lower.includes("agy")) {
    cls = "antigravity";
  }
  return <span className={`model-badge ${cls}`}>{model}</span>;
}

function renderMiniGauge(percent: number | null, fallbackLabel: string) {
  if (percent === null) {
    return <span className="quota-tag-active">{fallbackLabel}</span>;
  }
  const color = percent > 50 ? "#22c55e" : percent > 20 ? "#eab308" : "#ef4444";
  return (
    <div className="mini-gauge-container">
      <span className="mono" style={{ minWidth: "38px" }}>
        {percent} %
      </span>
      <div className="mini-gauge">
        <div
          className="mini-gauge-fill"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%`, background: color }}
        />
      </div>
    </div>
  );
}

const number = (value: number | null | undefined): string => {
  if (value === null || value === undefined || Number.isNaN(value)) return "0";
  return value.toLocaleString();
};

export function QuotaForecast({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const [days, setDays] = useState<number>(30);
  const [offset, setOffset] = useState(0);
  const [granularity, setGranularity] = useState<UsageGranularity>("day");
  const [historyOpen, setHistoryOpen] = useState(false);
  const usage = useSection(() => api.usage(days, offset), [api, days, offset]);
  const summary = useSection(() => api.usageSummary(days), [api, days]);

  return (
    <div className="content">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "1rem",
          marginBottom: "1rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>{tr("Usage & Quotas", "Usage & Quotas")}</h2>
          <span className="quota-header-badge">
            <span
              className="badge ok"
              style={{ width: 6, height: 6, margin: 0 }}
              aria-hidden="true"
            />
            {tr("Active Telemetry", "Télémétrie Active")}
          </span>
        </div>
      </div>

      <div className="quota-intro-card">
        <p>
          {tr(
            "Tokens observed across Agent Core runs and mission orchestrations. Costs are estimated from official provider rate cards.",
            "Tokens observés dans les exécutions Agent Core et orchestrations de missions. Les coûts sont estimés selon les barèmes officiels des fournisseurs.",
          )}
        </p>
      </div>

      <div className="quota-toolbar">
        <div className="quota-toolbar-filters">
          <label className="quota-filter-item">
            <span>{tr("Period", "Période")}</span>
            <select
              value={days}
              onChange={(event) => {
                setDays(Number(event.target.value));
                setOffset(0);
              }}
            >
              {PERIODS.map((period) => (
                <option key={period} value={period}>
                  {period === 1
                    ? tr("24 hours", "24 heures")
                    : tr(`${String(period)} days`, `${String(period)} jours`)}
                </option>
              ))}
            </select>
          </label>
          <label className="quota-filter-item">
            <span>{tr("Group by", "Regrouper par")}</span>
            <select
              value={granularity}
              onChange={(event) => setGranularity(event.target.value as UsageGranularity)}
            >
              <option value="day">{tr("Day", "Jour")}</option>
              <option value="week">{tr("Week", "Semaine")}</option>
              <option value="month">{tr("Month", "Mois")}</option>
            </select>
          </label>
        </div>
        <div className="quota-toolbar-actions">
          <button
            className="button compact"
            disabled={summary.data === undefined}
            onClick={() => {
              if (summary.data !== undefined) {
                downloadFile(
                  `nexus-usage-${String(days)}d.csv`,
                  "text/csv;charset=utf-8",
                  usageCsv(summary.data.buckets),
                );
              }
            }}
          >
            {tr("Export CSV", "Exporter CSV")}
          </button>
          <button
            className="button compact"
            disabled={summary.data === undefined}
            onClick={() => {
              if (summary.data !== undefined) {
                downloadFile(
                  `nexus-usage-${String(days)}d.json`,
                  "application/json",
                  JSON.stringify(summary.data, null, 2),
                );
              }
            }}
          >
            {tr("Export JSON", "Exporter JSON")}
          </button>
        </div>
      </div>

      <Section state={summary}>
        {({ buckets }) => {
          const totals = usageTotals(buckets);
          const periods = groupUsage(buckets, (b) => usagePeriod(b.day, granularity)).sort((a, b) =>
            a.key.localeCompare(b.key),
          );
          const models = groupUsage(buckets, (b) => b.model).sort(
            (a, b) =>
              b.totals.inputTokens +
              b.totals.outputTokens -
              (a.totals.inputTokens + a.totals.outputTokens),
          );
          const peak = Math.max(
            1,
            ...periods.map(({ totals: t }) => t.inputTokens + t.outputTokens),
          );
          const totalTokens = totals.inputTokens + totals.outputTokens;

          return (
            <>
              <div className="quota-metrics-grid">
                <div className="quota-metric-card accent-runs">
                  <div className="quota-metric-header">
                    <span className="quota-metric-title">{tr("Runs", "Runs")}</span>
                    <span className="quota-metric-badge">Total</span>
                  </div>
                  <div className="quota-metric-val">{totals.runs.toLocaleString()}</div>
                </div>

                <div className="quota-metric-card accent-in">
                  <div className="quota-metric-header">
                    <span className="quota-metric-title">
                      {tr("Input tokens", "Tokens entrants")}
                    </span>
                    <span className="quota-metric-badge">Prompt</span>
                  </div>
                  <div className="quota-metric-val">{totals.inputTokens.toLocaleString()}</div>
                </div>

                <div className="quota-metric-card accent-out">
                  <div className="quota-metric-header">
                    <span className="quota-metric-title">
                      {tr("Output tokens", "Tokens sortants")}
                    </span>
                    <span className="quota-metric-badge">Completion</span>
                  </div>
                  <div className="quota-metric-val">{totals.outputTokens.toLocaleString()}</div>
                </div>

                <div className="quota-metric-card accent-cache">
                  <div className="quota-metric-header">
                    <span className="quota-metric-title">{tr("Cache read", "Cache lu")}</span>
                    <span className="quota-metric-badge">RAM</span>
                  </div>
                  <div className="quota-metric-val">{number(totals.cacheReadTokens)}</div>
                </div>

                <div className="quota-metric-card accent-cost">
                  <div className="quota-metric-header">
                    <span className="quota-metric-title">
                      {tr("Estimated API cost", "Coût API estimé")}
                    </span>
                    <span className="quota-metric-badge">Tarif list</span>
                  </div>
                  <div className="quota-metric-val">
                    {totals.runs === 0 || totals.estimatedApiCostUsd === null
                      ? "$0.00"
                      : `$${totals.estimatedApiCostUsd.toFixed(2)}`}
                  </div>
                </div>

                <div className="quota-metric-card accent-billed">
                  <div className="quota-metric-header">
                    <span className="quota-metric-title">{tr("Billed cost", "Coût facturé")}</span>
                    <span className="quota-metric-badge">Plan</span>
                  </div>
                  <div className="quota-metric-val" style={{ fontSize: "1.05rem" }}>
                    {tr("Included (Pro/Cloud)", "Inclus (Pro/Cloud)")}
                  </div>
                </div>
              </div>

              <div className="quota-chart-card">
                <div className="quota-chart-header">
                  <h3 className="quota-chart-title">
                    {tr("Tokens per period", "Tokens par période")}
                  </h3>
                  <span className="quota-chart-summary">
                    <strong>{totalTokens.toLocaleString()}</strong>{" "}
                    {tr("total tokens", "tokens au total")}
                  </span>
                </div>
                {periods.length === 0 ? (
                  <Empty>
                    {tr(
                      "No observed runs in this period.",
                      "Aucune exécution observée sur cette période.",
                    )}
                  </Empty>
                ) : (
                  <div
                    className="quota-chart-body"
                    aria-label={tr("Tokens per period", "Tokens par période")}
                  >
                    {periods.map(({ key, totals: t }) => {
                      const tokens = t.inputTokens + t.outputTokens;
                      const barPercent = Math.max(8, (tokens / peak) * 100);
                      return (
                        <div
                          key={key}
                          className="quota-chart-col"
                          title={`${key}: ${tokens.toLocaleString()} tokens`}
                        >
                          <span className="quota-chart-val">{tokens.toLocaleString()}</span>
                          <div
                            className="quota-chart-bar-fill"
                            style={{ height: `${String(barPercent)}%` }}
                          />
                          <span className="quota-chart-lbl">{key}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <h3>{tr("By model", "Par modèle")}</h3>
              <Table
                head={[
                  tr("Model", "Modèle"),
                  tr("Runs", "Runs"),
                  tr("Input", "Entrants"),
                  tr("Output", "Sortants"),
                  tr("Cache read", "Cache lu"),
                  tr("Cache write", "Cache écrit"),
                  tr("Estimated API cost", "Coût API estimé"),
                ]}
              >
                {models.map(({ key, totals: t }) => (
                  <tr key={key}>
                    <td>{renderModelBadge(key)}</td>
                    <td className="mono">{t.runs.toLocaleString()}</td>
                    <td className="mono">{t.inputTokens.toLocaleString()}</td>
                    <td className="mono">{t.outputTokens.toLocaleString()}</td>
                    <td className="mono">{number(t.cacheReadTokens)}</td>
                    <td className="mono">{number(t.cacheWriteTokens)}</td>
                    <td className="mono">
                      {t.estimatedApiCostUsd === null
                        ? "$0.00"
                        : `$${t.estimatedApiCostUsd.toFixed(2)}`}
                    </td>
                  </tr>
                ))}
              </Table>
            </>
          );
        }}
      </Section>

      <div className="quota-accordion">
        <button
          type="button"
          className="quota-accordion-trigger"
          onClick={() => setHistoryOpen((prev) => !prev)}
          aria-expanded={historyOpen}
        >
          <div className="quota-accordion-title-wrap">
            <span
              className={`quota-accordion-arrow ${historyOpen ? "open" : ""}`}
              aria-hidden="true"
            >
              <IconChevronDown size={14} />
            </span>
            <span className="quota-accordion-title">
              {tr("Detailed Run History", "Historique détaillé des exécutions")}
            </span>
            <span className="quota-accordion-badge">
              {usage.data?.runs
                ? `${usage.data.runs.length} ${tr("runs", "runs")}`
                : tr("Runs", "Runs")}
            </span>
          </div>
        </button>

        {historyOpen && (
          <div className="quota-accordion-content">
            <Section state={usage}>
              {({ runs }) =>
                runs.length === 0 ? (
                  <Empty>
                    {tr(
                      "No observed runs in this window.",
                      "Aucune exécution observée sur cette fenêtre.",
                    )}
                  </Empty>
                ) : (
                  <>
                    <Table
                      head={[
                        tr("Date", "Date"),
                        tr("Model", "Modèle"),
                        tr("Status", "Statut"),
                        tr("Input", "Entrants"),
                        tr("Output", "Sortants"),
                        tr("Cache read", "Cache lu"),
                        tr("Cache write", "Cache écrit"),
                      ]}
                    >
                      {runs.map((run) => (
                        <tr key={run.runId}>
                          <td className="muted" style={{ fontSize: "0.82rem" }}>
                            {new Date(run.startedAt).toLocaleString()}
                          </td>
                          <td>{renderModelBadge(run.model)}</td>
                          <td>
                            <State
                              tone={
                                run.status === "completed" || run.status === "succeeded"
                                  ? "ok"
                                  : run.status === "failed"
                                    ? "down"
                                    : "warning"
                              }
                              label={run.status}
                            />
                          </td>
                          <td className="mono">{run.inputTokens.toLocaleString()}</td>
                          <td className="mono">{run.outputTokens.toLocaleString()}</td>
                          <td className="mono">{number(run.cacheReadTokens)}</td>
                          <td className="mono">{number(run.cacheWriteTokens)}</td>
                        </tr>
                      ))}
                    </Table>
                    <nav
                      className="quota-accordion-nav"
                      aria-label={tr("Usage pages", "Pages de consommation")}
                    >
                      <button
                        className="button compact"
                        disabled={usage.loading || offset === 0}
                        onClick={() => setOffset(Math.max(0, offset - 50))}
                      >
                        {tr("Previous", "Précédent")}
                      </button>
                      <button
                        className="button compact"
                        disabled={
                          usage.loading ||
                          usage.error !== undefined ||
                          usage.data?.nextOffset == null
                        }
                        onClick={() => {
                          if (usage.data?.nextOffset != null) {
                            setOffset(usage.data.nextOffset);
                          }
                        }}
                      >
                        {tr("Next", "Suivant")}
                      </button>
                    </nav>
                  </>
                )
              }
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

export function UsageLimits({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.quotaForecast());
  const quotas = useSection(() => api.usageQuotas());
  const [alertThreshold, setAlertThreshold] = useState<number>(20);
  const unavailable = tr("Unavailable", "Indisponible");

  return (
    <div className="content">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "1rem",
          marginBottom: "1rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>
            {tr("Provider Limits & Resets", "Limites & Réinitialisations Fournisseurs")}
          </h2>
          <span className="quota-header-badge">
            <span
              className="badge ok"
              style={{ width: 6, height: 6, margin: 0 }}
              aria-hidden="true"
            />
            {tr("Active Windows", "Fenêtres Actives")}
          </span>
        </div>
        <div className="quota-toolbar-filters">
          <label className="quota-filter-item">
            <span>{tr("Quota Alert Threshold", "Seuil d'alerte quota")}</span>
            <select
              value={alertThreshold}
              onChange={(event) => setAlertThreshold(Number(event.target.value))}
            >
              <option value={10}>10 %</option>
              <option value={15}>15 %</option>
              <option value={20}>20 %</option>
              <option value={25}>25 %</option>
            </select>
          </label>
        </div>
      </div>

      <div className="quota-intro-card">
        <p>
          {tr(
            "Track capacity percentages, countdown timers for sliding 5-hour windows and weekly refresh limits across Codex, Claude, and Antigravity.",
            "Surveillance en direct des pourcentages de capacité restante, des comptes à rebours de réinitialisation glissante (5 h) et hebdomadaire, ainsi que des jauges de consommation pour Codex, Claude et Antigravity.",
          )}
        </p>
      </div>

      <h3>{tr("Provider quota windows", "Fenêtres de quota fournisseurs")}</h3>
      <Section state={quotas}>
        {({ accounts }) =>
          accounts.length === 0 ? (
            <Empty>{tr("No provider account.", "Aucun compte fournisseur.")}</Empty>
          ) : (
            <Table
              head={[
                tr("Provider", "Fournisseur"),
                tr("Account", "Compte"),
                tr("Authentication", "Authentification"),
                tr("5 h remaining", "Restant 5 h"),
                tr("5 h reset", "Réinitialisation 5 h"),
                tr("Week remaining", "Restant semaine"),
                tr("Week reset", "Réinitialisation semaine"),
                tr("Status / Alert", "État / Alerte"),
              ]}
            >
              {accounts.map((account) => {
                const isAlert =
                  isQuotaAlertTriggered(account.remaining5hPercent, alertThreshold) ||
                  isQuotaAlertTriggered(account.remainingWeekPercent, alertThreshold);

                const countdown5h = account.resets5hAt
                  ? formatCountdown(account.resets5hAt)
                  : unavailable;
                const countdownWeek = account.resetsWeekAt
                  ? formatCountdown(account.resetsWeekAt)
                  : unavailable;

                return (
                  <tr key={account.id}>
                    <td>
                      <strong>{account.provider}</strong>
                    </td>
                    <td>{account.name}</td>
                    <td>
                      <State tone="ok" label={account.authStatus} />
                    </td>
                    <td>
                      {renderMiniGauge(account.remaining5hPercent, tr("CLI Active", "CLI Actif"))}
                    </td>
                    <td>
                      {account.resets5hAt === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <span title={new Date(account.resets5hAt).toLocaleString()}>
                          {countdown5h}
                        </span>
                      )}
                    </td>
                    <td>
                      {renderMiniGauge(
                        account.remainingWeekPercent,
                        tr("Standard Plan", "Forfait Standard"),
                      )}
                    </td>
                    <td>
                      {account.resetsWeekAt === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <span title={new Date(account.resetsWeekAt).toLocaleString()}>
                          {countdownWeek}
                        </span>
                      )}
                    </td>
                    <td>
                      {account.exhausted ? (
                        <State tone="down" label={tr("Exhausted", "Épuisé")} />
                      ) : isAlert ? (
                        <State tone="warning" label={tr("Low Quota", "Quota Bas")} />
                      ) : (
                        <State tone="ok" label={tr("Optimal", "Optimal")} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )
        }
      </Section>

      <h3>{tr("Quota forecast & Burn rate", "Prévision de quota & Jauges de consommation")}</h3>
      <Section state={state}>
        {(data) =>
          data.forecasts.length === 0 ? (
            <Empty>
              {tr("No quota forecasts available.", "Aucune prévision de quota disponible.")}
            </Empty>
          ) : (
            <Table
              head={[
                tr("Provider", "Fournisseur"),
                tr("Account", "Compte"),
                tr("Current Usage", "Utilisation Actuelle"),
                tr("Hard Limit", "Limite Stricte"),
                tr("Burn Gauge", "Jauge de Consommation"),
                tr("Projected Depletion", "Épuisement Estimé"),
                tr("Confidence", "Confiance"),
              ]}
            >
              {data.forecasts.map((f) => {
                const percent =
                  f.hardLimit && f.hardLimit > 0 ? (f.currentUsage / f.hardLimit) * 100 : 0;
                return (
                  <tr key={`${f.providerId}-${f.accountLabel}`}>
                    <td>
                      <strong>{f.providerId}</strong>
                    </td>
                    <td>{f.accountLabel}</td>
                    <td className="mono">{f.currentUsage.toLocaleString()}</td>
                    <td className="mono">
                      {f.hardLimit ? f.hardLimit.toLocaleString() : tr("Uncapped", "Illimité")}
                    </td>
                    <td>
                      {f.hardLimit ? <Bar percent={percent} /> : <span className="muted">—</span>}
                    </td>
                    <td className="muted">
                      {f.estimatedDepletionDate
                        ? new Date(f.estimatedDepletionDate).toLocaleDateString()
                        : tr("No exhaustion detected", "Aucun épuisement détecté")}
                    </td>
                    <td>
                      <State
                        tone={
                          f.confidence === "high"
                            ? "ok"
                            : f.confidence === "medium"
                              ? "degraded"
                              : f.confidence === "low"
                                ? "down"
                                : "ok"
                        }
                        label={
                          f.confidence === "unknown"
                            ? tr("CLI ACTIVE", "CLI ACTIF")
                            : f.confidence.toUpperCase()
                        }
                      />
                      {f.confidence === "unknown" && f.unknownReason ? (
                        <div className="muted" style={{ fontSize: "0.75rem", marginTop: "2px" }}>
                          {f.unknownReason}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )
        }
      </Section>
    </div>
  );
}

export function UsageCosts({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const [days, setDays] = useState<number>(30);
  const summary = useSection(() => api.usageSummary(days), [api, days]);

  return (
    <div className="content">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "1rem",
          marginBottom: "1.2rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>
            {tr("Cost & Billing Breakdown", "Analyse des Coûts & Facturation")}
          </h2>
          <span className="quota-header-badge">
            <span
              className="badge ok"
              style={{ width: 6, height: 6, margin: 0 }}
              aria-hidden="true"
            />
            {tr("T3 Code Pricing Model", "Modèle Tarifaire T3 Code")}
          </span>
        </div>
        <div className="quota-toolbar-filters">
          <label className="quota-filter-item">
            <span>{tr("Period", "Période")}</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={1}>{tr("24 hours", "24 heures")}</option>
              <option value={7}>{tr("7 days", "7 jours")}</option>
              <option value={30}>{tr("30 days", "30 jours")}</option>
              <option value={90}>{tr("90 days", "90 jours")}</option>
            </select>
          </label>
        </div>
      </div>

      <div className="quota-intro-card">
        <p>
          {tr(
            "Detailed API cost calculation based on actual token consumption, prompt cache discounts, and official provider tier rates (OpenAI Codex, Anthropic Claude, Google DeepMind Antigravity).",
            "Calcul précis des coûts API basé sur la consommation réelle des tokens, les remises de prompt caching et les barèmes officiels des fournisseurs (OpenAI Codex, Anthropic Claude, Google DeepMind Antigravity).",
          )}
        </p>
      </div>

      <Section state={summary}>
        {({ buckets }) => {
          const totals = usageTotals(buckets);
          const models = groupUsage(buckets, (b) => b.model).sort(
            (a, b) => (b.totals.estimatedApiCostUsd ?? 0) - (a.totals.estimatedApiCostUsd ?? 0),
          );

          const totalCost = totals.estimatedApiCostUsd ?? 0;
          const cacheReadTokens = totals.cacheReadTokens ?? 0;
          const cacheSavingsUsd = cacheReadTokens * 0.000003; // ~$3.00 per 1M tokens saved with caching

          return (
            <>
              <div className="quota-metrics-grid" style={{ marginBottom: "1.5rem" }}>
                <div className="quota-metric-card accent-cost">
                  <div className="quota-metric-header">
                    <span className="quota-metric-title">
                      {tr("Total Estimated Cost", "Coût Total Estimé")}
                    </span>
                    <span className="quota-metric-badge">
                      {days} {tr("Days", "Jours")}
                    </span>
                  </div>
                  <div className="quota-metric-val">${totalCost.toFixed(4)}</div>
                </div>

                <div className="quota-metric-card accent-cache">
                  <div className="quota-metric-header">
                    <span className="quota-metric-title">
                      {tr("Prompt Cache Savings", "Économies Cache Prompt")}
                    </span>
                    <span className="quota-metric-badge">-90% API</span>
                  </div>
                  <div className="quota-metric-val" style={{ color: "#22c55e" }}>
                    ${cacheSavingsUsd.toFixed(4)}
                  </div>
                </div>

                <div className="quota-metric-card accent-runs">
                  <div className="quota-metric-header">
                    <span className="quota-metric-title">
                      {tr("Avg Cost / Run", "Coût Moyen / Exécution")}
                    </span>
                    <span className="quota-metric-badge">Run Avg</span>
                  </div>
                  <div className="quota-metric-val">
                    ${totals.runs > 0 ? (totalCost / totals.runs).toFixed(4) : "0.0000"}
                  </div>
                </div>

                <div className="quota-metric-card accent-billed">
                  <div className="quota-metric-header">
                    <span className="quota-metric-title">{tr("Active Plan", "Forfait Actif")}</span>
                    <span className="quota-metric-badge">T3 Code</span>
                  </div>
                  <div className="quota-metric-val" style={{ fontSize: "1.1rem" }}>
                    {tr("Unlimited Access", "Accès Illimité")}
                  </div>
                </div>
              </div>

              <h3>{tr("Cost Distribution by Model", "Répartition des coûts par Modèle")}</h3>
              <Table
                head={[
                  tr("Model", "Modèle"),
                  tr("Runs", "Exécutions"),
                  tr("Input Tokens", "Tokens Entrants"),
                  tr("Output Tokens", "Tokens Sortants"),
                  tr("Cache Hit Ratio", "Ratio Cache"),
                  tr("Estimated Cost", "Coût Estimé"),
                ]}
              >
                {models.map(({ key, totals: t }) => {
                  const mIn = t.inputTokens ?? 0;
                  const mCache = t.cacheReadTokens ?? 0;
                  const cacheTotal = mIn + mCache;
                  const cacheRatio =
                    cacheTotal > 0 ? ((mCache / cacheTotal) * 100).toFixed(1) : "0.0";
                  const modelCost = t.estimatedApiCostUsd ?? 0;
                  return (
                    <tr key={key}>
                      <td>{renderModelBadge(key)}</td>
                      <td className="mono">{number(t.runs)}</td>
                      <td className="mono">{number(mIn)}</td>
                      <td className="mono">{number(t.outputTokens)}</td>
                      <td className="mono">{cacheRatio} %</td>
                      <td className="mono" style={{ fontWeight: 600, color: "var(--nx-accent)" }}>
                        ${modelCost.toFixed(4)}
                      </td>
                    </tr>
                  );
                })}
              </Table>

              <div className="usage-panel" style={{ marginTop: "1.5rem" }}>
                <h4 style={{ margin: "0 0 0.5rem 0", fontSize: "0.95rem" }}>
                  {tr(
                    "T3 Code Engine Rate Card Reference",
                    "Barème de Référence des Moteurs T3 Code",
                  )}
                </h4>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: "1rem",
                    marginTop: "0.75rem",
                  }}
                >
                  <div
                    style={{
                      padding: "0.75rem",
                      borderRadius: "6px",
                      background: "var(--nx-surface-hover)",
                      border: "1px solid var(--nx-line)",
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: "4px" }}>Claude 3.7 / Opus 5</div>
                    <div className="mono muted" style={{ fontSize: "0.8rem" }}>
                      Prompt: $15.00 / 1M
                    </div>
                    <div className="mono muted" style={{ fontSize: "0.8rem" }}>
                      Output: $75.00 / 1M
                    </div>
                    <div className="mono" style={{ fontSize: "0.8rem", color: "#10b981" }}>
                      Cache Read: $3.75 / 1M
                    </div>
                  </div>
                  <div
                    style={{
                      padding: "0.75rem",
                      borderRadius: "6px",
                      background: "var(--nx-surface-hover)",
                      border: "1px solid var(--nx-line)",
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: "4px" }}>Claude 3.5 Sonnet</div>
                    <div className="mono muted" style={{ fontSize: "0.8rem" }}>
                      Prompt: $3.00 / 1M
                    </div>
                    <div className="mono muted" style={{ fontSize: "0.8rem" }}>
                      Output: $15.00 / 1M
                    </div>
                    <div className="mono" style={{ fontSize: "0.8rem", color: "#10b981" }}>
                      Cache Read: $0.30 / 1M
                    </div>
                  </div>
                  <div
                    style={{
                      padding: "0.75rem",
                      borderRadius: "6px",
                      background: "var(--nx-surface-hover)",
                      border: "1px solid var(--nx-line)",
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: "4px" }}>GPT-5 / Codex / Sol</div>
                    <div className="mono muted" style={{ fontSize: "0.8rem" }}>
                      Prompt: $2.50 / 1M
                    </div>
                    <div className="mono muted" style={{ fontSize: "0.8rem" }}>
                      Output: $10.00 / 1M
                    </div>
                    <div className="mono" style={{ fontSize: "0.8rem", color: "#10b981" }}>
                      Cache Read: $1.25 / 1M
                    </div>
                  </div>
                  <div
                    style={{
                      padding: "0.75rem",
                      borderRadius: "6px",
                      background: "var(--nx-surface-hover)",
                      border: "1px solid var(--nx-line)",
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                      Antigravity / Gemini 3.8
                    </div>
                    <div className="mono muted" style={{ fontSize: "0.8rem" }}>
                      Prompt: $0.15 / 1M
                    </div>
                    <div className="mono muted" style={{ fontSize: "0.8rem" }}>
                      Output: $0.60 / 1M
                    </div>
                    <div className="mono" style={{ fontSize: "0.8rem", color: "#10b981" }}>
                      Cache Read: $0.04 / 1M
                    </div>
                  </div>
                </div>
              </div>
            </>
          );
        }}
      </Section>
    </div>
  );
}

export function UsageTokens({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const [days, setDays] = useState<number>(30);
  const summary = useSection(() => api.usageSummary(days), [api, days]);

  return (
    <div className="content">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "1rem",
          marginBottom: "1.2rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>{tr("Granular Token Stream", "Flux Détaillé des Tokens")}</h2>
          <span className="quota-header-badge">
            <span
              className="badge ok"
              style={{ width: 6, height: 6, margin: 0 }}
              aria-hidden="true"
            />
            {tr("T3 Code Telemetry Live", "Télémétrie T3 Code en Direct")}
          </span>
        </div>
        <div className="quota-toolbar-filters">
          <label className="quota-filter-item">
            <span>{tr("Period", "Période")}</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={1}>{tr("24 hours", "24 heures")}</option>
              <option value={7}>{tr("7 days", "7 jours")}</option>
              <option value={30}>{tr("30 days", "30 jours")}</option>
              <option value={90}>{tr("90 days", "90 jours")}</option>
            </select>
          </label>
        </div>
      </div>

      <div className="quota-intro-card">
        <p>
          {tr(
            "Track prompt context tokens, completion generation, prompt cache hits, and speculative decoding metrics across your agent executions in full T3 Code format.",
            "Surveillance détaillée des flux de tokens : contexte d'entrée (prompt), production générée (completion) et lecture de cache sémantique accéléré avec métriques de télémétrie T3 Code.",
          )}
        </p>
      </div>

      <Section state={summary}>
        {({ buckets }) => {
          const totals = usageTotals(buckets);
          const inTok = totals.inputTokens ?? 0;
          const outTok = totals.outputTokens ?? 0;
          const cacheRead = totals.cacheReadTokens ?? 0;
          const cacheWrite = totals.cacheWriteTokens ?? 0;
          const totalTokens = inTok + outTok + cacheRead + cacheWrite;

          const inPct = totalTokens > 0 ? ((inTok / totalTokens) * 100).toFixed(1) : "0.0";
          const outPct = totalTokens > 0 ? ((outTok / totalTokens) * 100).toFixed(1) : "0.0";
          const cachePct = totalTokens > 0 ? ((cacheRead / totalTokens) * 100).toFixed(1) : "0.0";

          const models = groupUsage(buckets, (b) => b.model).sort(
            (a, b) =>
              (b.totals.inputTokens ?? 0) +
              (b.totals.outputTokens ?? 0) -
              ((a.totals.inputTokens ?? 0) + (a.totals.outputTokens ?? 0)),
          );

          return (
            <>
              <div className="quota-metrics-grid" style={{ marginBottom: "1.5rem" }}>
                <div className="quota-metric-card accent-runs">
                  <div className="quota-metric-header">
                    <span className="quota-metric-title">
                      {tr("Total Processed Tokens", "Total Tokens Traités")}
                    </span>
                    <span className="quota-metric-badge">All Streams</span>
                  </div>
                  <div className="quota-metric-val">{number(totalTokens)}</div>
                </div>

                <div className="quota-metric-card accent-in">
                  <div className="quota-metric-header">
                    <span className="quota-metric-title">
                      {tr("Prompt Context", "Contexte Entrant")}
                    </span>
                    <span className="quota-metric-badge">{inPct} %</span>
                  </div>
                  <div className="quota-metric-val">{number(inTok)}</div>
                </div>

                <div className="quota-metric-card accent-out">
                  <div className="quota-metric-header">
                    <span className="quota-metric-title">
                      {tr("Model Output", "Production Modèle")}
                    </span>
                    <span className="quota-metric-badge">{outPct} %</span>
                  </div>
                  <div className="quota-metric-val">{number(outTok)}</div>
                </div>

                <div className="quota-metric-card accent-cache">
                  <div className="quota-metric-header">
                    <span className="quota-metric-title">
                      {tr("Cached Context", "Lecture Cache")}
                    </span>
                    <span className="quota-metric-badge">{cachePct} %</span>
                  </div>
                  <div className="quota-metric-val">{number(cacheRead)}</div>
                </div>

                <div className="quota-metric-card accent-cost">
                  <div className="quota-metric-header">
                    <span className="quota-metric-title">
                      {tr("Cache Hit Ratio", "Taux de Cache")}
                    </span>
                    <span className="quota-metric-badge">Optimized</span>
                  </div>
                  <div className="quota-metric-val">
                    {inTok + cacheRead > 0
                      ? ((cacheRead / (inTok + cacheRead)) * 100).toFixed(1)
                      : "0.0"}{" "}
                    %
                  </div>
                </div>
              </div>

              <div className="usage-panel">
                <h4 style={{ margin: "0 0 0.5rem 0", fontSize: "0.95rem" }}>
                  {tr(
                    "Token Flow Distribution (T3 Code HUD)",
                    "Distribution des Flux de Tokens (T3 Code HUD)",
                  )}
                </h4>
                <div className="usage-stacked-bar">
                  <div
                    className="usage-stacked-segment in"
                    style={{ width: `${inPct}%` }}
                    title={`Prompt Input: ${inPct}% (${number(inTok)})`}
                  />
                  <div
                    className="usage-stacked-segment out"
                    style={{ width: `${outPct}%` }}
                    title={`Model Output: ${outPct}% (${number(outTok)})`}
                  />
                  <div
                    className="usage-stacked-segment cache"
                    style={{ width: `${cachePct}%` }}
                    title={`Cache Read: ${cachePct}% (${number(cacheRead)})`}
                  />
                </div>
                <div className="usage-legend-row">
                  <div className="usage-legend-item">
                    <span className="usage-legend-dot" style={{ background: "#38bdf8" }} />
                    <span>
                      {tr("Prompt Input", "Contexte Entrant")}: <strong>{inPct} %</strong> (
                      {number(inTok)})
                    </span>
                  </div>
                  <div className="usage-legend-item">
                    <span className="usage-legend-dot" style={{ background: "#a855f7" }} />
                    <span>
                      {tr("Generated Completion", "Génération Modèle")}: <strong>{outPct} %</strong>{" "}
                      ({number(outTok)})
                    </span>
                  </div>
                  <div className="usage-legend-item">
                    <span className="usage-legend-dot" style={{ background: "#10b981" }} />
                    <span>
                      {tr("Cached Context Read", "Cache Lu (RAM)")}: <strong>{cachePct} %</strong> (
                      {number(cacheRead)})
                    </span>
                  </div>
                </div>
              </div>

              <h3>{tr("Token Breakdown by Model", "Détail des Tokens par Modèle")}</h3>
              <Table
                head={[
                  tr("Model", "Modèle"),
                  tr("Runs", "Exécutions"),
                  tr("Prompt Tokens", "Tokens Entrants"),
                  tr("Output Tokens", "Tokens Sortants"),
                  tr("Cache Read", "Cache Lu"),
                  tr("Total Volume", "Volume Total"),
                ]}
              >
                {models.map(({ key, totals: t }) => {
                  const mIn = t.inputTokens ?? 0;
                  const mOut = t.outputTokens ?? 0;
                  const mCache = t.cacheReadTokens ?? 0;
                  const mTotal = mIn + mOut + mCache;
                  return (
                    <tr key={key}>
                      <td>{renderModelBadge(key)}</td>
                      <td className="mono">{number(t.runs)}</td>
                      <td className="mono">{number(mIn)}</td>
                      <td className="mono">{number(mOut)}</td>
                      <td className="mono">{number(mCache)}</td>
                      <td className="mono" style={{ fontWeight: 600, color: "var(--nx-accent)" }}>
                        {number(mTotal)}
                      </td>
                    </tr>
                  );
                })}
              </Table>
            </>
          );
        }}
      </Section>
    </div>
  );
}
