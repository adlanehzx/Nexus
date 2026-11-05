import { useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import {
  groupUsage,
  usageCsv,
  usagePeriod,
  usageTotals,
  type UsageGranularity,
} from "../../lib/usage.js";
import { Bar, Empty, Metric, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 16. Phase 2: Quota Forecast (Codex Contract)
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

export function QuotaForecast({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.quotaForecast());
  const quotas = useSection(() => api.usageQuotas());
  const [days, setDays] = useState<number>(30);
  const [offset, setOffset] = useState(0);
  const [granularity, setGranularity] = useState<UsageGranularity>("day");
  const usage = useSection(() => api.usage(days, offset), [api, days, offset]);
  const summary = useSection(() => api.usageSummary(days), [api, days]);
  const unavailable = tr("Unavailable", "Indisponible");
  const number = (value: number | null) => value?.toLocaleString() ?? unavailable;

  return (
    <div className="content">
      <h2>{tr("Usage & Quotas", "Usage & Quotas")}</h2>
      <p className="muted">
        {tr(
          "Tokens observed in the Agent Core runs of your account. Costs are list-price estimates, never billed amounts. Provider and account attribution are not recorded for these runs yet.",
          "Tokens observés dans les runs Agent Core de votre compte. Les coûts sont des estimations au tarif public, jamais des montants facturés. Le fournisseur et le compte ne sont pas encore enregistrés pour ces runs.",
        )}
      </p>
      <div className="usage-filters">
        <label>
          {tr("Period", "Période")}{" "}
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
        <label>
          {tr("Group by", "Regrouper par")}{" "}
          <select
            value={granularity}
            onChange={(event) => setGranularity(event.target.value as UsageGranularity)}
          >
            <option value="day">{tr("Day", "Jour")}</option>
            <option value="week">{tr("Week", "Semaine")}</option>
            <option value="month">{tr("Month", "Mois")}</option>
          </select>
        </label>
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
          return (
            <>
              <div className="metrics">
                <Metric value={totals.runs.toLocaleString()} label={tr("runs", "runs")} />
                <Metric
                  value={totals.inputTokens.toLocaleString()}
                  label={tr("input tokens", "tokens entrants")}
                />
                <Metric
                  value={totals.outputTokens.toLocaleString()}
                  label={tr("output tokens", "tokens sortants")}
                />
                <Metric
                  value={number(totals.cacheReadTokens)}
                  label={tr("cache read", "cache lu")}
                />
                <Metric
                  value={
                    totals.runs === 0 || totals.estimatedApiCostUsd === null
                      ? unavailable
                      : `$${totals.estimatedApiCostUsd.toFixed(2)}`
                  }
                  label={tr("estimated API cost", "coût API estimé")}
                />
                <Metric value={unavailable} label={tr("billed cost", "coût facturé")} />
              </div>
              {periods.length === 0 ? (
                <Empty>
                  {tr(
                    "No observed runs in this period.",
                    "Aucune exécution observée sur cette période.",
                  )}
                </Empty>
              ) : (
                <>
                  <h3>{tr("Tokens per period", "Tokens par période")}</h3>
                  <ul
                    className="usage-chart"
                    aria-label={tr("Tokens per period", "Tokens par période")}
                  >
                    {periods.map(({ key, totals: t }) => {
                      const tokens = t.inputTokens + t.outputTokens;
                      return (
                        <li key={key} title={`${key}: ${tokens.toLocaleString()} tokens`}>
                          <span className="usage-chart-value">{tokens.toLocaleString()}</span>
                          <span
                            className="usage-chart-bar"
                            style={{ height: `${String(Math.max(2, (tokens / peak) * 100))}%` }}
                          />
                          <span className="usage-chart-label">{key}</span>
                        </li>
                      );
                    })}
                  </ul>
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
                        <td>{key}</td>
                        <td>{t.runs.toLocaleString()}</td>
                        <td>{t.inputTokens.toLocaleString()}</td>
                        <td>{t.outputTokens.toLocaleString()}</td>
                        <td>{number(t.cacheReadTokens)}</td>
                        <td>{number(t.cacheWriteTokens)}</td>
                        <td>
                          {t.estimatedApiCostUsd === null
                            ? unavailable
                            : `$${t.estimatedApiCostUsd.toFixed(2)}`}
                        </td>
                      </tr>
                    ))}
                  </Table>
                </>
              )}
            </>
          );
        }}
      </Section>
      <h3>{tr("Run history", "Historique des runs")}</h3>
      <Section state={usage}>
        {(data) =>
          data.runs.length === 0 ? (
            <Empty>
              {tr(
                "No observed runs in this period.",
                "Aucune exécution observée sur cette période.",
              )}
            </Empty>
          ) : (
            <Table
              head={[
                tr("Date", "Date"),
                tr("Model", "Modèle"),
                tr("Status", "État"),
                tr("Input tokens", "Tokens entrants"),
                tr("Output tokens", "Tokens sortants"),
                tr("Cache read", "Cache lu"),
                tr("Cache write", "Cache écrit"),
              ]}
            >
              {data.runs.map((run) => (
                <tr key={run.runId}>
                  <td>{new Date(run.startedAt).toLocaleString()}</td>
                  <td>{run.model}</td>
                  <td>{run.status}</td>
                  <td>{run.inputTokens.toLocaleString()}</td>
                  <td>{run.outputTokens.toLocaleString()}</td>
                  <td>{number(run.cacheReadTokens)}</td>
                  <td>{number(run.cacheWriteTokens)}</td>
                </tr>
              ))}
            </Table>
          )
        }
      </Section>
      <nav aria-label={tr("Usage pages", "Pages de consommation")}>
        <button
          disabled={usage.loading || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          {tr("Previous", "Précédent")}
        </button>
        <button
          disabled={usage.loading || usage.error !== undefined || usage.data?.nextOffset == null}
          onClick={() => {
            if (usage.data?.nextOffset != null) setOffset(usage.data.nextOffset);
          }}
        >
          {tr("Next", "Suivant")}
        </button>
      </nav>
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
              ]}
            >
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>{account.provider}</td>
                  <td>{account.name}</td>
                  <td>{account.authStatus}</td>
                  <td>
                    {account.remaining5hPercent === null
                      ? unavailable
                      : `${String(account.remaining5hPercent)} %`}
                  </td>
                  <td>
                    {account.resets5hAt === null
                      ? unavailable
                      : new Date(account.resets5hAt).toLocaleString()}
                  </td>
                  <td>
                    {account.remainingWeekPercent === null
                      ? unavailable
                      : `${String(account.remainingWeekPercent)} %`}
                  </td>
                  <td>
                    {account.resetsWeekAt === null
                      ? unavailable
                      : new Date(account.resetsWeekAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </Table>
          )
        }
      </Section>
      <h3>{tr("Quota forecast", "Prévision de quota")}</h3>
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
                                : "muted"
                        }
                        label={f.confidence.toUpperCase()}
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
