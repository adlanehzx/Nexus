import type { DashboardApi } from "../../lib/api.js";
import { WORKER_LABELS, formatAge, workerState } from "../../lib/format.js";
import { Bar, Empty, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 3. Workers
// ─────────────────────────────────────────────────────────────────────────────

export function Workers({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.workers());

  return (
    <div className="content">
      <Section state={state}>
        {(data) =>
          data.workers.length === 0 ? (
            <Empty>{tr("No paired workers.", "Aucun agent jumelé.")}</Empty>
          ) : (
            <Table
              head={[
                tr("Worker", "Agent"),
                tr("State", "État"),
                tr("Channel", "Canal"),
                tr("Load", "Charge"),
                tr("Capabilities", "Capacités"),
                tr("Seen", "Vu"),
              ]}
            >
              {data.workers.map((worker) => {
                const derived = workerState(worker);
                return (
                  <tr key={worker.id}>
                    <td>
                      {worker.name}
                      <div className="muted mono">{worker.role}</div>
                    </td>
                    <td>
                      <State
                        tone={derived}
                        label={tr(
                          WORKER_LABELS[derived],
                          derived === "accepting"
                            ? "disponible"
                            : derived === "saturated"
                              ? "saturé"
                              : derived === "degraded"
                                ? "dégradé"
                                : derived === "disconnected"
                                  ? "déconnecté"
                                  : "révoqué",
                        )}
                      />
                    </td>
                    <td className="muted">
                      {worker.connected ? tr("open", "ouvert") : tr("closed", "fermé")}
                    </td>
                    <td>
                      <Bar
                        percent={
                          worker.health.maxConcurrentTasks === 0
                            ? 0
                            : (worker.health.activeTasks / worker.health.maxConcurrentTasks) * 100
                        }
                      />
                      <span className="muted">
                        {worker.health.activeTasks}/{worker.health.maxConcurrentTasks}
                      </span>
                    </td>
                    <td className="mono">
                      {worker.capabilities.length === 0
                        ? "—"
                        : worker.capabilities.map((capability) => capability.name).join(", ")}
                    </td>
                    <td className="muted">{formatAge(worker.lastHeartbeatAt)}</td>
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
