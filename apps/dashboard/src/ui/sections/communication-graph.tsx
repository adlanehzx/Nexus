import { useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import { Empty, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 18. Phase 2: Communication Graph (Codex Contract)
// ─────────────────────────────────────────────────────────────────────────────

export function CommunicationGraph({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const [range, setRange] = useState("24h");
  const state = useSection(() => api.communicationGraph(range), [range]);

  return (
    <div className="content">
      <div
        className="filter-bar"
        style={{ marginBottom: "16px", display: "flex", gap: "12px", alignItems: "center" }}
      >
        <label htmlFor="comm-range" style={{ fontSize: "0.85rem" }}>
          {tr("Time window:", "Fenêtre temporelle :")}
        </label>
        <select
          id="comm-range"
          className="field"
          value={range}
          onChange={(e) => {
            setRange(e.target.value);
          }}
          style={{ maxWidth: "160px" }}
        >
          <option value="1h">{tr("Last 1 hour", "Dernière heure")}</option>
          <option value="24h">{tr("Last 24 hours", "Dernières 24 heures")}</option>
          <option value="7d">{tr("Last 7 days", "7 derniers jours")}</option>
        </select>
      </div>

      <Section state={state}>
        {(graph) => (
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "12px" }}>
              <div className="card" style={{ padding: "12px 16px" }}>
                <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>
                  {tr("Active Agents", "Agents actifs")}
                </div>
                <div style={{ fontWeight: 600, fontSize: "1.1rem", marginTop: "4px" }}>
                  {graph.nodes.length}
                </div>
              </div>

              <div className="card" style={{ padding: "12px 16px" }}>
                <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>
                  {tr("Inter-agent Channels", "Canaux de communication inter-agents")}
                </div>
                <div style={{ fontWeight: 600, fontSize: "1.1rem", marginTop: "4px" }}>
                  {graph.edges.length}
                </div>
              </div>

              <div className="card" style={{ padding: "12px 16px" }}>
                <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-muted, #888)" }}>
                  {tr("Total Messages Exchanged", "Total des messages échangés")}
                </div>
                <div style={{ fontWeight: 600, fontSize: "1.1rem", marginTop: "4px", color: "var(--color-accent, #00e5ff)" }}>
                  {graph.edges.reduce((sum, e) => sum + e.messageCount, 0).toLocaleString()}
                </div>
              </div>
            </div>

            <section className="card">
              <h3>{tr("Participating Agents", "Agents Participants")}</h3>
              <div style={{ marginTop: "12px" }}>
                {graph.nodes.length === 0 ? (
                  <Empty>
                    {tr(
                      "No agents active in this time window.",
                      "Aucun agent actif dans cette fenêtre.",
                    )}
                  </Empty>
                ) : (
                  <Table
                    head={[
                      tr("Agent Name", "Nom de l'Agent"),
                      tr("Role", "Rôle"),
                      tr("Message Activity", "Activité de Messages"),
                    ]}
                  >
                    {graph.nodes.map((node) => (
                      <tr key={node.id}>
                        <td>
                          <strong>{node.name}</strong>{" "}
                          <span className="muted mono">({node.id})</span>
                        </td>
                        <td>{node.role}</td>
                        <td className="mono">{String(node.messageCount)} msg</td>
                      </tr>
                    ))}
                  </Table>
                )}
              </div>
            </section>

            <section className="card">
              <h3>{tr("Inter-Agent Channels & Latencies", "Canaux Inter-Agents & Latences")}</h3>
              <div style={{ marginTop: "12px" }}>
                {graph.edges.length === 0 ? (
                  <Empty>
                    {tr(
                      "No message channels detected in this window.",
                      "Aucun canal de message détecté dans cette fenêtre.",
                    )}
                  </Empty>
                ) : (
                  <Table
                    head={[
                      tr("Sender (Source)", "Expéditeur (Source)"),
                      tr("Receiver (Target)", "Destinataire (Cible)"),
                      tr("Messages Sent", "Messages Envoyés"),
                      tr("Avg Round-trip Latency", "Latence Aller-Retour Moy."),
                    ]}
                  >
                    {graph.edges.map((edge) => (
                      <tr key={`${edge.source}->${edge.target}`}>
                        <td className="mono">{edge.source}</td>
                        <td className="mono">{edge.target}</td>
                        <td className="mono">{String(edge.messageCount)}</td>
                        <td>
                          <State
                            tone={
                              edge.avgLatencyMs < 100
                                ? "ok"
                                : edge.avgLatencyMs < 300
                                  ? "degraded"
                                  : "down"
                            }
                            label={`${String(Math.round(edge.avgLatencyMs))} ms`}
                          />
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}
              </div>
            </section>
          </div>
        )}
      </Section>
    </div>
  );
}
