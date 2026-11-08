import { useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import { formatAge, formatCount, formatDuration } from "../../lib/format.js";
import { Empty, Metric, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 5. Agent Runs
// ─────────────────────────────────────────────────────────────────────────────

export function Runs({ api, embedded = false }: { api: DashboardApi; embedded?: boolean }) {
  const { tr } = useI18n();
  const state = useSection(() => api.runs());
  const observability = useSection(() => api.observability());
  const [selected, setSelected] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);

  const replay = async (runId: string): Promise<void> => {
    if (
      !globalThis.confirm(
        tr(
          "Create an analysis replay? Tools will be completely disabled to prevent any external effect.",
          "Créer un rejeu d'analyse ? Les outils seront complètement désactivés pour éviter tout effet externe.",
        ),
      )
    )
      return;
    setAction(tr("Replay in progress…", "Rejeu en cours…"));
    try {
      const result = await api.replayRun(runId);
      setAction(
        tr(
          `Replay ${result.runId.slice(0, 8)} completed: ${result.status}.`,
          `Rejeu ${result.runId.slice(0, 8)} terminé : ${result.status}.`,
        ),
      );
      state.reload();
      observability.reload();
    } catch (cause) {
      setAction(cause instanceof Error ? cause.message : tr("Replay failed.", "Échec du rejeu."));
    }
  };

  return (
    <div
      className={embedded ? undefined : "content"}
      style={embedded ? { marginTop: "0.5rem" } : undefined}
    >
      {embedded ? null : (
        <p className="muted" style={{ marginTop: 0 }}>
          {tr(
            "Status, actions, tools, progress, results, errors, and metrics.",
            "Statut, actions, outils, progression, résultats, erreurs et métriques.",
          )}
        </p>
      )}

      <Section state={observability}>
        {(summary) => (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "12px",
                marginBottom: "1rem",
              }}
            >
              <div className="card" style={{ padding: "12px 16px" }}>
                <div
                  style={{
                    fontSize: "0.75rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--color-muted, #888)",
                  }}
                >
                  {tr("Analyzed Runs", "Exécutions analysées")}
                </div>
                <div style={{ fontWeight: 600, fontSize: "1.1rem", marginTop: "4px" }}>
                  {formatCount(summary.totals.runs)}
                </div>
              </div>

              <div className="card" style={{ padding: "12px 16px" }}>
                <div
                  style={{
                    fontSize: "0.75rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--color-muted, #888)",
                  }}
                >
                  {tr("Fallback Rate", "Taux de secours")}
                </div>
                <div style={{ fontWeight: 600, fontSize: "1.1rem", marginTop: "4px" }}>
                  {asPercent(summary.rates.fallback)}
                </div>
              </div>

              <div className="card" style={{ padding: "12px 16px" }}>
                <div
                  style={{
                    fontSize: "0.75rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--color-muted, #888)",
                  }}
                >
                  {tr("Tool Errors", "Erreurs d'outils")}
                </div>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: "1.1rem",
                    marginTop: "4px",
                    color:
                      summary.rates.toolError > 0.1 ? "var(--color-error, #ff5252)" : "inherit",
                  }}
                >
                  {asPercent(summary.rates.toolError)}
                </div>
              </div>

              <div className="card" style={{ padding: "12px 16px" }}>
                <div
                  style={{
                    fontSize: "0.75rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--color-muted, #888)",
                  }}
                >
                  {tr("Failed Runs", "Exécutions échouées")}
                </div>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: "1.1rem",
                    marginTop: "4px",
                    color: summary.rates.runError > 0 ? "var(--color-warning, #ffb300)" : "inherit",
                  }}
                >
                  {asPercent(summary.rates.runError)}
                </div>
              </div>

              <div className="card" style={{ padding: "12px 16px" }}>
                <div
                  style={{
                    fontSize: "0.75rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--color-muted, #888)",
                  }}
                >
                  {tr("Equiv. API Cost", "Coût API équiv.")}
                </div>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: "1.1rem",
                    marginTop: "4px",
                    color: "var(--color-accent, #00e5ff)",
                  }}
                >
                  {formatEstimatedCost(summary.totals.estimatedApiEquivalentCostUsd)}
                </div>
              </div>
            </div>
            {summary.agents.length === 0 ? null : (
              <Table
                head={[
                  tr("Agent", "Agent"),
                  tr("Runs", "Exécutions"),
                  tr("Failures", "Échecs"),
                  tr("Average latency", "Latence moyenne"),
                  "p95",
                  tr("Tokens", "Jetons"),
                  tr("Equiv. cost", "Coût équiv."),
                ]}
              >
                {summary.agents.map((agent) => (
                  <tr key={agent.agent}>
                    <td className="mono">{agent.agent}</td>
                    <td>{agent.runs}</td>
                    <td>{agent.failures}</td>
                    <td>{formatDuration(agent.averageLatencyMs)}</td>
                    <td>{formatDuration(agent.p95LatencyMs)}</td>
                    <td>{formatCount(agent.inputTokens + agent.outputTokens)}</td>
                    <td>{formatEstimatedCost(agent.estimatedApiEquivalentCostUsd)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )}
      </Section>

      {action === null ? null : <p className="muted">{action}</p>}

      <Section state={state}>
        {(data) =>
          data.runs.length === 0 ? (
            <Empty>{tr("No recorded runs.", "Aucune exécution enregistrée.")}</Empty>
          ) : (
            <>
              <Table
                head={[
                  tr("Run", "Exécution"),
                  tr("Status", "Statut"),
                  tr("Stop Reason", "Raison d'arrêt"),
                  tr("Iterations", "Itérations"),
                  tr("Tools", "Outils"),
                  tr("Duration", "Durée"),
                  tr("Tokens", "Jetons"),
                ]}
              >
                {data.runs.map((run) => (
                  <tr
                    key={run.runId}
                    onClick={() => {
                      setSelected(run.runId === selected ? null : run.runId);
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <td className="mono">{run.runId.slice(0, 8)}</td>
                    <td>
                      <State tone={runTone(run.status)} label={run.status} />
                    </td>
                    <td className="muted">{run.stopReason ?? "—"}</td>
                    <td>{run.iterations}</td>
                    <td>
                      {run.metrics.toolCalls}
                      {run.metrics.failedToolCalls > 0 ? (
                        <span style={{ color: "var(--down)" }}>
                          {" "}
                          ({run.metrics.failedToolCalls} {tr("failed", "échoué(s)")})
                        </span>
                      ) : null}
                    </td>
                    <td className="muted">{formatDuration(run.durationMs)}</td>
                    <td className="muted">
                      {formatCount(run.metrics.inputTokens)} ↓ /{" "}
                      {formatCount(run.metrics.outputTokens)} ↑
                    </td>
                  </tr>
                ))}
              </Table>

              {data.runs
                .filter((run) => run.runId === selected)
                .map((run) => (
                  <div key={run.runId}>
                    <h3>{tr("Actions", "Actions")}</h3>
                    {run.tools.length === 0 ? (
                      <Empty>{tr("No tools called.", "Aucun outil appelé.")}</Empty>
                    ) : (
                      <Table
                        head={[
                          tr("Tool", "Outil"),
                          tr("Action", "Action"),
                          tr("Status", "Statut"),
                          tr("Risk", "Risque"),
                          tr("Duration", "Durée"),
                          tr("Attempts", "Tentatives"),
                          tr("Error", "Erreur"),
                        ]}
                      >
                        {run.tools.map((tool) => (
                          <tr key={tool.callId}>
                            <td className="mono">{tool.tool}</td>
                            <td className="mono muted">{tool.action}</td>
                            <td>
                              <State
                                tone={tool.status === "success" ? "ok" : "down"}
                                label={tool.status}
                              />
                            </td>
                            <td className="muted">{tool.riskLevel}</td>
                            <td className="muted">{formatDuration(tool.durationMs)}</td>
                            <td className="muted">{tool.attempts}</td>
                            <td className="muted">{tool.errorCode ?? "—"}</td>
                          </tr>
                        ))}
                      </Table>
                    )}

                    <h3>{tr("Result", "Résultat")}</h3>
                    <p>
                      {run.response ?? (
                        <span className="muted">
                          {tr("No final response.", "Aucune réponse finale.")}
                        </span>
                      )}
                    </p>

                    <button className="button" type="button" onClick={() => void replay(run.runId)}>
                      {tr("Replay (analysis only)", "Rejouer (analyse uniquement)")}
                    </button>
                    {run.replayOfRunId === null ? null : (
                      <p className="muted">
                        {tr("Replay of run", "Rejeu de l'exécution")}{" "}
                        <span className="mono">{run.replayOfRunId.slice(0, 8)}</span>.
                      </p>
                    )}

                    {run.errors.length === 0 ? null : (
                      <>
                        <h3>{tr("Errors", "Erreurs")}</h3>
                        <Table
                          head={[
                            tr("When", "Quand"),
                            tr("Iteration", "Itération"),
                            tr("Code", "Code"),
                            tr("Message", "Message"),
                          ]}
                        >
                          {run.errors.map((error, index) => (
                            <tr key={`${error.at}-${String(index)}`}>
                              <td className="muted">{formatAge(error.at)}</td>
                              <td>{error.iteration}</td>
                              <td className="mono">{error.code}</td>
                              <td>{error.message}</td>
                            </tr>
                          ))}
                        </Table>
                      </>
                    )}

                    <h3>{tr("Metrics", "Métriques")}</h3>
                    <div className="metrics">
                      <Metric value={run.metrics.model} label={tr("model", "modèle")} />
                      <Metric
                        value={formatCount(run.metrics.inputTokens)}
                        label={tr("input tokens", "jetons d'entrée")}
                      />
                      <Metric
                        value={formatCount(run.metrics.outputTokens)}
                        label={tr("output tokens", "jetons de sortie")}
                      />
                      <Metric
                        value={formatCount(run.metrics.cacheReadTokens)}
                        label={tr("cache read", "lecture cache")}
                      />
                    </div>
                  </div>
                ))}
            </>
          )
        }
      </Section>
    </div>
  );
}

function runTone(status: string): string {
  if (status === "completed") return "ok";
  if (status === "failed") return "down";
  if (status === "incomplete" || status === "waiting_for_confirmation") return "degraded";
  return "unknown";
}

function asPercent(rate: number): string {
  return `${String(Math.round(rate * 1_000) / 10)} %`;
}

function formatEstimatedCost(cost: number | null): string {
  return cost === null ? "—" : `${cost.toFixed(4)} $`;
}
