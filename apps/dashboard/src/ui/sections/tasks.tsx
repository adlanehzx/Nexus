import { useState } from "react";
import type { DashboardApi, TaskDetail, TaskExecution } from "../../lib/api.js";
import { failedSteps, formatAge, formatDuration, selectedWorkers } from "../../lib/format.js";
import { Bar, Empty, Section, State, Table, useSection } from "../parts.js";
import { IconCheck, IconClock, IconStop, IconWarning, IconRefresh } from "../icons.js";
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
                      <button
                        type="button"
                        className="button compact"
                        aria-expanded={selected === task.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelected(task.id === selected ? null : task.id);
                        }}
                      >
                        {task.title}
                      </button>
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

              {selected === null ? null : (
                <TaskDetailView key={selected} api={api} taskId={selected} />
              )}
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

          {task.source === "device" ? (
            <TaskExecutionHistory api={api} taskId={taskId} />
          ) : (
            <>
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
            </>
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

function TaskExecutionHistory({ api, taskId }: { api: DashboardApi; taskId: string }) {
  const { tr } = useI18n();
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const state = useSection(() => api.taskExecutions(taskId, cursor), [taskId, cursor]);

  return (
    <section
      aria-busy={state.loading}
      aria-label={tr("Execution history", "Historique des exécutions")}
    >
      <h3>{tr("Execution history", "Historique des exécutions")}</h3>
      <button className="button" type="button" disabled={state.loading} onClick={state.reload}>
        <IconRefresh /> {tr("Refresh", "Actualiser")}
      </button>
      <Section state={state}>
        {(page) => (
          <>
            <p className="muted">
              {tr("Total runs", "Nombre d'exécutions")}: {page.meta.total}
            </p>
            {page.data.length === 0 ? (
              <Empty>{tr("No recorded executions.", "Aucune exécution enregistrée.")}</Empty>
            ) : (
              page.data.map((execution) => (
                <ExecutionInspection key={execution.id} execution={execution} />
              ))
            )}
            <nav aria-label={tr("Execution pages", "Pages des exécutions")}>
              <button
                className="button"
                type="button"
                disabled={state.loading || cursors.length === 0}
                onClick={() => setCursors((previous) => previous.slice(0, -1))}
              >
                {tr("Previous", "Précédent")}
              </button>
              <span className="muted">
                {" "}
                {tr("Page", "Page")} {cursors.length + 1}{" "}
              </span>
              <button
                className="button"
                type="button"
                disabled={state.loading || page.meta.nextCursor === null}
                onClick={() => {
                  const next = page.meta.nextCursor;
                  if (next !== null) setCursors((previous) => [...previous, next]);
                }}
              >
                {tr("Next", "Suivant")}
              </button>
            </nav>
          </>
        )}
      </Section>
    </section>
  );
}

/** Results vary by tool; absence of process output must not imply a successful exit. */
export function ExecutionInspection({ execution }: { execution: TaskExecution }) {
  const { tr } = useI18n();
  const result =
    execution.result !== null && typeof execution.result === "object"
      ? (execution.result as Record<string, unknown>)
      : {};
  const exitCode =
    typeof result.exitCode === "number"
      ? String(result.exitCode)
      : tr("Not available", "Indisponible");
  const StatusIcon =
    execution.status === "succeeded"
      ? IconCheck
      : execution.status === "failed"
        ? IconWarning
        : execution.status === "cancelled"
          ? IconStop
          : IconClock;
  const timestamp = (value: string | null) =>
    value === null ? tr("Not completed", "Non terminée") : <time dateTime={value}>{value}</time>;

  return (
    <details className="card">
      <summary>
        <span
          className={`state-pill ${execution.status === "running" ? "running" : taskTone(execution.status)}`}
        >
          <StatusIcon /> {execution.status}
        </span>{" "}
        <span className="mono">{execution.id}</span> {tr("Attempt", "Tentative")}{" "}
        {execution.attempt} ({formatDuration(execution.durationMs)})
      </summary>
      <dl>
        <dt>{tr("Step", "Étape")}</dt>
        <dd className="mono">{execution.stepId}</dd>
        <dt>{tr("Worker", "Agent")}</dt>
        <dd className="mono">{execution.deviceId}</dd>
        <dt>{tr("Started", "Début")}</dt>
        <dd>{timestamp(execution.startedAt)}</dd>
        <dt>{tr("Completed", "Fin")}</dt>
        <dd>{timestamp(execution.completedAt)}</dd>
        <dt>{tr("Duration", "Durée")}</dt>
        <dd>{formatDuration(execution.durationMs)}</dd>
        <dt>{tr("Exit code", "Code de sortie")}</dt>
        <dd>{exitCode}</dd>
      </dl>
      {execution.error === null ? null : (
        <p className="banner error">
          {execution.error.code}: {execution.error.message}
        </p>
      )}
      {(["stdout", "stderr"] as const).map((stream) => (
        <section key={stream} aria-label={stream}>
          <h4>{stream}</h4>
          <pre
            className="mono"
            tabIndex={0}
            style={{
              maxHeight: "24rem",
              overflow: "auto",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {typeof result[stream] === "string" && result[stream].length > 0
              ? result[stream]
              : tr("No output recorded.", "Aucune sortie enregistrée.")}
          </pre>
        </section>
      ))}
      <details>
        <summary>{tr("Input and full result", "Entrée et résultat complet")}</summary>
        <pre
          className="mono"
          tabIndex={0}
          style={{
            maxHeight: "24rem",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {JSON.stringify({ input: execution.input, result: execution.result }, null, 2)}
        </pre>
      </details>
    </details>
  );
}
