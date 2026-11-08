import { useState } from "react";
import type { DashboardApi, TaskDetail } from "../../lib/api.js";
import { failedSteps, formatAge, formatDuration, selectedWorkers } from "../../lib/format.js";
import { Bar, Empty, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 4. Tasks
// ─────────────────────────────────────────────────────────────────────────────

export function Tasks({ api, embedded = false }: { api: DashboardApi; embedded?: boolean }) {
  const { tr } = useI18n();
  const state = useSection(() => api.tasks());
  const [selected, setSelected] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const inner = (
    <>
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <Section state={state}>
        {(data) =>
          data.tasks.length === 0 ? (
            <Empty>{tr("No tasks.", "Aucune tâche.")}</Empty>
          ) : (
            <>
              <Table
                head={[
                  tr("Task", "Tâche"),
                  tr("Status", "Statut"),
                  tr("Progress", "Progression"),
                  tr("Origin", "Origine"),
                  tr("Created", "Créée"),
                  tr("Duration", "Durée"),
                  tr("Actions", "Actions"),
                ]}
              >
                {data.tasks.map((task) => (
                  <tr
                    key={task.id}
                    onClick={() => {
                      setSelected(task.id === selected ? null : task.id);
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <td>
                      {task.title}
                      <div className="muted mono">
                        {task.source.toUpperCase()} · {task.correlationId}
                      </div>
                    </td>
                    <td>
                      <State tone={taskTone(task.status)} label={task.status} />
                    </td>
                    <td>
                      <Bar percent={task.progressPercent} />
                    </td>
                    <td className="muted mono">
                      {task.source === "acp"
                        ? "orchestrator"
                        : task.originClientDeviceId.slice(0, 8)}
                    </td>
                    <td className="muted">{formatAge(task.createdAt)}</td>
                    <td className="muted">
                      {formatDuration(
                        task.startedAt === null || task.completedAt === null
                          ? null
                          : new Date(task.completedAt).getTime() -
                              new Date(task.startedAt).getTime(),
                      )}
                    </td>
                    <td>
                      {task.source === "device" &&
                      new Set(["running", "pending", "waiting_for_confirmation"]).has(
                        task.status,
                      ) ? (
                        <button
                          className="button danger"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (
                              !window.confirm(
                                tr(`Cancel "${task.title}"?`, `Annuler "${task.title}" ?`),
                              )
                            )
                              return;
                            void api
                              .cancelTask(task.id)
                              .then(() => state.reload())
                              .catch((cause: unknown) =>
                                setActionError(
                                  cause instanceof Error
                                    ? cause.message
                                    : tr("Cancellation failed.", "Échec de l'annulation."),
                                ),
                              );
                          }}
                        >
                          {tr("Cancel", "Annuler")}
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </Table>

              {selected === null ? null : <TaskDetailView api={api} taskId={selected} />}
            </>
          )
        }
      </Section>
    </>
  );

  return embedded ? inner : <div className="content">{inner}</div>;
}

function taskTone(status: string): string {
  if (status === "succeeded") return "ok";
  if (status === "failed") return "down";
  if (status === "partial" || status === "waiting_for_confirmation") return "degraded";
  return "unknown";
}

/**
 * Task details.
 *
 * Execution plan, steps, assigned workers, progress, execution log, results, and errors.
 */
function TaskDetailView({ api, taskId }: { api: DashboardApi; taskId: string }) {
  const { tr } = useI18n();
  const state = useSection<TaskDetail>(() => api.task(taskId), [taskId]);

  return (
    <Section state={state}>
      {(task) => (
        <>
          <h3>{tr("Selected Workers", "Agents Sélectionnés")}</h3>
          {selectedWorkers(task).length === 0 ? (
            <Empty>
              {tr(
                "No workers selected — the task has not been dispatched yet.",
                "Aucun agent sélectionné — la tâche n'a pas encore été distribuée.",
              )}
            </Empty>
          ) : (
            <Table head={[tr("Worker", "Agent"), tr("Steps", "Étapes")]}>
              {selectedWorkers(task).map((worker) => (
                <tr key={worker.id}>
                  <td>{worker.name}</td>
                  <td>{worker.steps}</td>
                </tr>
              ))}
            </Table>
          )}

          <h3>{tr("Steps", "Étapes")}</h3>
          <Table
            head={[
              "#",
              tr("Description", "Description"),
              tr("Tool", "Outil"),
              tr("Capabilities", "Capacités"),
              tr("Status", "Statut"),
              tr("Worker", "Agent"),
              tr("Risk", "Risque"),
            ]}
          >
            {task.steps.map((step, index) => (
              <tr key={step.id}>
                <td className="muted">{index + 1}</td>
                <td>{step.description}</td>
                <td className="mono">{step.tool}</td>
                <td className="mono muted">{step.requiredCapabilities.join(", ")}</td>
                <td>
                  <State tone={taskTone(step.status)} label={step.status} />
                </td>
                <td>{step.selectedDeviceName ?? "—"}</td>
                <td className="muted">{step.riskLevel}</td>
              </tr>
            ))}
          </Table>

          <h3>{tr("Execution Log", "Journal d'Exécution")}</h3>
          {task.executions.length === 0 ? (
            <Empty>{tr("No recorded executions.", "Aucune exécution enregistrée.")}</Empty>
          ) : (
            <Table
              head={[
                tr("Step", "Étape"),
                tr("Worker", "Agent"),
                tr("Status", "Statut"),
                tr("Duration", "Durée"),
                tr("Result", "Résultat"),
                tr("Error", "Erreur"),
              ]}
            >
              {task.executions.map((execution) => (
                <tr key={execution.id}>
                  <td className="mono">{execution.stepId}</td>
                  <td>{execution.deviceName ?? execution.deviceId.slice(0, 8)}</td>
                  <td>
                    <State tone={taskTone(execution.status)} label={execution.status} />
                  </td>
                  <td className="muted">{formatDuration(execution.durationMs)}</td>
                  <td className="mono muted">
                    {execution.result === null
                      ? "—"
                      : JSON.stringify(execution.result).slice(0, 120)}
                  </td>
                  <td className="muted">
                    {execution.error === null
                      ? "—"
                      : `${execution.error.code} — ${execution.error.message}`}
                  </td>
                </tr>
              ))}
            </Table>
          )}

          {failedSteps(task).length === 0 ? null : (
            <>
              <h3>{tr("Errors", "Erreurs")}</h3>
              <Table head={[tr("Step", "Étape"), tr("Code", "Code"), tr("Message", "Message")]}>
                {failedSteps(task).map((step) => (
                  <tr key={step.id}>
                    <td>{step.description}</td>
                    <td className="mono">{step.error?.code ?? "—"}</td>
                    <td>{step.error?.message ?? "—"}</td>
                  </tr>
                ))}
              </Table>
            </>
          )}
        </>
      )}
    </Section>
  );
}
