import type { DashboardApi } from "../../lib/api.js";
import { Bar, Empty, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 16. Phase 2: Quota Forecast (Codex Contract)
// ─────────────────────────────────────────────────────────────────────────────

export function QuotaForecast({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.quotaForecast());
  const usage = useSection(() => api.usage());

  return (
    <div className="content">
      <h2>{tr("Observed usage — last 30 days", "Consommation observée — 30 derniers jours")}</h2>
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
