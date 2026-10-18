import { useState } from "react";
import type { DashboardApi, TaskDetail } from "../lib/api.js";
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
 * Aucune ne propose d'action. Approuver un appareil, révoquer, annuler une tâche
 * restent sur les surfaces qui portent leurs propres contrôles — mettre une
 * action destructrice dans un écran qu'on consulte machinalement est une
 * mauvaise idée qui ne se remarque qu'une fois.
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

  return (
    <div className="contenu">
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

  return (
    <div className="contenu">
      <Section state={state}>
        {(data) =>
          data.tasks.length === 0 ? (
            <Empty>Aucune tâche.</Empty>
          ) : (
            <>
              <Table head={["Tâche", "Statut", "Progression", "Origine", "Créée", "Durée"]}>
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
                      <div className="faible mono">{task.correlationId}</div>
                    </td>
                    <td>
                      <State tone={taskTone(task.status)} label={task.status} />
                    </td>
                    <td>
                      <Bar percent={task.progressPercent} />
                    </td>
                    <td className="faible mono">{task.originClientDeviceId.slice(0, 8)}</td>
                    <td className="faible">{formatAge(task.createdAt)}</td>
                    <td className="faible">
                      {formatDuration(
                        task.startedAt === null || task.completedAt === null
                          ? null
                          : new Date(task.completedAt).getTime() -
                              new Date(task.startedAt).getTime(),
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
            <Table head={["Outil", "Description", "Risque", "Permissions", "Autorisé"]}>
              {data.tools.map((tool) => (
                <tr key={tool.name}>
                  <td className="mono">{tool.name}</td>
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

  return (
    <div className="contenu">
      <Section state={state}>
        {(data) =>
          !data.configured ? (
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

  return (
    <div className="contenu">
      <Section state={state}>
        {(data) => (
          <>
            <div className="mesures">
              <Metric value={data.configured ? "oui" : "non"} label="configuré" />
              <Metric
                value={data.reachable ? "joignable" : "injoignable"}
                label="worker navigateur"
                alert={data.configured && !data.reachable}
              />
            </div>

            <p className="faible">{data.detail}</p>

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

  return (
    <div className="contenu">
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

              <h3>Portefeuilles fictifs</h3>
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

// ─────────────────────────────────────────────────────────────────────────────
// 9. Mémoire
// ─────────────────────────────────────────────────────────────────────────────

export function Memory({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.memory());

  return (
    <div className="contenu">
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
              <Table head={["Contenu", "Couche", "Origine", "Créé"]}>
                {data.recent.map((record) => (
                  <tr key={record.id}>
                    <td>{record.content}</td>
                    <td className="faible">{record.layer}</td>
                    <td className="faible">{record.origin}</td>
                    <td className="faible">{formatAge(record.createdAt)}</td>
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

  return (
    <div className="contenu">
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
              <Table head={["Quand", "Gravité", "Titre", "Corps", "Lue"]}>
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
