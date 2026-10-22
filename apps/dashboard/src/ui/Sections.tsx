import { useEffect, useState } from "react";
import { generateQrSvg } from "@nexus/client-core";
import type {
  DashboardApi,
  ExternalNotificationConfigDto,
  McpConfiguration,
  MissionCollaborationDto,
  PairingTicket,
  ScheduleRun,
  TaskDetail,
} from "../lib/api.js";
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
 * Supervision sections.
 *
 * Each loads its own data: a failure in one section does not take down the others,
 * and an unreachable MCP server must not clear the workers screen.
 *
 * Admin actions reuse existing business routes. Irreversible operations remain
 * explicitly confirmed; no section bypasses core permissions or validations.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Overview
// ─────────────────────────────────────────────────────────────────────────────

export function Overview({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.overview());

  return (
    <div className="content">
      <Section state={state}>
        {(data) => (
          <>
            <div className="metrics">
              <Metric value={formatCount(data.devices.online)} label="online devices" />
              <Metric value={formatCount(data.workers.connected)} label="connected workers" />
              <Metric value={formatCount(data.tasks.running)} label="running tasks" />
              <Metric
                value={formatCount(data.tasks.failed)}
                label="failed tasks"
                alert={data.tasks.failed > 0}
              />
              <Metric value={formatCount(data.agentRuns.running)} label="active agent runs" />
              <Metric
                value={formatCount(data.agentRuns.waitingForConfirmation)}
                label="pending confirmation"
                alert={data.agentRuns.waitingForConfirmation > 0}
              />
              <Metric value={formatCount(data.notifications.unread)} label="unread alerts" />
              <Metric
                value={HEALTH_LABELS[levelOf(overallHealth(data.health))]}
                label="overall health"
                alert={overallHealth(data.health) === "down"}
              />
            </div>

            <h3>Subsystem Health</h3>
            <Table head={["Subsystem", "State", "Detail"]}>
              {data.health.map((entry) => (
                <tr key={entry.name}>
                  <td>{entry.name}</td>
                  <td>
                    <State tone={entry.level} label={HEALTH_LABELS[entry.level]} />
                  </td>
                  <td className="muted">{entry.detail}</td>
                </tr>
              ))}
            </Table>

            <h3>Recent Activity</h3>
            {data.recentActivity.length === 0 ? (
              <Empty>Nothing to report.</Empty>
            ) : (
              <Table head={["When", "Source", "Event"]}>
                {sortActivity(data.recentActivity).map((entry, index) => (
                  <tr key={`${entry.at}-${String(index)}`}>
                    <td className="muted">{formatAge(entry.at)}</td>
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

/** Overall health borrows subsystem terminology for its label. */
function levelOf(overall: ReturnType<typeof overallHealth>): keyof typeof HEALTH_LABELS {
  return overall === "unknown" ? "unconfigured" : overall;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Devices
// ─────────────────────────────────────────────────────────────────────────────

export function Devices({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.devices());
  const [actionError, setActionError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingTicket | null>(null);
  const [pairingLabel, setPairingLabel] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [editingCapabilitiesDeviceId, setEditingCapabilitiesDeviceId] = useState<string | null>(null);
  const [editingCapabilities, setEditingCapabilities] = useState<Array<{ name: string; enabled: boolean }>>([]);

  useEffect(() => {
    if (pairing === null) return;
    const remaining = Math.max(0, new Date(pairing.expiresAt).getTime() - Date.now());
    const timer = window.setTimeout(() => setPairing(null), remaining);
    return () => window.clearTimeout(timer);
  }, [pairing]);

  const issuePairing = (): void => {
    setActionError(null);
    setPairingBusy(true);
    void api
      .createPairingTicket(pairingLabel)
      .then(setPairing)
      .catch((cause: unknown) =>
        setActionError(cause instanceof Error ? cause.message : "Pairing failed."),
      )
      .finally(() => setPairingBusy(false));
  };

  const windowsCommand = (() => {
    if (pairing === null) return null;
    const payload = new URL(pairing.payload);
    const apiUrl = payload.searchParams.get("api") ?? "https://your-nexus-server";
    return `powershell -Command "'${pairing.token}' | & 'C:\\Program Files\\NEXUS\\worker\\setup-worker.ps1' -NexusUrl '${apiUrl}' -TokenStdin"`;
  })();
  const linuxCommand = (() => {
    if (pairing === null) return null;
    const payload = new URL(pairing.payload);
    const apiUrl = payload.searchParams.get("api") ?? "https://your-nexus-server";
    return `curl -fLO https://github.com/adlanehzx/Nexus/releases/latest/download/install-worker.sh && chmod +x install-worker.sh && printf '%s' '${pairing.token}' | ./install-worker.sh '${apiUrl}' '$HOME/NEXUS'`;
  })();

  const qrSvg = (() => {
    if (pairing === null) return null;
    try {
      return generateQrSvg(pairing.payload);
    } catch {
      return null;
    }
  })();

  const act = (operation: () => Promise<unknown>): void => {
    setActionError(null);
    void operation()
      .then(() => state.reload())
      .catch((cause: unknown) =>
        setActionError(cause instanceof Error ? cause.message : "Action failed."),
      );
  };

  return (
    <div className="content">
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <section className="card pairing-card" aria-labelledby="pairing-title">
        <div className="pairing-heading">
          <div>
            <span className="eyebrow">NEW WORKER</span>
            <h3 id="pairing-title">Add machine</h3>
            <p className="muted">
              The code expires after five minutes and can only be used once. The machine will remain
              pending until approved below.
            </p>
          </div>
          <div className="pairing-create">
            <label htmlFor="pairing-label">Expected name</label>
            <input
              id="pairing-label"
              className="field"
              value={pairingLabel}
              placeholder="Office PC"
              onChange={(event) => setPairingLabel(event.target.value)}
            />
            <button
              className="button primary"
              type="button"
              disabled={pairingBusy}
              onClick={issuePairing}
            >
              {pairingBusy ? "Creating…" : "Generate code"}
            </button>
          </div>
        </div>
        {pairing === null || windowsCommand === null || linuxCommand === null ? (
          <div className="pairing-platforms">
            <div>
              <strong>Windows</strong>
              <span>Installer + automatic service</span>
            </div>
            <div>
              <strong>Android worker</strong>
              <span>NEXUS APK then pairing link</span>
            </div>
            <div>
              <strong>iOS client</strong>
              <span>NEXUS app then connection</span>
            </div>
            <div>
              <strong>Linux / NAS / Raspberry Pi</strong>
              <span>Isolated Docker image, amd64 and arm64</span>
            </div>
          </div>
        ) : (
          <div className="pairing-ticket" role="status">
            {qrSvg !== null ? (
              <div
                className="pairing-qr-wrapper"
                style={{
                  display: "inline-flex",
                  flexDirection: "column",
                  alignItems: "center",
                  padding: "16px",
                  background: "#ffffff",
                  borderRadius: "8px",
                  marginBottom: "16px",
                }}
              >
                <div
                  aria-label="Pairing QR Code"
                  dangerouslySetInnerHTML={{ __html: qrSvg }}
                />
                <span style={{ fontSize: "0.8rem", color: "#111", marginTop: "8px", fontWeight: 500 }}>
                  Scan with NEXUS mobile app
                </span>
              </div>
            ) : null}
            <strong>Windows (run in Administrator PowerShell — secret piped via stdin):</strong>
            <code>{windowsCommand}</code>
            <strong>Linux / Docker (secret piped via stdin):</strong>
            <code>{linuxCommand}</code>
            <div className="table-actions">
              <button
                className="button"
                type="button"
                onClick={() => void navigator.clipboard.writeText(windowsCommand)}
              >
                Copy Windows command
              </button>
              <button
                className="button"
                type="button"
                onClick={() => void navigator.clipboard.writeText(pairing.payload)}
              >
                Copy pairing link
              </button>
              <button
                className="button"
                type="button"
                onClick={() => void navigator.clipboard.writeText(linuxCommand)}
              >
                Copy Linux command
              </button>
              <button className="button" type="button" onClick={() => setPairing(null)}>
                Hide code
              </button>
            </div>
            <div className="callout info" style={{ marginTop: "12px", fontSize: "0.85rem", opacity: 0.9 }}>
              <strong>Optional Remote Connectivity (Tailscale):</strong> If your workers reside on a remote network or behind NAT, set your NEXUS <code>PUBLIC_API_URL</code> to its Tailscale IP or MagicDNS hostname (e.g. <code>http://nexus-core.example-tailnet.ts.net:3000</code>). Do not expose private tailnet keys or credentials.
            </div>
            <small style={{ display: "block", marginTop: "8px" }}>
              Expires at {new Date(pairing.expiresAt).toLocaleTimeString()}. Single-use ticket.
            </small>
          </div>
        )}
      </section>
      <Section state={state}>
        {(data) =>
          data.devices.length === 0 ? (
            <Empty>No paired devices.</Empty>
          ) : (
            <Table
              head={[
                "Device",
                "Role",
                "Platform",
                "Status",
                "Trust",
                "Capabilities",
                "Last Heartbeat",
                "Health",
                "Permissions",
                "Actions",
              ]}
            >
              {data.devices.map((device) => {
                const isProlongedOffline =
                  device.status === "OFFLINE" &&
                  (device.lastHeartbeatAt === null ||
                    Date.now() - new Date(device.lastHeartbeatAt).getTime() > 3_600_000);
                const isEditingCapabilities = editingCapabilitiesDeviceId === device.id;
                return (
                  <tr key={device.id}>
                    <td>
                      {device.name}
                      <div className="muted mono">{device.type}</div>
                    </td>
                    <td>{device.role}</td>
                    <td>{device.platform}</td>
                    <td>
                      <State
                        tone={
                          device.trust === "REVOKED"
                            ? "revoked"
                            : device.status === "ONLINE"
                              ? "ok"
                              : device.status === "DEGRADED"
                                ? "degraded"
                                : isProlongedOffline
                                  ? "down"
                                  : "degraded"
                        }
                        label={
                          device.trust === "REVOKED"
                            ? "REVOKED"
                            : isProlongedOffline
                              ? "OFFLINE (PROLONGED)"
                              : device.status
                        }
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
                      {isEditingCapabilities ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                          {editingCapabilities.map((cap, idx) => (
                            <label key={cap.name} style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.85rem" }}>
                              <input
                                type="checkbox"
                                checked={cap.enabled}
                                onChange={(e) => {
                                  const updated = [...editingCapabilities];
                                  updated[idx] = { ...cap, enabled: e.target.checked };
                                  setEditingCapabilities(updated);
                                }}
                              />
                              {cap.name}
                            </label>
                          ))}
                          <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
                            <button
                              className="button"
                              type="button"
                              onClick={() => {
                                setEditingCapabilities(editingCapabilities.map((c) => ({ ...c, enabled: false })));
                              }}
                            >
                              Pause all
                            </button>
                            <button
                              className="button primary"
                              type="button"
                              onClick={() => {
                                act(async () => {
                                  await api.updateDeviceCapabilities(device.id, editingCapabilities);
                                  setEditingCapabilitiesDeviceId(null);
                                });
                              }}
                            >
                              Save
                            </button>
                            <button
                              className="button"
                              type="button"
                              onClick={() => setEditingCapabilitiesDeviceId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          {device.capabilities.length === 0
                            ? "—"
                            : device.capabilities
                                .filter((capability) => capability.enabled)
                                .map((capability) => capability.name)
                                .join(", ") || "(all paused)"}
                        </div>
                      )}
                    </td>
                    <td className="muted">{formatAge(device.lastHeartbeatAt)}</td>
                    <td className="muted">
                      {device.health.activeTasks}/{device.health.maxConcurrentTasks} task(s)
                      {device.health.cpuLoad === null
                        ? ""
                        : ` · CPU ${String(Math.round(device.health.cpuLoad * 100))} %`}
                      {device.health.batteryPercent === null
                        ? ""
                        : ` · battery ${String(device.health.batteryPercent)} %`}
                    </td>
                    <td className="mono muted">
                      {device.grantedPermissions.length === 0
                        ? "—"
                        : device.grantedPermissions.join(", ")}
                    </td>
                    <td>
                      <div className="table-actions">
                        {device.trust === "PENDING" ? (
                          <button
                            className="button"
                            type="button"
                            onClick={() => act(() => api.trustDevice(device.id))}
                          >
                            Approve
                          </button>
                        ) : null}
                        {device.trust !== "REVOKED" ? (
                          <>
                            <button
                              className="button"
                              type="button"
                              onClick={() => {
                                if (isEditingCapabilities) {
                                  setEditingCapabilitiesDeviceId(null);
                                } else {
                                  setEditingCapabilitiesDeviceId(device.id);
                                  setEditingCapabilities([...device.capabilities]);
                                }
                              }}
                            >
                              {isEditingCapabilities ? "Close" : "Capabilities"}
                            </button>
                            <button
                              className="button"
                              type="button"
                              onClick={() => {
                                const value = window.prompt(
                                  "Comma-separated permissions",
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
                            {device.status === "ONLINE" ? (
                              <button
                                className="button"
                                type="button"
                                onClick={() => act(() => api.disconnectDevice(device.id))}
                              >
                                Disconnect
                              </button>
                            ) : null}
                            <button
                              className="button danger"
                              type="button"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Permanently revoke ${device.name}? All active sessions will terminate and credentials will be destroyed.`,
                                  )
                                )
                                  act(() => api.revokeDevice(device.id));
                              }}
                            >
                              Revoke
                            </button>
                          </>
                        ) : null}
                      </div>
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

// ─────────────────────────────────────────────────────────────────────────────
// 3. Workers
// ─────────────────────────────────────────────────────────────────────────────

export function Workers({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.workers());

  return (
    <div className="content">
      <Section state={state}>
        {(data) =>
          data.workers.length === 0 ? (
            <Empty>No paired workers.</Empty>
          ) : (
            <Table head={["Worker", "State", "Channel", "Load", "Capabilities", "Seen"]}>
              {data.workers.map((worker) => {
                const derived = workerState(worker);
                return (
                  <tr key={worker.id}>
                    <td>
                      {worker.name}
                      <div className="muted mono">{worker.role}</div>
                    </td>
                    <td>
                      <State tone={derived} label={WORKER_LABELS[derived]} />
                    </td>
                    <td className="muted">
                      {/* The declared role and open channel are two different things:
                          a paired but disconnected worker will not execute anything,
                          and showing only the role would suggest otherwise. */}
                      {worker.connected ? "open" : "closed"}
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

// ─────────────────────────────────────────────────────────────────────────────
// 4. Tasks
// ─────────────────────────────────────────────────────────────────────────────

export function Tasks({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.tasks());
  const [selected, setSelected] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <div className="content">
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <Section state={state}>
        {(data) =>
          data.tasks.length === 0 ? (
            <Empty>No tasks.</Empty>
          ) : (
            <>
              <Table
                head={["Task", "Status", "Progress", "Origin", "Created", "Duration", "Actions"]}
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
                            if (!window.confirm(`Cancel "${task.title}"?`)) return;
                            void api
                              .cancelTask(task.id)
                              .then(() => state.reload())
                              .catch((cause: unknown) =>
                                setActionError(
                                  cause instanceof Error ? cause.message : "Cancellation failed.",
                                ),
                              );
                          }}
                        >
                          Cancel
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
 * Task details.
 *
 * Execution plan, steps, assigned workers, progress, execution log, results, and errors.
 */
function TaskDetailView({ api, taskId }: { api: DashboardApi; taskId: string }) {
  const state = useSection<TaskDetail>(() => api.task(taskId));

  return (
    <Section state={state}>
      {(task) => (
        <>
          <h3>Selected Workers</h3>
          {selectedWorkers(task).length === 0 ? (
            <Empty>No workers selected — the task has not been dispatched yet.</Empty>
          ) : (
            <Table head={["Worker", "Steps"]}>
              {selectedWorkers(task).map((worker) => (
                <tr key={worker.id}>
                  <td>{worker.name}</td>
                  <td>{worker.steps}</td>
                </tr>
              ))}
            </Table>
          )}

          <h3>Steps</h3>
          <Table head={["#", "Description", "Tool", "Capabilities", "Status", "Worker", "Risk"]}>
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

          <h3>Execution Log</h3>
          {task.executions.length === 0 ? (
            <Empty>No recorded executions.</Empty>
          ) : (
            <Table head={["Step", "Worker", "Status", "Duration", "Result", "Error"]}>
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
              <h3>Errors</h3>
              <Table head={["Step", "Code", "Message"]}>
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
// 5. Agent Runs
// ─────────────────────────────────────────────────────────────────────────────

export function Runs({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.runs());
  const observability = useSection(() => api.observability());
  const [selected, setSelected] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);

  const replay = async (runId: string): Promise<void> => {
    if (
      !globalThis.confirm(
        "Create an analysis replay? Tools will be completely disabled to prevent any external effect.",
      )
    )
      return;
    setAction("Replay in progress…");
    try {
      const result = await api.replayRun(runId);
      setAction(`Replay ${result.runId.slice(0, 8)} completed: ${result.status}.`);
      state.reload();
      observability.reload();
    } catch (cause) {
      setAction(cause instanceof Error ? cause.message : "Replay failed.");
    }
  };

  return (
    <div className="content">
      <p className="muted" style={{ marginTop: 0 }}>
        Status, actions, tools, progress, results, errors, and metrics. The model's reasoning is not
        exposed — the server does not transmit it.
      </p>

      <Section state={observability}>
        {(summary) => (
          <>
            <div className="metrics">
              <Metric value={formatCount(summary.totals.runs)} label="analyzed runs" />
              <Metric value={asPercent(summary.rates.fallback)} label="fallback rate" />
              <Metric
                value={asPercent(summary.rates.toolError)}
                label="tool errors"
                alert={summary.rates.toolError > 0.1}
              />
              <Metric value={asPercent(summary.rates.runError)} label="failed runs" />
              <Metric
                value={formatEstimatedCost(summary.totals.estimatedApiEquivalentCostUsd)}
                label="equivalent API cost"
              />
            </div>
            {summary.agents.length === 0 ? null : (
              <Table
                head={[
                  "Agent",
                  "Runs",
                  "Failures",
                  "Average latency",
                  "p95",
                  "Tokens",
                  "Equiv. cost",
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
            <Empty>No recorded runs.</Empty>
          ) : (
            <>
              <Table
                head={["Run", "Status", "Stop Reason", "Iterations", "Tools", "Duration", "Tokens"]}
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
                          ({run.metrics.failedToolCalls} failed)
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
                    <h3>Actions</h3>
                    {run.tools.length === 0 ? (
                      <Empty>No tools called.</Empty>
                    ) : (
                      <Table
                        head={["Tool", "Action", "Status", "Risk", "Duration", "Attempts", "Error"]}
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

                    <h3>Result</h3>
                    <p>{run.response ?? <span className="muted">No final response.</span>}</p>

                    <button className="button" type="button" onClick={() => void replay(run.runId)}>
                      Replay (analysis only)
                    </button>
                    {run.replayOfRunId === null ? null : (
                      <p className="muted">
                        Replay of run <span className="mono">{run.replayOfRunId.slice(0, 8)}</span>.
                      </p>
                    )}

                    {run.errors.length === 0 ? null : (
                      <>
                        <h3>Errors</h3>
                        <Table head={["When", "Iteration", "Code", "Message"]}>
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

                    <h3>Metrics</h3>
                    <div className="metrics">
                      <Metric value={run.metrics.model} label="model" />
                      <Metric value={formatCount(run.metrics.inputTokens)} label="input tokens" />
                      <Metric value={formatCount(run.metrics.outputTokens)} label="output tokens" />
                      <Metric value={formatCount(run.metrics.cacheReadTokens)} label="cache read" />
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
  return cost === null ? "not configured" : `${cost.toFixed(4)} $`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Tools
// ─────────────────────────────────────────────────────────────────────────────

export function Tools({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.tools());

  return (
    <div className="content">
      <Section state={state}>
        {(data) =>
          data.tools.length === 0 ? (
            <Empty>No registered tools. The catalog populates when the agent service starts.</Empty>
          ) : (
            <Table head={["Tool", "Source", "Description", "Risk", "Permissions", "Allowed"]}>
              {data.tools.map((tool) => (
                <tr key={tool.name}>
                  <td className="mono">{tool.name}</td>
                  <td>{tool.source}</td>
                  <td className="muted">{tool.description}</td>
                  <td>{tool.riskLevel}</td>
                  <td className="mono muted">{tool.requiredPermissions.join(", ") || "—"}</td>
                  <td>
                    <State
                      tone={tool.allowed ? "ok" : "degraded"}
                      label={tool.allowed ? "yes" : "no"}
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
        setActionError(cause instanceof Error ? cause.message : "Action failed."),
      );
  };

  const save = (): void => {
    let refs: Record<string, string>;
    try {
      refs = secretRefs.trim() === "" ? {} : (JSON.parse(secretRefs) as Record<string, string>);
    } catch {
      setActionError("Secret references must be a JSON object.");
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
    act(() => api.saveMcp(config), `Server ${name} saved and connected.`);
  };

  return (
    <div className="content">
      {message === null ? null : <p className="banner success">{message}</p>}
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <section className="settings-panel">
        <h3>Add or Replace an MCP Server</h3>
        <div className="settings-grid">
          <label>
            Name
            <input
              className="field mono"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="filesystem"
            />
          </label>
          <label>
            Transport
            <select
              className="field"
              value={transport}
              onChange={(event) => setTransport(event.target.value as "stdio" | "http" | "sse")}
            >
              <option value="stdio">stdio</option>
              <option value="http">HTTP</option>
              <option value="sse">SSE</option>
            </select>
          </label>
          <label className="settings-wide">
            {transport === "stdio" ? "Command" : "URL"}
            <input
              className="field mono"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={transport === "stdio" ? "npx" : "https://…"}
            />
          </label>
          {transport === "stdio" ? (
            <label className="settings-wide">
              Arguments · one per line
              <textarea
                className="field mono"
                rows={3}
                value={args}
                onChange={(event) => setArgs(event.target.value)}
              />
            </label>
          ) : null}
          <label className="settings-wide">
            {transport === "stdio" ? "envRefs" : "headerRefs"} · JSON to vault://nexus/…
            <textarea
              className="field mono"
              rows={3}
              value={secretRefs}
              onChange={(event) => setSecretRefs(event.target.value)}
              placeholder={'{"TOKEN":"vault://nexus/mcp-token"}'}
            />
          </label>
        </div>
        <div className="settings-actions">
          <button
            className="button primary"
            type="button"
            disabled={name === "" || target === ""}
            onClick={save}
          >
            Save and connect
          </button>
        </div>
      </section>
      <Section state={state}>
        {(data) =>
          data.configurations.length === 0 ? (
            // Unconfigured is not broken. Saying so prevents looking for an
            // incident that does not exist.
            <Empty>No MCP servers configured.</Empty>
          ) : (
            <Table
              head={[
                "Server",
                "State",
                "Tools",
                "Failures",
                "Reconnects",
                "Circuit",
                "Last error",
                "Actions",
              ]}
            >
              {data.servers.map((server) => (
                <tr key={server.name}>
                  <td>
                    {server.name}
                    {server.serverInfo === null ? null : (
                      <div className="muted mono">
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
                  <td className="muted">
                    {server.circuitOpenUntil === null
                      ? "closed"
                      : `open until ${server.circuitOpenUntil}`}
                  </td>
                  <td className="muted">{server.lastError ?? "—"}</td>
                  <td>
                    <button
                      className="button compact"
                      type="button"
                      onClick={() =>
                        act(() => api.reconnectMcp(server.name), `${server.name} reconnected.`)
                      }
                    >
                      Reconnect
                    </button>{" "}
                    <button
                      className="button compact danger"
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Delete server ${server.name}?`))
                          act(() => api.removeMcp(server.name), `${server.name} deleted.`);
                      }}
                    >
                      Delete
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
        setActionError(cause instanceof Error ? cause.message : "Action failed."),
      );
  };

  return (
    <div className="content">
      {message === null ? null : <p className="banner success">{message}</p>}
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <section className="settings-panel">
        <h3>Configure Browser Use</h3>
        <p className="muted">
          Local mode uses the official harness with Codex or Claude as the brain. It requires no API
          keys and maintains a separate NEXUS Chromium profile.
        </p>
        <div className="settings-grid">
          <label className="settings-wide">
            Mode
            <select
              className="field"
              value={mode}
              onChange={(event) => setMode(event.target.value as "local-harness" | "remote-worker")}
            >
              <option value="local-harness">Local browser — no API key</option>
              <option value="remote-worker">Autonomous worker — LLM provider required</option>
            </select>
          </label>
          {mode === "local-harness" ? (
            <label className="settings-wide">
              Local CDP URL
              <input
                className="field mono"
                value={cdpUrl}
                onChange={(event) => setCdpUrl(event.target.value)}
              />
            </label>
          ) : (
            <>
              <label className="settings-wide">
                Worker URL
                <input
                  className="field mono"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </label>
              <label className="settings-wide">
                Token reference
                <input
                  className="field mono"
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
            Enable Browser Use
          </label>
        </div>
        <div className="settings-actions">
          <button
            className="button primary"
            type="button"
            onClick={() =>
              act(
                () =>
                  api.configureBrowser(
                    mode === "local-harness"
                      ? { enabled, mode, cdpUrl }
                      : { enabled, mode, baseUrl, tokenRef },
                  ),
                "Browser configuration saved.",
              )
            }
          >
            Save
          </button>
          <button
            className="button"
            type="button"
            onClick={() => act(() => api.testBrowser(), "Browser worker reachable.")}
          >
            Test
          </button>
        </div>
      </section>
      <Section state={state}>
        {(data) => (
          <>
            <div className="metrics">
              <Metric value={data.configured ? "yes" : "no"} label="configured" />
              <Metric
                value={data.reachable ? "ready" : "unreachable"}
                label="browser"
                alert={data.configured && !data.reachable}
              />
            </div>

            <p className="muted">{data.detail}</p>
            {data.configuration?.mode === "remote-worker" ? (
              <p className="muted">
                Secret: {data.tokenConfigured ? "present in keyring" : "missing"}
              </p>
            ) : null}

            {data.health === null ? null : (
              <>
                <h3>Reported Health</h3>
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
  const [accountName, setAccountName] = useState("NEXUS Portfolio");
  const [bankroll, setBankroll] = useState("50.00");
  const [marketQuestion, setMarketQuestion] = useState("");
  const [marketClose, setMarketClose] = useState("");
  const [scheduleName, setScheduleName] = useState("");
  const [scheduleInstruction, setScheduleInstruction] = useState("");
  const [scheduleProfile, setScheduleProfile] = useState("");
  const [scheduleKind, setScheduleKind] = useState<"one_shot" | "cron">("cron");
  const [scheduleRunAt, setScheduleRunAt] = useState("");
  const [scheduleCron, setScheduleCron] = useState("0 8 * * 1-5");
  const [scheduleTimezone, setScheduleTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [scheduleCatchUp, setScheduleCatchUp] = useState<"skip" | "latest" | "all">("latest");
  const [scheduleHistory, setScheduleHistory] = useState<Record<string, ScheduleRun[]>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const act = (operation: () => Promise<unknown>): void => {
    setActionError(null);
    void operation()
      .then(() => state.reload())
      .catch((cause: unknown) =>
        setActionError(cause instanceof Error ? cause.message : "Action failed."),
      );
  };

  return (
    <div className="content">
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
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
              <div className="metrics">
                <Metric value={data.configured ? "yes" : "no"} label="configured" />
                <Metric
                  value={data.reachable ? "reachable" : "unreachable"}
                  label="ACP engine"
                  alert={data.configured && !data.reachable}
                />
                <Metric
                  value={data.health?.worker_enabled === true ? "active" : "stopped"}
                  label="workers"
                  alert={data.configured && data.health?.worker_enabled !== true}
                />
                <Metric value={String(data.health?.worker_concurrency ?? 0)} label="concurrency" />
                <Metric
                  value={data.audit?.valid === true ? "valid" : "invalid"}
                  label="audit chain"
                  alert={data.configured && data.audit?.valid !== true}
                />
                <Metric value={formatCount(data.audit?.checked ?? 0)} label="audited events" />
                <Metric value={`${(cash / 100).toFixed(2)} €`} label="paper cash" />
                <Metric value={`${(exposure / 100).toFixed(2)} €`} label="paper exposure" />
                <Metric value={formatCount(activeRuns)} label="active missions" />
              </div>

              <p className="muted">{data.detail}</p>

              <h3>NEXUS · ACP profiles</h3>
              <p className="mono muted">
                {data.health === null || data.health.profiles.length === 0
                  ? "none"
                  : data.health.profiles.join(", ")}
              </p>

              <h3>Autonomous Schedules</h3>
              <div className="admin-form-card schedule-form-card">
                <div className="inline-admin-form schedule-form">
                  <input
                    className="field"
                    value={scheduleName}
                    onChange={(event) => setScheduleName(event.target.value)}
                    placeholder="Schedule name"
                  />
                  <select
                    className="field"
                    value={scheduleKind}
                    onChange={(event) => setScheduleKind(event.target.value as "one_shot" | "cron")}
                  >
                    <option value="cron">Recurring · cron</option>
                    <option value="one_shot">One-shot</option>
                  </select>
                  <select
                    className="field"
                    value={scheduleProfile}
                    onChange={(event) => setScheduleProfile(event.target.value)}
                  >
                    <option value="">Automatically select first profile</option>
                    {(data.health?.profiles ?? []).map((profile) => (
                      <option value={profile} key={profile}>
                        {profile}
                      </option>
                    ))}
                  </select>
                  <input
                    className="field"
                    value={scheduleTimezone}
                    onChange={(event) => setScheduleTimezone(event.target.value)}
                    placeholder="Europe/Paris"
                  />
                  {scheduleKind === "cron" ? (
                    <input
                      className="field mono"
                      value={scheduleCron}
                      onChange={(event) => setScheduleCron(event.target.value)}
                      placeholder="0 8 * * 1-5"
                    />
                  ) : (
                    <input
                      className="field"
                      type="datetime-local"
                      value={scheduleRunAt}
                      onChange={(event) => setScheduleRunAt(event.target.value)}
                    />
                  )}
                  <select
                    className="field"
                    value={scheduleCatchUp}
                    onChange={(event) =>
                      setScheduleCatchUp(event.target.value as "skip" | "latest" | "all")
                    }
                  >
                    <option value="skip">Skip missed occurrences</option>
                    <option value="latest">Catch up latest occurrence only</option>
                    <option value="all">Catch up all missed occurrences</option>
                  </select>
                </div>
                <textarea
                  className="field schedule-instruction"
                  value={scheduleInstruction}
                  onChange={(event) => setScheduleInstruction(event.target.value)}
                  placeholder="Mission to execute automatically"
                  rows={3}
                />
                <button
                  className="button"
                  type="button"
                  disabled={
                    data.health?.scheduler_enabled !== true ||
                    scheduleName.trim().length === 0 ||
                    scheduleInstruction.trim().length === 0 ||
                    (data.health?.profiles.length ?? 0) === 0 ||
                    (scheduleKind === "cron"
                      ? scheduleCron.trim().length === 0
                      : scheduleRunAt.length === 0)
                  }
                  onClick={() => {
                    const profile = scheduleProfile || data.health?.profiles[0];
                    if (profile === undefined) return;
                    act(() =>
                      api.createSchedule({
                        name: scheduleName.trim(),
                        mission: {
                          // The server systematically replaces this value
                          // with a key tied to the authenticated account.
                          external_key: "dashboard-owned-server-side",
                          title: scheduleName.trim(),
                          workspace: "/tmp/nexus-scheduled",
                          tasks: [
                            {
                              key: "scheduled_task",
                              profile,
                              instruction: scheduleInstruction.trim(),
                              depends_on: [],
                            },
                          ],
                        },
                        timezone: scheduleTimezone.trim(),
                        ...(scheduleKind === "cron"
                          ? { cron_expression: scheduleCron.trim() }
                          : { run_at: new Date(scheduleRunAt).toISOString() }),
                        catch_up_policy: scheduleCatchUp,
                        max_catch_up: 10,
                        max_concurrency: 1,
                        misfire_grace_seconds: 300,
                      }),
                    );
                  }}
                >
                  Create schedule
                </button>
                {data.health?.scheduler_enabled === true ? null : (
                  <p className="muted">Schedule dispatcher is disabled.</p>
                )}
              </div>

              {data.schedules.length === 0 ? (
                <Empty>No schedules for this account.</Empty>
              ) : (
                <div className="stack">
                  {data.schedules.map((schedule) => (
                    <details className="card" key={schedule.id}>
                      <summary>
                        <State
                          tone={
                            schedule.state === "active"
                              ? "ok"
                              : schedule.state === "paused"
                                ? "degraded"
                                : "info"
                          }
                          label={schedule.state}
                        />{" "}
                        {schedule.name} ·{" "}
                        {schedule.schedule_kind === "cron" ? schedule.cron_expression : "one-shot"}
                      </summary>
                      <div className="schedule-details">
                        <p className="muted">
                          Timezone: {schedule.timezone} · Next run:{" "}
                          {schedule.next_run_at === null
                            ? "none"
                            : new Date(schedule.next_run_at).toLocaleString()}
                        </p>
                        <p>{schedule.mission.tasks[0]?.instruction ?? schedule.mission.title}</p>
                        <div className="actions-row">
                          {schedule.state === "active" ? (
                            <button
                              className="button secondaire compact"
                              type="button"
                              onClick={() => act(() => api.pauseSchedule(schedule.id))}
                            >
                              Pause
                            </button>
                          ) : schedule.state === "paused" ? (
                            <button
                              className="button compact"
                              type="button"
                              onClick={() => act(() => api.resumeSchedule(schedule.id))}
                            >
                              Resume
                            </button>
                          ) : null}
                          <button
                            className="button secondaire compact"
                            type="button"
                            onClick={() => {
                              setActionError(null);
                              void api
                                .scheduleRuns(schedule.id)
                                .then(({ runs }) =>
                                  setScheduleHistory((current) => ({
                                    ...current,
                                    [schedule.id]: runs,
                                  })),
                                )
                                .catch((cause: unknown) =>
                                  setActionError(
                                    cause instanceof Error ? cause.message : "History unavailable.",
                                  ),
                                );
                            }}
                          >
                            Load history
                          </button>
                        </div>
                        {scheduleHistory[schedule.id] === undefined ? null : scheduleHistory[
                            schedule.id
                          ]?.length === 0 ? (
                          <p className="muted">No occurrences executed.</p>
                        ) : (
                          <Table head={["Scheduled", "State", "Mission", "Error"]}>
                            {scheduleHistory[schedule.id]?.map((run) => (
                              <tr key={run.id}>
                                <td>{new Date(run.scheduled_for).toLocaleString()}</td>
                                <td>
                                  <State
                                    tone={
                                      run.state === "succeeded"
                                        ? "ok"
                                        : run.state === "failed"
                                          ? "down"
                                          : run.state === "skipped"
                                            ? "degraded"
                                            : "info"
                                    }
                                    label={run.state}
                                  />
                                </td>
                                <td className="mono muted">{run.mission_id?.slice(0, 8) ?? "—"}</td>
                                <td className="muted">{run.error_code ?? "—"}</td>
                              </tr>
                            ))}
                          </Table>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              )}

              <h3>Unified Mission Timeline</h3>
              {data.missions.length === 0 ? (
                <Empty>No NEXUS ACP missions for this account.</Empty>
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
                        {mission.title} · {mission.tasks.length} step(s) ·{" "}
                        {formatAge(mission.created_at)}
                      </summary>
                      <Table
                        head={["Step", "Agent", "State", "Dependencies", "Attempts", "Duration"]}
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
                              <td className="muted">
                                {task.depends_on.length === 0 ? "—" : task.depends_on.join(", ")}
                              </td>
                              <td>{task.attempts.length}</td>
                              <td className="muted">
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

              <h3>Paper Portfolios</h3>
              <div className="inline-admin-form">
                <input
                  className="field"
                  value={accountName}
                  onChange={(event) => setAccountName(event.target.value)}
                  placeholder="Portfolio name"
                />
                <input
                  className="field"
                  value={bankroll}
                  onChange={(event) => setBankroll(event.target.value)}
                  inputMode="decimal"
                  placeholder="Capital EUR"
                />
                <button
                  className="button"
                  type="button"
                  onClick={() =>
                    act(() =>
                      api.createPaperAccount({ name: accountName.trim(), bankroll_eur: bankroll }),
                    )
                  }
                >
                  Create
                </button>
              </div>
              {data.accounts.length === 0 ? (
                <Empty>No research portfolios.</Empty>
              ) : (
                <Table head={["Name", "Cash", "Exposure", "Realized P&L", "Mode"]}>
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

              <h3>Recent Missions</h3>
              {data.recent_runs.length === 0 ? (
                <Empty>No ACP missions executed.</Empty>
              ) : (
                <Table head={["Created", "State", "Mission", "Error"]}>
                  {data.recent_runs.map((run) => (
                    <tr key={run.id}>
                      <td className="muted">{formatAge(run.created_at)}</td>
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
                      <td className="mono muted">{run.mission_id.slice(0, 8)}</td>
                      <td className="muted">{run.error_code ?? "—"}</td>
                    </tr>
                  ))}
                </Table>
              )}

              <h3>Paper Research Market</h3>
              <div className="inline-admin-form market-form">
                <input
                  className="field"
                  value={marketQuestion}
                  onChange={(event) => setMarketQuestion(event.target.value)}
                  placeholder="Market question"
                />
                <input
                  className="field"
                  type="datetime-local"
                  value={marketClose}
                  onChange={(event) => setMarketClose(event.target.value)}
                />
                <button
                  className="button"
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
                  Create
                </button>
              </div>

              <p className="muted">
                Creation of missions and paper portfolios uses the NEXUS administrator API. No live
                trading paths are exposed.
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
        setError(err instanceof Error ? err.message : "Loading error");
      } finally {
        setLoading(false);
      }
    }
    setOpen(!open);
  };

  return (
    <div
      style={{ marginTop: "12px", borderTop: "1px dashed var(--border, #444)", paddingTop: "8px" }}
    >
      <button
        type="button"
        className="button"
        style={{ fontSize: "0.85rem", padding: "4px 10px" }}
        onClick={() => void toggle()}
      >
        {open ? "Hide artifacts and collaboration" : "Shared Artifacts & Cross-Agent Collaboration"}
      </button>

      {loading ? (
        <p className="muted" style={{ marginTop: "6px" }}>
          Loading collaboration workspace…
        </p>
      ) : null}
      {error ? <p style={{ color: "var(--danger, #ff5555)", marginTop: "6px" }}>{error}</p> : null}

      {open && collab ? (
        <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "12px" }}>
          {/* Artifacts */}
          <div>
            <h4 style={{ margin: "0 0 6px 0", fontSize: "0.95rem" }}>
              Shared Artifacts ({collab.artifacts.length})
            </h4>
            {collab.artifacts.length === 0 ? (
              <p className="muted">No files generated in this mission.</p>
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
                      <div className="muted" style={{ fontSize: "0.75rem" }}>
                        {(art.sizeBytes / 1024).toFixed(1)} KB · {art.mimeType} · {art.taskKey}
                      </div>
                    </div>
                    <a
                      href={api.artifactDownloadUrl(missionId, art.uri)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="button primary"
                      style={{ fontSize: "0.75rem", padding: "2px 8px" }}
                    >
                      Open
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Adversarial debates */}
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
                Adversarial debate detected
              </h4>
              {collab.debates.map((d) => (
                <div key={d.id} style={{ fontSize: "0.85rem" }}>
                  <p>
                    <strong>{d.issue}</strong>
                  </p>
                  <p className="muted">{d.recommendation}</p>
                </div>
              ))}
            </div>
          ) : null}

          {/* Dynamic subtasks */}
          {collab.proposedSubtasks.length > 0 ? (
            <div>
              <h4 style={{ margin: "0 0 6px 0", fontSize: "0.95rem" }}>
                Dynamic subtasks proposed ({collab.proposedSubtasks.length})
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
                    <strong>{st.title}</strong> ({st.key}) ·{" "}
                    <span className="badge">{st.priority}</span>
                    <div className="muted">{st.reason}</div>
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
// 9. Memory
// ─────────────────────────────────────────────────────────────────────────────

export function Memory({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.memory());
  const [content, setContent] = useState("");
  const [layer, setLayer] = useState<"LONG_TERM" | "PREFERENCE">("LONG_TERM");
  const [tags, setTags] = useState("");
  const [acknowledgedSensitive, setAcknowledgedSensitive] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <div className="content">
      <div className="admin-form-card">
        <h3>Add Memory</h3>
        <div className="inline-admin-form memory-form">
          <input
            className="field"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="What NEXUS should remember"
          />
          <select
            className="field"
            value={layer}
            onChange={(event) => setLayer(event.target.value as "LONG_TERM" | "PREFERENCE")}
          >
            <option value="LONG_TERM">Long-term</option>
            <option value="PREFERENCE">Preference</option>
          </select>
          <input
            className="field"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="tags, comma, separated"
          />
          <label className="check-label">
            <input
              type="checkbox"
              checked={acknowledgedSensitive}
              onChange={(event) => setAcknowledgedSensitive(event.target.checked)}
            />
            sensitive content verified
          </label>
          <button
            className="button primary"
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
                  setActionError(cause instanceof Error ? cause.message : "Unable to save."),
                );
            }}
          >
            Remember
          </button>
        </div>
      </div>
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <Section state={state}>
        {(data) => (
          <>
            <div className="metrics">
              <Metric value={formatCount(data.total)} label="memories" />
              <Metric value={formatCount(data.byLayer.PREFERENCE ?? 0)} label="preferences" />
              <Metric value={formatCount(data.byOrigin.AGENT ?? 0)} label="inferred by agent" />
              <Metric
                value={formatCount(data.bySensitivity.PERSONAL ?? 0)}
                label="marked personal"
              />
            </div>

            <h3>Recent Memories</h3>
            {data.recent.length === 0 ? (
              <Empty>No memories stored.</Empty>
            ) : (
              <Table head={["Content", "Layer", "Origin", "Created", "Actions"]}>
                {data.recent.map((record) => (
                  <tr key={record.id}>
                    <td>{record.content}</td>
                    <td className="muted">{record.layer}</td>
                    <td className="muted">{record.origin}</td>
                    <td className="muted">{formatAge(record.createdAt)}</td>
                    <td>
                      <button
                        className="button danger"
                        type="button"
                        onClick={() => {
                          if (!window.confirm("Permanently forget this memory?")) return;
                          void api
                            .forget(record.id)
                            .then(() => state.reload())
                            .catch((cause: unknown) =>
                              setActionError(
                                cause instanceof Error ? cause.message : "Deletion failed.",
                              ),
                            );
                        }}
                      >
                        Forget
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
  const [config, setConfig] = useState<ExternalNotificationConfigDto | null>(null);
  const [configSaving, setConfigSaving] = useState(false);
  const [configFeedback, setConfigFeedback] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  useEffect(() => {
    void api
      .notificationConfig()
      .then(setConfig)
      .catch((cause: unknown) => {
        console.warn("Notification config load skipped:", cause instanceof Error ? cause.message : cause);
      });
  }, [api]);

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!config) return;
    setConfigSaving(true);
    setConfigFeedback(null);
    try {
      await api.saveNotificationConfig(config);
      setConfigFeedback("External notification configuration saved.");
      setTimeout(() => setConfigFeedback(null), 3500);
    } catch (err) {
      setConfigFeedback(`Save error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConfigSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { report } = await api.testNotification();
      const summary = report.channels
        .map(
          (c) =>
            `${c.channel}: ${c.success ? "✓ success" : c.skippedReason ? `(skipped: ${c.skippedReason})` : `✗ error (${c.error ?? ""})`}`,
        )
        .join(" | ");
      setTestResult(`Report: ${summary}`);
    } catch (err) {
      setTestResult(`Test failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="content">
      <div className="agents-heading">
        <div>
          <h2>Notifications</h2>
          <p className="muted">
            Central log and broadcast to external channels (desktop, mobile push ntfy, webhooks).
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            className="button secondary"
            type="button"
            onClick={() => setShowConfig((curr) => !curr)}
          >
            {showConfig ? "Hide channel config" : "Configure channels"}
          </button>
          <button
            className="button"
            type="button"
            disabled={testing}
            onClick={() => void handleTest()}
          >
            {testing ? "Testing..." : "Test external channels"}
          </button>
        </div>
      </div>

      {testResult !== null ? (
        <p className="banner success" style={{ marginBottom: "1rem" }}>
          {testResult}
        </p>
      ) : null}

      {configFeedback !== null ? (
        <p className="banner success" style={{ marginBottom: "1rem" }}>
          {configFeedback}
        </p>
      ) : null}

      {showConfig && config !== null && (
        <form
          className="card"
          onSubmit={(e) => void handleSaveConfig(e)}
          style={{ padding: "16px", marginBottom: "20px", border: "1px solid var(--border)" }}
        >
          <h3 style={{ marginTop: 0 }}>External Notification Channels</h3>

          <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "12px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
              />
              <strong>Enable external notification broadcast</strong>
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <label>
                Desktop Alert Urgency
                <select
                  className="field"
                  value={config.desktop.urgency}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      desktop: {
                        ...config.desktop,
                        urgency: e.target.value as "low" | "normal" | "critical",
                      },
                    })
                  }
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="critical">Critical</option>
                </select>
              </label>

              <label>
                Dashboard Base URL
                <input
                  className="field"
                  type="url"
                  value={config.dashboardBaseUrl}
                  onChange={(e) => setConfig({ ...config, dashboardBaseUrl: e.target.value })}
                />
              </label>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <label>
                Ntfy Server URL
                <input
                  className="field"
                  type="url"
                  value={config.ntfy.serverUrl}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      ntfy: { ...config.ntfy, serverUrl: e.target.value },
                    })
                  }
                />
              </label>

              <label>
                Ntfy Topic
                <input
                  className="field"
                  type="text"
                  value={config.ntfy.topic}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      ntfy: { ...config.ntfy, topic: e.target.value },
                    })
                  }
                />
              </label>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "12px" }}>
              <label>
                Webhook URL
                <input
                  className="field"
                  type="url"
                  placeholder="https://discord.com/api/webhooks/..."
                  value={config.webhook?.url ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      webhook: {
                        enabled: e.target.value.trim().length > 0,
                        url: e.target.value,
                        format: config.webhook?.format ?? "generic",
                      },
                    })
                  }
                />
              </label>

              <label>
                Webhook Format
                <select
                  className="field"
                  value={config.webhook?.format ?? "generic"}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      webhook: {
                        enabled: (config.webhook?.url ?? "").length > 0,
                        ...(config.webhook?.url ? { url: config.webhook.url } : {}),
                        format: e.target.value as "discord" | "telegram" | "apprise" | "generic",
                      },
                    })
                  }
                >
                  <option value="generic">Generic JSON</option>
                  <option value="discord">Discord</option>
                  <option value="telegram">Telegram</option>
                  <option value="apprise">Apprise</option>
                </select>
              </label>
            </div>

            <div>
              <button
                type="submit"
                className="button primary"
                disabled={configSaving}
              >
                {configSaving ? "Saving..." : "Save notification settings"}
              </button>
            </div>
          </div>
        </form>
      )}

      <Section state={state}>
        {(data) => (
          <>
            <div className="metrics">
              <Metric value={formatCount(data.unread)} label="unread" />
              <Metric value={formatCount(data.notifications.length)} label="stored" />
            </div>

            {data.notifications.length === 0 ? (
              <Empty>No notifications.</Empty>
            ) : (
              <Table head={["When", "Severity", "Title", "Body", "Read", "Actions"]}>
                {data.notifications.map((notification) => (
                  <tr key={notification.id}>
                    <td className="muted">{formatAge(notification.createdAt)}</td>
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
                    <td className="muted">{notification.body}</td>
                    <td className="muted">{notification.readAt === null ? "no" : "yes"}</td>
                    <td>
                      {notification.readAt === null ? (
                        <button
                          className="button"
                          type="button"
                          onClick={() =>
                            void api
                              .markNotificationRead(notification.id)
                              .then(() => state.reload())
                          }
                        >
                          Mark read
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
// 11. Security
// ─────────────────────────────────────────────────────────────────────────────

export function Security({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.security());

  return (
    <div className="content">
      <Section state={state}>
        {(data) => (
          <>
            <div className="metrics">
              <Metric value={formatCount(data.trust.trusted)} label="trusted devices" />
              <Metric
                value={formatCount(data.trust.pending)}
                label="pending approval"
                alert={data.trust.pending > 0}
              />
              <Metric value={formatCount(data.trust.revoked)} label="revoked" />
              <Metric
                value={formatCount(data.byKind["auth.login_failed"] ?? 0)}
                label="login failures"
                alert={(data.byKind["auth.login_failed"] ?? 0) > 0}
              />
              <Metric
                value={formatCount(data.byKind["memory.refused"] ?? 0)}
                label="rejected memories"
              />
            </div>

            <h3>Effective Permissions</h3>
            <p className="mono muted">
              {data.permissions.length === 0 ? "none" : data.permissions.join(", ")}
            </p>

            <h3>Events</h3>
            {data.events.length === 0 ? (
              <Empty>No security events.</Empty>
            ) : (
              <Table head={["When", "Type", "Summary"]}>
                {data.events.map((event, index) => (
                  <tr key={`${event.at}-${String(index)}`}>
                    <td className="muted">{formatAge(event.at)}</td>
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
// 12. Logs
// ─────────────────────────────────────────────────────────────────────────────

export function Logs({ api }: { api: DashboardApi }) {
  const [level, setLevel] = useState<string>("");
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState<{ level?: string; search?: string }>({});

  const state = useSection(() => api.logs(applied));

  return (
    <div className="content">
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <select
          className="field"
          value={level}
          onChange={(event) => {
            setLevel(event.target.value);
          }}
        >
          <option value="">all levels</option>
          <option value="info">info and above</option>
          <option value="warn">warnings</option>
          <option value="error">errors</option>
        </select>

        <input
          className="field"
          style={{ flex: 1 }}
          value={search}
          placeholder="Search messages…"
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        ></input>

        <button
          type="button"
          className="button"
          onClick={() => {
            setApplied({
              ...(level === "" ? {} : { level }),
              ...(search === "" ? {} : { search }),
            });
            state.reload();
          }}
        >
          Filter
        </button>
      </div>

      <Section state={state}>
        {(data) =>
          data.entries.length === 0 ? (
            <Empty>No log lines matched.</Empty>
          ) : (
            <Table head={["When", "Level", "Message", "Correlation"]}>
              {data.entries.map((entry, index) => (
                <tr key={`${entry.at}-${String(index)}`}>
                  <td className="muted mono">{entry.at.slice(11, 23)}</td>
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
                  <td className="muted mono">{entry.correlationId ?? "—"}</td>
                </tr>
              ))}
            </Table>
          )
        }
      </Section>
    </div>
  );
}
