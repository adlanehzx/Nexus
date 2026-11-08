import { useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import { Empty, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 15. Phase 2: DAG Debugger (Codex Contract)
// ─────────────────────────────────────────────────────────────────────────────

export function DagDebugger({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const [taskId, setTaskId] = useState("task-current");
  const [queriedTaskId, setQueriedTaskId] = useState("task-current");
  const state = useSection(() => api.dagDebug(queriedTaskId), [queriedTaskId]);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = (op: () => Promise<unknown>) => {
    setActionError(null);
    void op()
      .then(() => state.reload())
      .catch((err: unknown) =>
        setActionError(
          err instanceof Error ? err.message : tr("Action failed.", "Échec de l'action."),
        ),
      );
  };

  return (
    <div className="content">
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <section className="card" style={{ marginBottom: "16px" }}>
        <div style={{ display: "flex", gap: "12px", alignItems: "flex-end" }}>
          <div>
            <label
              htmlFor="dag-task-id"
              style={{ display: "block", marginBottom: "4px", fontSize: "0.85rem" }}
            >
              {tr("Task ID to debug", "ID de tâche à déboguer")}
            </label>
            <input
              id="dag-task-id"
              className="field"
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              placeholder="e.g. task-123"
            />
          </div>
          <button className="button primary" type="button" onClick={() => setQueriedTaskId(taskId)}>
            {tr("Inspect DAG", "Inspecter le DAG")}
          </button>
        </div>
      </section>

      <Section state={state}>
        {(dag) => (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: "12px",
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
                  {tr("Active Task", "Tâche active")}
                </div>
                <div
                  className="mono"
                  style={{ fontWeight: 600, fontSize: "1rem", marginTop: "4px" }}
                >
                  {dag.taskId}
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
                  {tr("Total DAG Steps", "Étapes DAG totales")}
                </div>
                <div style={{ fontWeight: 600, fontSize: "1.1rem", marginTop: "4px" }}>
                  {dag.nodes.length}
                </div>
              </div>

              <div
                className="card"
                style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: "12px" }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    backgroundColor: dag.isPaused
                      ? "var(--color-warning, #ffb300)"
                      : "var(--color-success, #00e676)",
                  }}
                />
                <div>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      color: "var(--color-muted, #888)",
                    }}
                  >
                    {tr("Pipeline State", "État du pipeline")}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
                    {dag.isPaused ? tr("Paused", "En pause") : tr("Running", "En cours")}
                  </div>
                </div>
              </div>
            </div>

            {dag.nodes.length === 0 ? (
              <Empty>
                {tr(
                  "No execution nodes found in this DAG.",
                  "Aucun nœud d'exécution trouvé dans ce DAG.",
                )}
              </Empty>
            ) : (
              <Table
                head={[
                  tr("Step ID", "ID Étape"),
                  tr("Label", "Libellé"),
                  tr("Status", "Statut"),
                  tr("Dependencies", "Dépendances"),
                  tr("Assigned Worker", "Agent Assigné"),
                  tr("Result / Error", "Résultat / Erreur"),
                  tr("Actions", "Actions"),
                ]}
              >
                {dag.nodes.map((node) => (
                  <tr key={node.id}>
                    <td className="mono">{node.id}</td>
                    <td>{node.label}</td>
                    <td>
                      <State
                        tone={
                          node.status === "completed"
                            ? "ok"
                            : node.status === "running"
                              ? "good"
                              : node.status === "paused"
                                ? "degraded"
                                : node.status === "failed"
                                  ? "down"
                                  : "muted"
                        }
                        label={node.status.toUpperCase()}
                      />
                    </td>
                    <td className="mono muted">
                      {node.dependencies.length === 0 ? "—" : node.dependencies.join(", ")}
                    </td>
                    <td>{node.assignedDevice ?? "—"}</td>
                    <td>
                      {node.error ? (
                        <span style={{ color: "var(--nx-danger)" }}>{node.error}</span>
                      ) : node.output !== undefined ? (
                        <span className="mono muted">
                          {JSON.stringify(node.output).slice(0, 40)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <div className="table-actions">
                        {node.status === "running" || node.status === "pending" ? (
                          <button
                            className="button compact"
                            type="button"
                            onClick={() => act(() => api.pauseDagStep(dag.taskId, node.id))}
                          >
                            {tr("Pause step", "Suspendre l'étape")}
                          </button>
                        ) : null}
                        {node.status === "paused" ? (
                          <button
                            className="button compact primary"
                            type="button"
                            onClick={() => act(() => api.resumeDagStep(dag.taskId, node.id))}
                          >
                            {tr("Resume step", "Reprendre l'étape")}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}
