import { useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import { Bar, Empty, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 16. Phase 2: Quota Forecast (Codex Contract)
// ─────────────────────────────────────────────────────────────────────────────

export function QuotaForecast({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.quotaForecast());
  const [days, setDays] = useState(30);
  const [offset, setOffset] = useState(0);
  const usage = useSection(() => api.usage(days, offset), [api, days, offset]);

  return (
    <div className="content">
      <h2>{tr("Observed usage", "Consommation observée")}</h2>
      <label>
        {tr("Period", "Période")}
        <select
          value={days}
          onChange={(event) => {
            setDays(Number(event.target.value));
            setOffset(0);
          }}
        >
          <option value={1}>{tr("24 hours", "24 heures")}</option>
          <option value={7}>{tr("7 days", "7 jours")}</option>
          <option value={30}>{tr("30 days", "30 jours")}</option>
          <option value={90}>{tr("90 days", "90 jours")}</option>
        </select>
      </label>
      <p>
        {tr(
          "Agent Core runs for your account. Provider subscription quotas and billed costs are unavailable here.",
          "Runs Agent Core de votre compte. Les quotas d’abonnement et les coûts facturés sont indisponibles ici.",
        )}
      </p>
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
                  <td>{run.inputTokens.toLocaleString()}</td>
                  <td>{run.outputTokens.toLocaleString()}</td>
                  <td>
                    {run.cacheReadTokens?.toLocaleString() ?? tr("Unavailable", "Indisponible")}
                  </td>
                  <td>
                    {run.cacheWriteTokens?.toLocaleString() ?? tr("Unavailable", "Indisponible")}
                  </td>
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
