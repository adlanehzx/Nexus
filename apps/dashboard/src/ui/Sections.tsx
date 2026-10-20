import { useEffect, useState } from "react";
import type { DashboardApi, McpConfiguration, MissionCollaborationDto, TaskDetail } from "../lib/api.js";
import {
  HEALTH_LABELS,
  WORKER_LABELS,
  failedSteps,
  formatAge,
  formatCount,
  formatDuration,
  overallHealth,
  selectedWorkers,
  sortActivity,
  workerState,
} from "../lib/format.js";
import { Bar, Empty, Metric, Section, State, Table, useSection } from "./parts.js";

/**
 * Les sections de supervision.
 *
 * Chacune charge la sienne : une section qui échoue n'emporte pas les autres, et
 * un serveur MCP injoignable ne doit pas vider l'écran des exécutants.
 *
 * Les actions d'administration réutilisent les routes métier existantes. Les
 * opérations irréversibles restent confirmées explicitement ; aucune section
 * ne contourne les permissions ni les validations du cœur.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Vue d'ensemble
// ─────────────────────────────────────────────────────────────────────────────

export function Overview({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.overview());

  return (
    <div className="contenu">
      <Section state={state}>
        {(data) => (
          <>
            <div className="mesures">
              <Metric value={formatCount(data.devices.online)} label="appareils en ligne" />
              <Metric value={formatCount(data.workers.connected)} label="exécutants connectés" />
              <Metric value={formatCount(data.tasks.running)} label="tâches en cours" />
              <Metric
                value={formatCount(data.tasks.failed)}
                label="tâches en échec"
                alert={data.tasks.failed > 0}
              />
              <Metric value={formatCount(data.agentRuns.running)} label="runs agent actifs" />
              <Metric
                value={formatCount(data.agentRuns.waitingForConfirmation)}
                label="en attente de confirmation"
                alert={data.agentRuns.waitingForConfirmation > 0}
              />
              <Metric value={formatCount(data.notifications.unread)} label="alertes non lues" />
              <Metric
                value={HEALTH_LABELS[levelOf(overallHealth(data.health))]}
                label="santé globale"
                alert={overallHealth(data.health) === "down"}
              />
            </div>

            <h3>Santé des sous-systèmes</h3>
            <Table head={["Sous-système", "État", "Détail"]}>
              {data.health.map((entry) => (
                <tr key={entry.name}>
                  <td>{entry.name}</td>
                  <td>
                    <State tone={entry.level} label={HEALTH_LABELS[entry.level]} />
                  </td>
                  <td className="faible">{entry.detail}</td>
                </tr>
              ))}
            </Table>

            <h3>Activité récente</h3>
            {data.recentActivity.length === 0 ? (
              <Empty>Rien à signaler.</Empty>
            ) : (
              <Table head={["Quand", "Source", "Événement"]}>
                {sortActivity(data.recentActivity).map((entry, index) => (
                  <tr key={`${entry.at}-${String(index)}`}>
                    <td className="faible">{formatAge(entry.at)}</td>
                    <td>
                      <State
                        tone={entry.level === "info" ? "ok" : entry.level}
                        label={entry.kind}
                      />
                    </td>
                    <td>{entry.summary}</td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )}
      </Section>
    </div>
  );
}

/** L'état global emprunte le vocabulaire des sous-systèmes pour son libellé. */
function levelOf(overall: ReturnType<typeof overallHealth>): keyof typeof HEALTH_LABELS {
  return overall === "unknown" ? "unconfigured" : overall;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Appareils
// ─────────────────────────────────────────────────────────────────────────────

export function Devices({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.devices());
  const [actionError, setActionError] = useState<string | null>(null);

  const act = (operation: () => Promise<unknown>): void => {
    setActionError(null);
    void operation()
      .then(() => state.reload())
      .catch((cause: unknown) =>
        setActionError(cause instanceof Error ? cause.message : "Action impossible."),
      );
  };

  return (
    <div className="contenu">
      {actionError === null ? null : <p className="banniere erreur">{actionError}</p>}
      <Section state={state}>
        {(data) =>
          data.devices.length === 0 ? (
            <Empty>Aucun appareil appairé.</Empty>
          ) : (
            <Table
              head={[
                "Appareil",
                "Rôle",
                "Plateforme",
                "Statut",
                "Confiance",
                "Capacités",
                "Dernier battement",
                "Santé",
                "Permissions",
                "Actions",
              ]}
            >
              {data.devices.map((device) => (
                <tr key={device.id}>
                  <td>
                    {device.name}
                    <div className="faible mono">{device.type}</div>
                  </td>
                  <td>{device.role}</td>
                  <td>{device.platform}</td>
                  <td>
                    <State
                      tone={
                        device.status === "ONLINE"
                          ? "ok"
                          : device.status === "DEGRADED"
                            ? "degraded"
                            : "down"
                      }
                      label={device.status}
                    />
                  </td>
                  <td>
                    <State
                      tone={
                        device.trust === "TRUSTED"
                          ? "ok"
                          : device.trust === "PENDING"
                            ? "degraded"
                            : "revoked"
                      }
                      label={device.trust}
                    />
                  </td>
                  <td className="mono">
                    {device.capabilities.length === 0
                      ? "—"
                      : device.capabilities
                          .filter((capability) => capability.enabled)
                          .map((capability) => capability.name)
                          .join(", ")}
                  </td>
                  <td className="faible">{formatAge(device.lastHeartbeatAt)}</td>
                  <td className="faible">
                    {device.health.activeTasks}/{device.health.maxConcurrentTasks} tâche(s)
                    {device.health.cpuLoad === null
                      ? ""
                      : ` · CPU ${String(Math.round(device.health.cpuLoad * 100))} %`}
                    {device.health.batteryPercent === null
                      ? ""
                      : ` · batterie ${String(device.health.batteryPercent)} %`}
                  </td>
                  <td className="mono faible">
                    {device.grantedPermissions.length === 0
                      ? "—"
                      : device.grantedPermissions.join(", ")}
                  </td>
                  <td>
                    <div className="table-actions">
                      {device.trust === "PENDING" ? (
                        <button
                          className="bouton"
                          type="button"
                          onClick={() => act(() => api.trustDevice(device.id))}
                        >
                          Approuver
                        </button>
                      ) : null}
                      {device.trust !== "REVOKED" ? (
                        <>
                          <button
                            className="bouton"
                            type="button"
                            onClick={() => {
                              const value = window.prompt(
                                "Permissions séparées par des virgules",
                                device.grantedPermissions.join(", "),
                              );
                              if (value !== null)
                                act(() =>
                                  api.updateDevicePermissions(
                                    device.id,
                                    value
                                      .split(",")
                                      .map((item) => item.trim())
                                      .filter(Boolean),
                                  ),
                                );
                            }}
                          >
                            Permissions
                          </button>
                          <button
                            className="bouton danger"
                            type="button"
                            onClick={() => {
                              if (window.confirm(`Révoquer définitivement ${device.name} ?`))
                                act(() => api.revokeDevice(device.id));
                            }}
                          >
                            Révoquer
                          </button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          )
        }
      </Section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Exécutants
// ─────────────────────────────────────────────────────────────────────────────

export function Workers({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.workers());

  return (
    <div className="contenu">
      <Section state={state}>
        {(data) =>
          data.workers.length === 0 ? (
            <Empty>Aucun exécutant appairé.</Empty>
          ) : (
            <Table head={["Exécutant", "État", "Canal", "Charge", "Capacités", "Vu"]}>
              {data.workers.map((worker) => {
                const derived = workerState(worker);
                return (
                  <tr key={worker.id}>
                    <td>
                      {worker.name}
                      <div className="faible mono">{worker.role}</div>
                    </td>
                    <td>
                      <State tone={derived} label={WORKER_LABELS[derived]} />
                    </td>
                    <td className="faible">
                      {/* Le rôle déclaré et le canal réellement ouvert sont deux
                          choses : un exécutant appairé mais déconnecté n'exécutera
                          rien, et n'afficher que le rôle ferait croire l'inverse. */}
                      {worker.connected ? "ouvert" : "fermé"}
                    </td>
                    <td>
                      <Bar
                        percent={
                          worker.health.maxConcurrentTasks === 0
                            ? 0
                            : (worker.health.activeTasks / worker.health.maxConcurrentTasks) * 100
                        }
                      />
                      <span className="faible">
                        {worker.health.activeTasks}/{worker.health.maxConcurrentTasks}
                      </span>
                    </td>
                    <td className="mono">
                      {worker.capabilities.length === 0
                        ? "—"
                        : worker.capabilities.map((capability) => capability.name).join(", ")}
                    </td>
                    <td className="faible">{formatAge(worker.lastHeartbeatAt)}</td>
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

// ─────────────────────────────────────────────────────────────────────────────
// 4. Tâches
// ─────────────────────────────────────────────────────────────────────────────

export function Tasks({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.tasks());
  const [selected, setSelected] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <div className="contenu">
      {actionError === null ? null : <p className="banniere erreur">{actionError}</p>}
      <Section state={state}>
        {(data) =>
          data.tasks.length === 0 ? (
            <Empty>Aucune tâche.</Empty>
          ) : (
            <>
              <Table
                head={["Tâche", "Statut", "Progression", "Origine", "Créée", "Durée", "Actions"]}
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
                      <div className="faible mono">
                        {task.source.toUpperCase()} · {task.correlationId}
                      </div>
                    </td>
                    <td>
                      <State tone={taskTone(task.status)} label={task.status} />
                    </td>
                    <td>
                      <Bar percent={task.progressPercent} />
                    </td>
                    <td className="faible mono">
                      {task.source === "acp"
                        ? "orchestrateur"
                        : task.originClientDeviceId.slice(0, 8)}
                    </td>
                    <td className="faible">{formatAge(task.createdAt)}</td>
                    <td className="faible">
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
                          className="bouton danger"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!window.confirm(`Annuler « ${task.title} » ?`)) return;
                            void api
                              .cancelTask(task.id)
                              .then(() => state.reload())
                              .catch((cause: unknown) =>
                                setActionError(
                                  cause instanceof Error ? cause.message : "Annulation impossible.",
                                ),
                              );
                          }}
                        >
                          Annuler
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
    </div>
  );
}

function taskTone(status: string): string {
  if (status === "succeeded") return "ok";
  if (status === "failed") return "down";
  if (status === "partial" || status === "waiting_for_confirmation") return "degraded";
  return "unknown";
}

/**
 * Le détail d'une tâche.
 *
 * C'est la page que la consigne décrit : le plan, ses étapes, les exécutants
 * retenus, la progression, le journal d'exécution, les résultats, les erreurs.
 */
function TaskDetailView({ api, taskId }: { api: DashboardApi; taskId: string }) {
  const state = useSection<TaskDetail>(() => api.task(taskId));

  return (
    <Section state={state}>
      {(task) => (
        <>
          <h3>Exécutants retenus</h3>
          {selectedWorkers(task).length === 0 ? (
            <Empty>Aucun exécutant retenu — la tâche n&apos;a pas encore été dispatchée.</Empty>
          ) : (
            <Table head={["Exécutant", "Étapes"]}>
              {selectedWorkers(task).map((worker) => (
                <tr key={worker.id}>
                  <td>{worker.name}</td>
                  <td>{worker.steps}</td>
                </tr>
              ))}
            </Table>
          )}

          <h3>Étapes</h3>
          <Table head={["#", "Description", "Outil", "Capacités", "Statut", "Exécutant", "Risque"]}>
            {task.steps.map((step, index) => (
              <tr key={step.id}>
                <td className="faible">{index + 1}</td>
                <td>{step.description}</td>
                <td className="mono">{step.tool}</td>
                <td className="mono faible">{step.requiredCapabilities.join(", ")}</td>
                <td>
                  <State tone={taskTone(step.status)} label={step.status} />
                </td>
                <td>{step.selectedDeviceName ?? "—"}</td>
                <td className="faible">{step.riskLevel}</td>
              </tr>
            ))}
          </Table>

          <h3>Journal d&apos;exécution</h3>
          {task.executions.length === 0 ? (
            <Empty>Aucune exécution enregistrée.</Empty>
          ) : (
            <Table head={["Étape", "Exécutant", "Statut", "Durée", "Résultat", "Erreur"]}>
              {task.executions.map((execution) => (
                <tr key={execution.id}>
                  <td className="mono">{execution.stepId}</td>
                  <td>{execution.deviceName ?? execution.deviceId.slice(0, 8)}</td>
                  <td>
                    <State tone={taskTone(execution.status)} label={execution.status} />
                  </td>
                  <td className="faible">{formatDuration(execution.durationMs)}</td>
                  <td className="mono faible">
                    {execution.result === null
                      ? "—"
                      : JSON.stringify(execution.result).slice(0, 120)}
                  </td>
                  <td className="faible">
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
              <h3>Erreurs</h3>
              <Table head={["Étape", "Code", "Message"]}>
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

// ─────────────────────────────────────────────────────────────────────────────
// 5. Runs d'agent
// ─────────────────────────────────────────────────────────────────────────────

export function Runs({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.runs());
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="contenu">
      <p className="faible" style={{ marginTop: 0 }}>
        Statut, actions, outils, progression, résultat, erreurs et métriques. Le raisonnement du
        modèle n&apos;est pas exposé — le serveur ne le transmet pas.
      </p>

      <Section state={state}>
        {(data) =>
          data.runs.length === 0 ? (
            <Empty>Aucun run enregistré.</Empty>
          ) : (
            <>
              <Table head={["Run", "Statut", "Arrêt", "Itérations", "Outils", "Durée", "Jetons"]}>
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
                    <td className="faible">{run.stopReason ?? "—"}</td>
                    <td>{run.iterations}</td>
                    <td>
                      {run.metrics.toolCalls}
                      {run.metrics.failedToolCalls > 0 ? (
                        <span style={{ color: "var(--hs)" }}>
                          {" "}
                          ({run.metrics.failedToolCalls} en échec)
                        </span>
                      ) : null}
                    </td>
                    <td className="faible">{formatDuration(run.durationMs)}</td>
                    <td className="faible">
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
                    <h3>Actions</h3>
                    {run.tools.length === 0 ? (
                      <Empty>Aucun outil appelé.</Empty>
                    ) : (
                      <Table
                        head={[
                          "Outil",
                          "Action",
                          "Statut",
                          "Risque",
                          "Durée",
                          "Tentatives",
                          "Erreur",
                        ]}
                      >
                        {run.tools.map((tool) => (
                          <tr key={tool.callId}>
                            <td className="mono">{tool.tool}</td>
                            <td className="mono faible">{tool.action}</td>
                            <td>
                              <State
                                tone={tool.status === "success" ? "ok" : "down"}
                                label={tool.status}
                              />
                            </td>
                            <td className="faible">{tool.riskLevel}</td>
                            <td className="faible">{formatDuration(tool.durationMs)}</td>
                            <td className="faible">{tool.attempts}</td>
                            <td className="faible">{tool.errorCode ?? "—"}</td>
                          </tr>
                        ))}
                      </Table>
                    )}

                    <h3>Résultat</h3>
                    <p>{run.response ?? <span className="faible">Aucune réponse finale.</span>}</p>

                    {run.errors.length === 0 ? null : (
                      <>
                        <h3>Erreurs</h3>
                        <Table head={["Quand", "Itération", "Code", "Message"]}>
                          {run.errors.map((error, index) => (
                            <tr key={`${error.at}-${String(index)}`}>
                              <td className="faible">{formatAge(error.at)}</td>
                              <td>{error.iteration}</td>
                              <td className="mono">{error.code}</td>
                              <td>{error.message}</td>
                            </tr>
                          ))}
                        </Table>
                      </>
                    )}

                    <h3>Métriques</h3>
                    <div className="mesures">
                      <Metric value={run.metrics.model} label="modèle" />
                      <Metric
                        value={formatCount(run.metrics.inputTokens)}
                        label="jetons en entrée"
                      />
                      <Metric
                        value={formatCount(run.metrics.outputTokens)}
                        label="jetons en sortie"
                      />
                      <Metric value={formatCount(run.metrics.cacheReadTokens)} label="cache lu" />
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

// ─────────────────────────────────────────────────────────────────────────────
// 6. Outils
// ─────────────────────────────────────────────────────────────────────────────

export function Tools({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.tools());

  return (
    <div className="contenu">
      <Section state={state}>
        {(data) =>
          data.tools.length === 0 ? (
            <Empty>
              Aucun outil enregistré. Le catalogue se remplit quand le service agent démarre.
            </Empty>
          ) : (
            <Table head={["Outil", "Source", "Description", "Risque", "Permissions", "Autorisé"]}>
              {data.tools.map((tool) => (
                <tr key={tool.name}>
                  <td className="mono">{tool.name}</td>
                  <td>{tool.source}</td>
                  <td className="faible">{tool.description}</td>
                  <td>{tool.riskLevel}</td>
                  <td className="mono faible">{tool.requiredPermissions.join(", ") || "—"}</td>
                  <td>
                    <State
                      tone={tool.allowed ? "ok" : "degraded"}
                      label={tool.allowed ? "oui" : "non"}
                    />
                  </td>
                </tr>
              ))}
            </Table>
          )
        }
      </Section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. MCP
// ─────────────────────────────────────────────────────────────────────────────

export function Mcp({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.mcp());
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("stdio");
  const [target, setTarget] = useState("");
  const [args, setArgs] = useState("");
  const [secretRefs, setSecretRefs] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = (operation: () => Promise<unknown>, success: string): void => {
    setActionError(null);
    setMessage(null);
    void operation()
      .then(() => {
        setMessage(success);
        state.reload();
      })
      .catch((cause: unknown) =>
        setActionError(cause instanceof Error ? cause.message : "Action impossible."),
      );
  };

  const save = (): void => {
    let refs: Record<string, string>;
    try {
      refs = secretRefs.trim() === "" ? {} : (JSON.parse(secretRefs) as Record<string, string>);
    } catch {
      setActionError("Les références de secrets doivent être un objet JSON.");
      return;
    }
    const common = {
      name,
      enabled: true,
      defaultPermissions: [],
      defaultRisk: "MEDIUM" as const,
      toolPolicies: {},
      connectTimeoutMs: 15_000,
      requestTimeoutMs: 60_000,
      autoReconnect: true,
      maxReconnectAttempts: 5,
      reconnectInitialDelayMs: 500,
      reconnectMaxDelayMs: 30_000,
      circuitBreakerThreshold: 5,
      circuitBreakerResetMs: 60_000,
      exposeResources: true,
    };
    const config: McpConfiguration =
      transport === "stdio"
        ? {
            ...common,
            transport,
            command: target,
            args: args
              .split("\n")
              .map((item) => item.trim())
              .filter(Boolean),
            env: {},
            envRefs: refs,
          }
        : { ...common, transport, url: target, headers: {}, headerRefs: refs };
    act(() => api.saveMcp(config), `Serveur ${name} enregistré et connecté.`);
  };

  return (
    <div className="contenu">
      {message === null ? null : <p className="banniere succes">{message}</p>}
      {actionError === null ? null : <p className="banniere erreur">{actionError}</p>}
      <section className="settings-panel">
        <h3>Ajouter ou remplacer un serveur MCP</h3>
        <div className="settings-grid">
          <label>
            Nom
            <input
              className="champ mono"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="filesystem"
            />
          </label>
          <label>
            Transport
            <select
              className="champ"
              value={transport}
              onChange={(event) => setTransport(event.target.value as "stdio" | "http" | "sse")}
            >
              <option value="stdio">stdio</option>
              <option value="http">HTTP</option>
              <option value="sse">SSE</option>
            </select>
          </label>
          <label className="settings-wide">
            {transport === "stdio" ? "Commande" : "URL"}
            <input
              className="champ mono"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={transport === "stdio" ? "npx" : "https://…"}
            />
          </label>
          {transport === "stdio" ? (
            <label className="settings-wide">
              Arguments · un par ligne
              <textarea
                className="champ mono"
                rows={3}
                value={args}
                onChange={(event) => setArgs(event.target.value)}
              />
            </label>
          ) : null}
          <label className="settings-wide">
            {transport === "stdio" ? "envRefs" : "headerRefs"} · JSON vers vault://nexus/…
            <textarea
              className="champ mono"
              rows={3}
              value={secretRefs}
              onChange={(event) => setSecretRefs(event.target.value)}
              placeholder={'{"TOKEN":"vault://nexus/mcp-token"}'}
            />
          </label>
        </div>
        <div className="settings-actions">
          <button
            className="bouton primary"
            type="button"
            disabled={name === "" || target === ""}
            onClick={save}
          >
            Enregistrer et connecter
          </button>
        </div>
      </section>
      <Section state={state}>
        {(data) =>
          data.configurations.length === 0 ? (
            // Non configuré n'est pas en panne. Le dire évite d'envoyer chercher
            // un incident qui n'existe pas.
            <Empty>Aucun serveur MCP configuré.</Empty>
          ) : (
            <Table
              head={[
                "Serveur",
                "État",
                "Outils",
                "Échecs",
                "Reconnexions",
                "Circuit",
                "Dernière erreur",
                "Actions",
              ]}
            >
              {data.servers.map((server) => (
                <tr key={server.name}>
                  <td>
                    {server.name}
                    {server.serverInfo === null ? null : (
                      <div className="faible mono">
                        {server.serverInfo.name} {server.serverInfo.version}
                      </div>
                    )}
                  </td>
                  <td>
                    <State
                      tone={server.status === "connected" ? "ok" : "down"}
                      label={server.status}
                    />
                  </td>
                  <td>{server.toolCount}</td>
                  <td>{server.consecutiveFailures}</td>
                  <td>{server.reconnectAttempts}</td>
                  <td className="faible">
                    {server.circuitOpenUntil === null
                      ? "fermé"
                      : `ouvert jusqu'à ${server.circuitOpenUntil}`}
                  </td>
                  <td className="faible">{server.lastError ?? "—"}</td>
                  <td>
                    <button
                      className="bouton compact"
                      type="button"
                      onClick={() =>
                        act(() => api.reconnectMcp(server.name), `${server.name} reconnecté.`)
                      }
                    >
                      Reconnecter
                    </button>{" "}
                    <button
                      className="bouton compact danger"
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Supprimer le serveur ${server.name} ?`))
                          act(() => api.removeMcp(server.name), `${server.name} supprimé.`);
                      }}
                    >
                      Supprimer
                    </button>
                  </td>
                </tr>
              ))}
            </Table>
          )
        }
      </Section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Browser Use
// ─────────────────────────────────────────────────────────────────────────────

export function Browser({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.browser());
  const [mode, setMode] = useState<"local-harness" | "remote-worker">("local-harness");
  const [cdpUrl, setCdpUrl] = useState("http://127.0.0.1:19222");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8100");
  const [tokenRef, setTokenRef] = useState("vault://nexus/browser-worker-token");
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const configuration = state.data?.configuration;
    if (configuration === null || configuration === undefined) return;
    setMode(configuration.mode);
    if (configuration.mode === "local-harness") setCdpUrl(configuration.cdpUrl);
    else {
      setBaseUrl(configuration.baseUrl);
      setTokenRef(configuration.tokenRef);
    }
    setEnabled(configuration.enabled);
  }, [state.data]);

  const act = (operation: () => Promise<unknown>, success: string): void => {
    setActionError(null);
    setMessage(null);
    void operation()
      .then(() => {
        setMessage(success);
        state.reload();
      })
      .catch((cause: unknown) =>
        setActionError(cause instanceof Error ? cause.message : "Action impossible."),
      );
  };

  return (
    <div className="contenu">
      {message === null ? null : <p className="banniere succes">{message}</p>}
      {actionError === null ? null : <p className="banniere erreur">{actionError}</p>}
      <section className="settings-panel">
        <h3>Configurer Browser Use</h3>
        <p className="faible">
          Le mode local utilise le harness officiel avec Codex ou Claude comme cerveau. Il ne
          demande aucune clé API et conserve un profil Chromium NEXUS séparé.
        </p>
        <div className="settings-grid">
          <label className="settings-wide">
            Mode
            <select
              className="champ"
              value={mode}
              onChange={(event) => setMode(event.target.value as "local-harness" | "remote-worker")}
            >
              <option value="local-harness">Navigateur local — sans clé API</option>
              <option value="remote-worker">Worker autonome — fournisseur LLM requis</option>
            </select>
          </label>
          {mode === "local-harness" ? (
            <label className="settings-wide">
              URL CDP locale
              <input
                className="champ mono"
                value={cdpUrl}
                onChange={(event) => setCdpUrl(event.target.value)}
              />
            </label>
          ) : (
            <>
              <label className="settings-wide">
                URL du worker
                <input
                  className="champ mono"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </label>
              <label className="settings-wide">
                Référence du jeton
                <input
                  className="champ mono"
                  value={tokenRef}
                  onChange={(event) => setTokenRef(event.target.value)}
                />
              </label>
            </>
          )}
          <label className="settings-wide check-label">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Activer Browser Use
          </label>
        </div>
        <div className="settings-actions">
          <button
            className="bouton primary"
            type="button"
            onClick={() =>
              act(
                () =>
                  api.configureBrowser(
                    mode === "local-harness"
                      ? { enabled, mode, cdpUrl }
                      : { enabled, mode, baseUrl, tokenRef },
                  ),
                "Configuration navigateur enregistrée.",
              )
            }
          >
            Enregistrer
          </button>
          <button
            className="bouton"
            type="button"
            onClick={() => act(() => api.testBrowser(), "Worker navigateur joignable.")}
          >
            Tester
          </button>
        </div>
      </section>
      <Section state={state}>
        {(data) => (
          <>
            <div className="mesures">
              <Metric value={data.configured ? "oui" : "non"} label="configuré" />
              <Metric
                value={data.reachable ? "prêt" : "injoignable"}
                label="navigateur"
                alert={data.configured && !data.reachable}
              />
            </div>

            <p className="faible">{data.detail}</p>
            {data.configuration?.mode === "remote-worker" ? (
              <p className="faible">
                Secret : {data.tokenConfigured ? "présent dans le trousseau" : "absent"}
              </p>
            ) : null}

            {data.health === null ? null : (
              <>
                <h3>Santé rapportée</h3>
                <pre className="mono scroll-x" style={{ padding: 12, margin: 0 }}>
                  {JSON.stringify(data.health, null, 2)}
                </pre>
              </>
            )}
          </>
        )}
      </Section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NEXUS Mission Engine
// ─────────────────────────────────────────────────────────────────────────────

export function MissionControl({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.missionControl());
  const [accountName, setAccountName] = useState("Portefeuille NEXUS");
  const [bankroll, setBankroll] = useState("50.00");
  const [marketQuestion, setMarketQuestion] = useState("");
  const [marketClose, setMarketClose] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const act = (operation: () => Promise<unknown>): void => {
    setActionError(null);
    void operation()
      .then(() => state.reload())
      .catch((cause: unknown) =>
        setActionError(cause instanceof Error ? cause.message : "Action impossible."),
      );
  };

  return (
    <div className="contenu">
      {actionError === null ? null : <p className="banniere erreur">{actionError}</p>}
      <Section state={state}>
        {(data) => {
          const cash = data.accounts.reduce(
            (total, account) => total + account.cash_balance_cents,
            0,
          );
          const exposure = data.accounts.reduce(
            (total, account) => total + account.open_exposure_cents,
            0,
          );
          const activeRuns = data.recent_runs.filter(
            (run) => run.state === "running" || run.state === "waiting_market_data",
          ).length;

          return (
            <>
              <div className="mesures">
                <Metric value={data.configured ? "oui" : "non"} label="configuré" />
                <Metric
                  value={data.reachable ? "joignable" : "injoignable"}
                  label="moteur ACP"
                  alert={data.configured && !data.reachable}
                />
                <Metric
                  value={data.health?.worker_enabled === true ? "actifs" : "arrêtés"}
                  label="workers"
                  alert={data.configured && data.health?.worker_enabled !== true}
                />
                <Metric value={String(data.health?.worker_concurrency ?? 0)} label="concurrence" />
                <Metric
                  value={data.audit?.valid === true ? "valide" : "invalide"}
                  label="chaîne d'audit"
                  alert={data.configured && data.audit?.valid !== true}
                />
                <Metric value={formatCount(data.audit?.checked ?? 0)} label="événements audités" />
                <Metric value={`${(cash / 100).toFixed(2)} €`} label="cash fictif" />
                <Metric value={`${(exposure / 100).toFixed(2)} €`} label="exposition fictive" />
                <Metric value={formatCount(activeRuns)} label="missions actives" />
              </div>

              <p className="faible">{data.detail}</p>

              <h3>NEXUS · profils ACP</h3>
              <p className="mono faible">
                {data.health === null || data.health.profiles.length === 0
                  ? "aucun"
                  : data.health.profiles.join(", ")}
              </p>

              <h3>Chronologie unifiée des missions</h3>
              {data.missions.length === 0 ? (
                <Empty>Aucune mission ACP NEXUS pour ce compte.</Empty>
              ) : (
                <div className="stack">
                  {data.missions.map((mission) => (
                    <details className="card" key={mission.id}>
                      <summary>
                        <State
                          tone={
                            mission.state === "succeeded"
                              ? "ok"
                              : mission.state === "failed"
                                ? "down"
                                : "info"
                          }
                          label={mission.state}
                        />{" "}
                        {mission.title} · {mission.tasks.length} étape(s) ·{" "}
                        {formatAge(mission.created_at)}
                      </summary>
                      <Table
                        head={["Étape", "Agent", "État", "Dépendances", "Tentatives", "Durée"]}
                      >
                        {mission.tasks.map((task) => {
                          const first = task.attempts[0];
                          const last = task.attempts.at(-1);
                          return (
                            <tr key={task.id}>
                              <td className="mono">{task.task_key}</td>
                              <td>{task.profile_key}</td>
                              <td>
                                <State
                                  tone={
                                    task.state === "succeeded"
                                      ? "ok"
                                      : task.state === "failed"
                                        ? "down"
                                        : task.state === "retry_wait"
                                          ? "degraded"
                                          : "info"
                                  }
                                  label={task.state}
                                />
                              </td>
                              <td className="faible">
                                {task.depends_on.length === 0 ? "—" : task.depends_on.join(", ")}
                              </td>
                              <td>{task.attempts.length}</td>
                              <td className="faible">
                                {first === undefined
                                  ? "—"
                                  : formatDuration(
                                      new Date(
                                        last?.finished_at ?? last?.updated_at ?? first.started_at,
                                      ).getTime() - new Date(first.started_at).getTime(),
                                    )}
                              </td>
                            </tr>
                          );
                        })}
                      </Table>
                      <MissionCollaborationPanel api={api} missionId={mission.id} />
                    </details>
                  ))}
                </div>
              )}

              <h3>Portefeuilles fictifs</h3>
              <div className="inline-admin-form">
                <input
                  className="champ"
                  value={accountName}
                  onChange={(event) => setAccountName(event.target.value)}
                  placeholder="Nom du portefeuille"
                />
                <input
                  className="champ"
                  value={bankroll}
                  onChange={(event) => setBankroll(event.target.value)}
                  inputMode="decimal"
                  placeholder="Capital EUR"
                />
                <button
                  className="bouton"
                  type="button"
                  onClick={() =>
                    act(() =>
                      api.createPaperAccount({ name: accountName.trim(), bankroll_eur: bankroll }),
                    )
                  }
                >
                  Créer
                </button>
              </div>
              {data.accounts.length === 0 ? (
                <Empty>Aucun portefeuille de recherche.</Empty>
              ) : (
                <Table head={["Nom", "Cash", "Exposition", "P&L réalisé", "Mode"]}>
                  {data.accounts.map((account) => (
                    <tr key={account.id}>
                      <td>{account.name}</td>
                      <td>{(account.cash_balance_cents / 100).toFixed(2)} €</td>
                      <td>{(account.open_exposure_cents / 100).toFixed(2)} €</td>
                      <td>{(account.realized_pnl_cents / 100).toFixed(2)} €</td>
                      <td>
                        <State tone="ok" label="paper-only" />
                      </td>
                    </tr>
                  ))}
                </Table>
              )}

              <h3>Missions récentes</h3>
              {data.recent_runs.length === 0 ? (
                <Empty>Aucune mission ACP exécutée.</Empty>
              ) : (
                <Table head={["Créée", "État", "Mission", "Erreur"]}>
                  {data.recent_runs.map((run) => (
                    <tr key={run.id}>
                      <td className="faible">{formatAge(run.created_at)}</td>
                      <td>
                        <State
                          tone={
                            run.state === "executed"
                              ? "ok"
                              : run.state === "failed"
                                ? "down"
                                : run.state === "abstained"
                                  ? "degraded"
                                  : "info"
                          }
                          label={run.state}
                        />
                      </td>
                      <td className="mono faible">{run.mission_id.slice(0, 8)}</td>
                      <td className="faible">{run.error_code ?? "—"}</td>
                    </tr>
                  ))}
                </Table>
              )}

              <h3>Marché de recherche fictif</h3>
              <div className="inline-admin-form market-form">
                <input
                  className="champ"
                  value={marketQuestion}
                  onChange={(event) => setMarketQuestion(event.target.value)}
                  placeholder="Question du marché"
                />
                <input
                  className="champ"
                  type="datetime-local"
                  value={marketClose}
                  onChange={(event) => setMarketClose(event.target.value)}
                />
                <button
                  className="bouton"
                  type="button"
                  disabled={marketQuestion.trim().length === 0 || marketClose.length === 0}
                  onClick={() => {
                    act(() =>
                      api.createPaperMarket({
                        question: marketQuestion.trim(),
                        close_at: new Date(marketClose).toISOString(),
                      }),
                    );
                    setMarketQuestion("");
                  }}
                >
                  Créer
                </button>
              </div>

              <p className="faible">
                La création des missions et des portefeuilles fictifs passe par l’API administrateur
                NEXUS. Aucun chemin de trading réel n’est exposé.
              </p>
            </>
          );
        }}
      </Section>
    </div>
  );
}

function MissionCollaborationPanel({ api, missionId }: { api: DashboardApi; missionId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [collab, setCollab] = useState<MissionCollaborationDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (): Promise<void> => {
    if (!open && collab === null) {
      setLoading(true);
      setError(null);
      try {
        const res = await api.missionCollaboration(missionId);
        setCollab(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Erreur de chargement");
      } finally {
        setLoading(false);
      }
    }
    setOpen(!open);
  };

  return (
    <div style={{ marginTop: "12px", borderTop: "1px dashed var(--border, #444)", paddingTop: "8px" }}>
      <button
        type="button"
        className="bouton"
        style={{ fontSize: "0.85rem", padding: "4px 10px" }}
        onClick={() => void toggle()}
      >
        {open ? "Masquer les artefacts et la collaboration" : "Artefacts partagés & Collaboration inter-agents"}
      </button>

      {loading ? (
        <p className="faible" style={{ marginTop: "6px" }}>
          Chargement de l'espace de collaboration…
        </p>
      ) : null}
      {error ? <p style={{ color: "var(--danger, #ff5555)", marginTop: "6px" }}>{error}</p> : null}

      {open && collab ? (
        <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "12px" }}>
          {/* Artefacts */}
          <div>
            <h4 style={{ margin: "0 0 6px 0", fontSize: "0.95rem" }}>
              Artefacts partagés ({collab.artifacts.length})
            </h4>
            {collab.artifacts.length === 0 ? (
              <p className="faible">Aucun fichier généré dans cette mission.</p>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {collab.artifacts.map((art) => (
                  <div
                    key={art.id}
                    style={{
                      background: "var(--surface, #222)",
                      border: "1px solid var(--border, #444)",
                      borderRadius: "6px",
                      padding: "8px 12px",
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                    }}
                  >
                    <div>
                      <strong>{art.name}</strong>
                      <div className="faible" style={{ fontSize: "0.75rem" }}>
                        {(art.sizeBytes / 1024).toFixed(1)} KB · {art.mimeType} · {art.taskKey}
                      </div>
                    </div>
                    <a
                      href={api.artifactDownloadUrl(missionId, art.uri)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bouton primary"
                      style={{ fontSize: "0.75rem", padding: "2px 8px" }}
                    >
                      Ouvrir
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Débats contradictoires */}
          {collab.debates.length > 0 ? (
            <div
              style={{
                background: "rgba(255, 165, 0, 0.1)",
                border: "1px solid orange",
                borderRadius: "6px",
                padding: "10px",
              }}
            >
              <h4 style={{ margin: "0 0 6px 0", color: "orange", fontSize: "0.95rem" }}>
                Débat contradictoire détecté
              </h4>
              {collab.debates.map((d) => (
                <div key={d.id} style={{ fontSize: "0.85rem" }}>
                  <p>
                    <strong>{d.issue}</strong>
                  </p>
                  <p className="faible">{d.recommendation}</p>
                </div>
              ))}
            </div>
          ) : null}

          {/* Sous-tâches proposées */}
          {collab.proposedSubtasks.length > 0 ? (
            <div>
              <h4 style={{ margin: "0 0 6px 0", fontSize: "0.95rem" }}>
                Sous-tâches dynamiques proposées ({collab.proposedSubtasks.length})
              </h4>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {collab.proposedSubtasks.map((st) => (
                  <div
                    key={st.key}
                    style={{
                      background: "var(--surface, #222)",
                      border: "1px solid var(--border, #444)",
                      borderRadius: "6px",
                      padding: "6px 10px",
                      fontSize: "0.85rem",
                    }}
                  >
                    <strong>{st.title}</strong> ({st.key}) · <span className="badge">{st.priority}</span>
                    <div className="faible">{st.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Mémoire
// ─────────────────────────────────────────────────────────────────────────────

export function Memory({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.memory());
  const [content, setContent] = useState("");
  const [layer, setLayer] = useState<"LONG_TERM" | "PREFERENCE">("LONG_TERM");
  const [tags, setTags] = useState("");
  const [acknowledgedSensitive, setAcknowledgedSensitive] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <div className="contenu">
      <div className="admin-form-card">
        <h3>Ajouter un souvenir</h3>
        <div className="inline-admin-form memory-form">
          <input
            className="champ"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Ce que NEXUS doit retenir"
          />
          <select
            className="champ"
            value={layer}
            onChange={(event) => setLayer(event.target.value as "LONG_TERM" | "PREFERENCE")}
          >
            <option value="LONG_TERM">Long terme</option>
            <option value="PREFERENCE">Préférence</option>
          </select>
          <input
            className="champ"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="tags, séparés, par virgule"
          />
          <label className="check-label">
            <input
              type="checkbox"
              checked={acknowledgedSensitive}
              onChange={(event) => setAcknowledgedSensitive(event.target.checked)}
            />
            contenu sensible vérifié
          </label>
          <button
            className="bouton primary"
            type="button"
            disabled={content.trim().length === 0}
            onClick={() => {
              setActionError(null);
              void api
                .remember({
                  content: content.trim(),
                  layer,
                  tags: tags
                    .split(",")
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                  acknowledgedSensitive,
                })
                .then(() => {
                  setContent("");
                  setTags("");
                  state.reload();
                })
                .catch((cause: unknown) =>
                  setActionError(
                    cause instanceof Error ? cause.message : "Enregistrement impossible.",
                  ),
                );
            }}
          >
            Mémoriser
          </button>
        </div>
      </div>
      {actionError === null ? null : <p className="banniere erreur">{actionError}</p>}
      <Section state={state}>
        {(data) => (
          <>
            <div className="mesures">
              <Metric value={formatCount(data.total)} label="souvenirs" />
              <Metric value={formatCount(data.byLayer.PREFERENCE ?? 0)} label="préférences" />
              <Metric value={formatCount(data.byOrigin.AGENT ?? 0)} label="déduits par l'agent" />
              <Metric
                value={formatCount(data.bySensitivity.PERSONAL ?? 0)}
                label="marqués personnels"
              />
            </div>

            <h3>Souvenirs récents</h3>
            {data.recent.length === 0 ? (
              <Empty>NEXUS ne retient rien.</Empty>
            ) : (
              <Table head={["Contenu", "Couche", "Origine", "Créé", "Actions"]}>
                {data.recent.map((record) => (
                  <tr key={record.id}>
                    <td>{record.content}</td>
                    <td className="faible">{record.layer}</td>
                    <td className="faible">{record.origin}</td>
                    <td className="faible">{formatAge(record.createdAt)}</td>
                    <td>
                      <button
                        className="bouton danger"
                        type="button"
                        onClick={() => {
                          if (!window.confirm("Oublier définitivement ce souvenir ?")) return;
                          void api
                            .forget(record.id)
                            .then(() => state.reload())
                            .catch((cause: unknown) =>
                              setActionError(
                                cause instanceof Error ? cause.message : "Suppression impossible.",
                              ),
                            );
                        }}
                      >
                        Oublier
                      </button>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )}
      </Section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Notifications
// ─────────────────────────────────────────────────────────────────────────────

export function Notifications({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.notifications());
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { report } = await api.testNotification();
      const summary = report.channels
        .map(
          (c) =>
            `${c.channel}: ${c.success ? "✓ succès" : c.skippedReason ? `(ignoré: ${c.skippedReason})` : `✗ erreur (${c.error ?? ""})`}`,
        )
        .join(" | ");
      setTestResult(`Rapport : ${summary}`);
    } catch (err) {
      setTestResult(`Échec du test : ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="contenu">
      <div className="agents-heading">
        <div>
          <h2>Notifications</h2>
          <p className="faible">
            Journal central et diffusion vers les canaux externes (desktop, mobile push ntfy, webhooks).
          </p>
        </div>
        <button
          className="bouton"
          type="button"
          disabled={testing}
          onClick={() => void handleTest()}
        >
          {testing ? "Test en cours..." : "Tester canaux externes"}
        </button>
      </div>

      {testResult !== null ? (
        <p className="banniere succes" style={{ marginBottom: "1rem" }}>
          {testResult}
        </p>
      ) : null}

      <Section state={state}>
        {(data) => (
          <>
            <div className="mesures">
              <Metric value={formatCount(data.unread)} label="non lues" />
              <Metric value={formatCount(data.notifications.length)} label="retenues" />
            </div>

            {data.notifications.length === 0 ? (
              <Empty>Aucune notification.</Empty>
            ) : (
              <Table head={["Quand", "Gravité", "Titre", "Corps", "Lue", "Actions"]}>
                {data.notifications.map((notification) => (
                  <tr key={notification.id}>
                    <td className="faible">{formatAge(notification.createdAt)}</td>
                    <td>
                      <State
                        tone={
                          notification.severity === "error"
                            ? "down"
                            : notification.severity === "warning"
                              ? "degraded"
                              : "ok"
                        }
                        label={notification.severity}
                      />
                    </td>
                    <td>{notification.title}</td>
                    <td className="faible">{notification.body}</td>
                    <td className="faible">{notification.readAt === null ? "non" : "oui"}</td>
                    <td>
                      {notification.readAt === null ? (
                        <button
                          className="bouton"
                          type="button"
                          onClick={() =>
                            void api
                              .markNotificationRead(notification.id)
                              .then(() => state.reload())
                          }
                        >
                          Marquer lue
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )}
      </Section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Sécurité
// ─────────────────────────────────────────────────────────────────────────────

export function Security({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.security());

  return (
    <div className="contenu">
      <Section state={state}>
        {(data) => (
          <>
            <div className="mesures">
              <Metric value={formatCount(data.trust.trusted)} label="appareils approuvés" />
              <Metric
                value={formatCount(data.trust.pending)}
                label="en attente d'approbation"
                alert={data.trust.pending > 0}
              />
              <Metric value={formatCount(data.trust.revoked)} label="révoqués" />
              <Metric
                value={formatCount(data.byKind["auth.login_failed"] ?? 0)}
                label="connexions refusées"
                alert={(data.byKind["auth.login_failed"] ?? 0) > 0}
              />
              <Metric
                value={formatCount(data.byKind["memory.refused"] ?? 0)}
                label="mémorisations refusées"
              />
            </div>

            <h3>Permissions effectives</h3>
            <p className="mono faible">
              {data.permissions.length === 0 ? "aucune" : data.permissions.join(", ")}
            </p>

            <h3>Événements</h3>
            {data.events.length === 0 ? (
              <Empty>Aucun événement de sécurité.</Empty>
            ) : (
              <Table head={["Quand", "Type", "Résumé"]}>
                {data.events.map((event, index) => (
                  <tr key={`${event.at}-${String(index)}`}>
                    <td className="faible">{formatAge(event.at)}</td>
                    <td className="mono">{event.kind}</td>
                    <td>{event.summary}</td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )}
      </Section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Journaux
// ─────────────────────────────────────────────────────────────────────────────

export function Logs({ api }: { api: DashboardApi }) {
  const [level, setLevel] = useState<string>("");
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState<{ level?: string; search?: string }>({});

  const state = useSection(() => api.logs(applied));

  return (
    <div className="contenu">
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <select
          className="champ"
          value={level}
          onChange={(event) => {
            setLevel(event.target.value);
          }}
        >
          <option value="">tous les niveaux</option>
          <option value="info">info et au-dessus</option>
          <option value="warn">avertissements</option>
          <option value="error">erreurs</option>
        </select>

        <input
          className="champ"
          style={{ flex: 1 }}
          value={search}
          placeholder="Rechercher dans les messages…"
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />

        <button
          type="button"
          className="bouton"
          onClick={() => {
            setApplied({
              ...(level === "" ? {} : { level }),
              ...(search === "" ? {} : { search }),
            });
            state.reload();
          }}
        >
          Filtrer
        </button>
      </div>

      <Section state={state}>
        {(data) =>
          data.entries.length === 0 ? (
            <Empty>Aucune ligne retenue.</Empty>
          ) : (
            <Table head={["Quand", "Niveau", "Message", "Corrélation"]}>
              {data.entries.map((entry, index) => (
                <tr key={`${entry.at}-${String(index)}`}>
                  <td className="faible mono">{entry.at.slice(11, 23)}</td>
                  <td>
                    <State
                      tone={
                        entry.level === "error" || entry.level === "fatal"
                          ? "down"
                          : entry.level === "warn"
                            ? "degraded"
                            : "ok"
                      }
                      label={entry.level}
                    />
                  </td>
                  <td>{entry.message}</td>
                  <td className="faible mono">{entry.correlationId ?? "—"}</td>
                </tr>
              ))}
            </Table>
          )
        }
      </Section>
    </div>
  );
}
