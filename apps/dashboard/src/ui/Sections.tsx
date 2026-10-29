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
  KNOWN_PERMISSIONS,
  PERMISSION_PRESETS,
  WORKER_LABELS,
  failedSteps,
  formatAge,
  formatCount,
  formatDuration,
  formatLatency,
  overallHealth,
  selectedWorkers,
  sortActivity,
  workerState,
} from "../lib/format.js";
import { Bar, Empty, Metric, Section, State, Table, useSection } from "./parts.js";
import { useI18n } from "./i18n/index.js";

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
  const network = useSection(() => api.networkDiscovery());
  const [actionError, setActionError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingTicket | null>(null);
  const [pairingLabel, setPairingLabel] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [editingCapabilitiesDeviceId, setEditingCapabilitiesDeviceId] = useState<string | null>(
    null,
  );
  const [editingCapabilities, setEditingCapabilities] = useState<
    { name: string; enabled: boolean }[]
  >([]);
  const [editingPermissionsDeviceId, setEditingPermissionsDeviceId] = useState<string | null>(null);
  const [editingPermissions, setEditingPermissions] = useState<string[]>([]);
  const [customPermission, setCustomPermission] = useState("");

  useEffect(() => {
    if (pairing === null) return;
    const remaining = Math.max(0, new Date(pairing.expiresAt).getTime() - Date.now());
    const timer = window.setTimeout(() => setPairing(null), remaining);
    return () => window.clearTimeout(timer);
  }, [pairing]);

  const issuePairing = (suggestedLabel?: string): void => {
    const label = suggestedLabel ?? pairingLabel;
    setActionError(null);
    setPairingBusy(true);
    void api
      .createPairingTicket(label)
      .then((ticket) => {
        setPairing(ticket);
        if (suggestedLabel !== undefined) setPairingLabel(suggestedLabel);
      })
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
      <section className="card network-discovery-card" aria-labelledby="private-network-title">
        <div className="pairing-heading">
          <div>
            <span className="eyebrow">PRIVATE NETWORK</span>
            <h3 id="private-network-title">Automatic device discovery</h3>
            <p className="muted">
              NEXUS detects machines visible through Tailscale. Discovery never grants trust:
              pairing and approval remain explicit security boundaries.
            </p>
          </div>
          <button className="button" type="button" onClick={() => network.reload()}>
            Refresh network
          </button>
        </div>
        <Section state={network}>
          {(data) => (
            <>
              <div className="network-summary">
                <State
                  tone={data.running ? "ok" : data.installed ? "degraded" : "unconfigured"}
                  label={data.running ? "TAILSCALE CONNECTED" : data.backendState.toUpperCase()}
                />
                <div>
                  <strong>{data.self?.name ?? "NEXUS host"}</strong>
                  <span className="muted">{data.suggestedApiUrl ?? data.guidance}</span>
                </div>
                {data.automaticPairingUrl ? (
                  <span className="network-auto-badge">Pairing address managed automatically</span>
                ) : null}
              </div>
              {data.peers.length === 0 ? (
                <Empty>No other Tailscale devices detected.</Empty>
              ) : (
                <div className="network-peer-grid">
                  {data.peers.map((peer) => (
                    <article className="network-peer" key={peer.id}>
                      <div>
                        <strong>{peer.name}</strong>
                        <span className="muted">
                          {peer.os} · {peer.online ? "online" : "offline"}
                        </span>
                      </div>
                      <State
                        tone={peer.online ? "ok" : "unconfigured"}
                        label={peer.online ? "REACHABLE" : "OFFLINE"}
                      />
                      <button
                        className="button primary"
                        type="button"
                        disabled={!peer.online || pairingBusy}
                        onClick={() => issuePairing(peer.name)}
                      >
                        Pair with NEXUS
                      </button>
                    </article>
                  ))}
                </div>
              )}
              <p className="muted network-security-note">
                A discovered device cannot execute tasks or access NEXUS data until its client uses
                a single-use pairing ticket and you approve it.
              </p>
            </>
          )}
        </Section>
      </section>
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
              onClick={() => issuePairing()}
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
                  marginBottom: "16px",
                }}
              >
                <div aria-label="Pairing QR Code" dangerouslySetInnerHTML={{ __html: qrSvg }} />
                <span style={{ fontSize: "0.8rem", marginTop: "8px", fontWeight: 500 }}>
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
            <div className="callout info network-managed-note">
              <strong>Private connectivity:</strong> NEXUS automatically uses the host Tailscale
              address when no explicit public API address is configured. No tailnet key is read or
              stored.
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
                const isEditingPermissions = editingPermissionsDeviceId === device.id;
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
                            <label
                              key={cap.name}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                fontSize: "0.85rem",
                              }}
                            >
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
                                setEditingCapabilities(
                                  editingCapabilities.map((c) => ({ ...c, enabled: false })),
                                );
                              }}
                            >
                              Pause all
                            </button>
                            <button
                              className="button primary"
                              type="button"
                              onClick={() => {
                                act(async () => {
                                  await api.updateDeviceCapabilities(
                                    device.id,
                                    editingCapabilities,
                                  );
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
                    <td className="muted">
                      <div>{formatAge(device.lastHeartbeatAt)}</div>
                      {(() => {
                        const latency = formatLatency(device.health.latencyMs);
                        return (
                          <div
                            className="latency-indicator"
                            title={`Heartbeat latency: ${latency.text}`}
                            style={{ marginTop: "4px" }}
                          >
                            <State tone={latency.tone} label={`Latency: ${latency.text}`} />
                            {device.health.latencyMs !== null ? (
                              <div
                                className="mini-latency-bar"
                                role="progressbar"
                                aria-label="Heartbeat latency"
                                aria-valuemin={0}
                                aria-valuemax={300}
                                aria-valuenow={Math.round(device.health.latencyMs)}
                                style={{
                                  width: "72px",
                                  height: "4px",
                                  background: "var(--nx-surface-active)",
                                  borderRadius: "2px",
                                  overflow: "hidden",
                                  marginTop: "3px",
                                }}
                              >
                                <div
                                  style={{
                                    width: `${String(latency.percent)}%`,
                                    height: "100%",
                                    background:
                                      latency.tone === "ok"
                                        ? "#22c55e"
                                        : latency.tone === "degraded"
                                          ? "#eab308"
                                          : "var(--nx-danger)",
                                    transition: "width 0.2s ease",
                                  }}
                                />
                              </div>
                            ) : null}
                          </div>
                        );
                      })()}
                    </td>
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
                      {isEditingPermissions ? (
                        <div
                          className="permission-picker"
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "8px",
                            padding: "8px",
                            background: "var(--nx-canvas-sunken)",
                            borderRadius: "6px",
                            minWidth: "260px",
                          }}
                        >
                          <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                            <strong style={{ fontSize: "0.75rem", width: "100%" }}>Presets:</strong>
                            {Object.entries(PERMISSION_PRESETS).map(([presetName, presetPerms]) => (
                              <button
                                key={presetName}
                                className="button compact"
                                type="button"
                                style={{ fontSize: "0.7rem", padding: "2px 6px" }}
                                onClick={() => setEditingPermissions([...presetPerms])}
                              >
                                {presetName}
                              </button>
                            ))}
                          </div>

                          <div
                            style={{
                              maxHeight: "160px",
                              overflowY: "auto",
                              display: "flex",
                              flexDirection: "column",
                              gap: "4px",
                            }}
                          >
                            {KNOWN_PERMISSIONS.map((perm) => (
                              <label
                                key={perm.id}
                                style={{
                                  display: "flex",
                                  alignItems: "flex-start",
                                  gap: "6px",
                                  fontSize: "0.8rem",
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={editingPermissions.includes(perm.id)}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setEditingPermissions((prev) => [...prev, perm.id]);
                                    } else {
                                      setEditingPermissions((prev) =>
                                        prev.filter((p) => p !== perm.id),
                                      );
                                    }
                                  }}
                                />
                                <span>
                                  <strong>{perm.label}</strong>{" "}
                                  <span className="muted mono">({perm.id})</span>
                                </span>
                              </label>
                            ))}
                            {editingPermissions
                              .filter((p) => !KNOWN_PERMISSIONS.some((k) => k.id === p))
                              .map((custom) => (
                                <label
                                  key={custom}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "6px",
                                    fontSize: "0.8rem",
                                  }}
                                >
                                  <input
                                    type="checkbox"
                                    checked
                                    onChange={() =>
                                      setEditingPermissions((prev) =>
                                        prev.filter((p) => p !== custom),
                                      )
                                    }
                                  />
                                  <span className="mono">{custom} (custom)</span>
                                </label>
                              ))}
                          </div>

                          <div style={{ display: "flex", gap: "4px", marginTop: "4px" }}>
                            <input
                              className="field"
                              placeholder="Custom (e.g. sensor.custom)"
                              value={customPermission}
                              onChange={(e) => setCustomPermission(e.target.value)}
                              style={{ fontSize: "0.75rem", padding: "2px 6px" }}
                            />
                            <button
                              className="button compact"
                              type="button"
                              onClick={() => {
                                const trimmed = customPermission.trim();
                                if (trimmed && !editingPermissions.includes(trimmed)) {
                                  setEditingPermissions((prev) => [...prev, trimmed]);
                                  setCustomPermission("");
                                }
                              }}
                            >
                              Add
                            </button>
                          </div>

                          <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
                            <button
                              className="button primary compact"
                              type="button"
                              onClick={() => {
                                act(async () => {
                                  await api.updateDevicePermissions(device.id, editingPermissions);
                                  setEditingPermissionsDeviceId(null);
                                });
                              }}
                            >
                              Save
                            </button>
                            <button
                              className="button compact"
                              type="button"
                              onClick={() => setEditingPermissionsDeviceId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          {device.grantedPermissions.length === 0
                            ? "—"
                            : device.grantedPermissions.join(", ")}
                        </div>
                      )}
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
                                if (isEditingPermissions) {
                                  setEditingPermissionsDeviceId(null);
                                } else {
                                  setEditingPermissionsDeviceId(device.id);
                                  setEditingPermissions([...device.grantedPermissions]);
                                  setCustomPermission("");
                                }
                              }}
                            >
                              {isEditingPermissions ? "Close" : "Permissions"}
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
  const state = useSection<TaskDetail>(() => api.task(taskId), [taskId]);

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
  return <MissionEngineView api={api} view="missions" />;
}

export function TradingLab({ api }: { api: DashboardApi }) {
  return <MissionEngineView api={api} view="trading" />;
}

function MissionEngineView({ api, view }: { api: DashboardApi; view: "missions" | "trading" }) {
  const { locale } = useI18n();
  const state = useSection(() => api.missionControl());
  const isTrading = view === "trading";
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
              {isTrading ? (
                <div className="paper-trading-banner">
                  <div>
                    <strong>
                      {locale === "fr"
                        ? "Simulation & Recherche — Aucun fonds réel"
                        : "Simulation & Research — No Real Money"}
                    </strong>
                    <p className="muted" style={{ margin: "4px 0 0" }}>
                      {locale === "fr"
                        ? "La création de missions et de portefeuilles de recherche utilise l'API administrateur NEXUS. Aucune route d'exécution financière réelle n'est exposée."
                        : "Creation of missions and paper portfolios uses the NEXUS administrator API. No live trading paths are exposed."}
                    </p>
                  </div>
                </div>
              ) : null}

              <div className="metrics">
                <Metric
                  value={
                    data.configured
                      ? locale === "fr"
                        ? "oui"
                        : "yes"
                      : locale === "fr"
                        ? "non"
                        : "no"
                  }
                  label={locale === "fr" ? "configuré" : "configured"}
                />
                <Metric
                  value={
                    data.reachable
                      ? locale === "fr"
                        ? "accessible"
                        : "reachable"
                      : locale === "fr"
                        ? "inaccessible"
                        : "unreachable"
                  }
                  label={locale === "fr" ? "moteur ACP" : "ACP engine"}
                  alert={data.configured && !data.reachable}
                />
                {isTrading ? (
                  <>
                    <Metric
                      value={`${(cash / 100).toFixed(2)} €`}
                      label={locale === "fr" ? "liquidités papier" : "paper cash"}
                    />
                    <Metric
                      value={`${(exposure / 100).toFixed(2)} €`}
                      label={locale === "fr" ? "exposition papier" : "paper exposure"}
                    />
                  </>
                ) : (
                  <>
                    <Metric
                      value={data.health?.worker_enabled === true ? "active" : "stopped"}
                      label="workers"
                      alert={data.configured && data.health?.worker_enabled !== true}
                    />
                    <Metric
                      value={String(data.health?.worker_concurrency ?? 0)}
                      label="concurrency"
                    />
                    <Metric
                      value={data.audit?.valid === true ? "valid" : "invalid"}
                      label="audit chain"
                      alert={data.configured && data.audit?.valid !== true}
                    />
                    <Metric value={formatCount(data.audit?.checked ?? 0)} label="audited events" />
                  </>
                )}
                <Metric value={formatCount(activeRuns)} label="active missions" />
              </div>

              <p className="muted">{data.detail}</p>

              {isTrading ? null : (
                <>
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
                        onChange={(event) =>
                          setScheduleKind(event.target.value as "one_shot" | "cron")
                        }
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
                            {schedule.schedule_kind === "cron"
                              ? schedule.cron_expression
                              : "one-shot"}
                          </summary>
                          <div className="schedule-details">
                            <p className="muted">
                              Timezone: {schedule.timezone} · Next run:{" "}
                              {schedule.next_run_at === null
                                ? "none"
                                : new Date(schedule.next_run_at).toLocaleString()}
                            </p>
                            <p>
                              {schedule.mission.tasks[0]?.instruction ?? schedule.mission.title}
                            </p>
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
                                        cause instanceof Error
                                          ? cause.message
                                          : "History unavailable.",
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
                                    <td className="mono muted">
                                      {run.mission_id?.slice(0, 8) ?? "—"}
                                    </td>
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
                            head={[
                              "Step",
                              "Agent",
                              "State",
                              "Dependencies",
                              "Attempts",
                              "Duration",
                            ]}
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
                                    {task.depends_on.length === 0
                                      ? "—"
                                      : task.depends_on.join(", ")}
                                  </td>
                                  <td>{task.attempts.length}</td>
                                  <td className="muted">
                                    {first === undefined
                                      ? "—"
                                      : formatDuration(
                                          new Date(
                                            last?.finished_at ??
                                              last?.updated_at ??
                                              first.started_at,
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
                </>
              )}

              {isTrading ? (
                <>
                  <h3>
                    {locale === "fr" ? "Portefeuilles de recherche papier" : "Paper Portfolios"}
                  </h3>
                  <div className="inline-admin-form">
                    <input
                      className="field"
                      value={accountName}
                      onChange={(event) => setAccountName(event.target.value)}
                      placeholder={locale === "fr" ? "Nom du portefeuille" : "Portfolio name"}
                    />
                    <input
                      className="field"
                      value={bankroll}
                      onChange={(event) => setBankroll(event.target.value)}
                      inputMode="decimal"
                      placeholder={locale === "fr" ? "Capital EUR" : "Capital EUR"}
                    />
                    <button
                      className="button"
                      type="button"
                      onClick={() =>
                        act(() =>
                          api.createPaperAccount({
                            name: accountName.trim(),
                            bankroll_eur: bankroll,
                          }),
                        )
                      }
                    >
                      {locale === "fr" ? "Créer" : "Create"}
                    </button>
                  </div>
                  {data.accounts.length === 0 ? (
                    <Empty>
                      {locale === "fr"
                        ? "Aucun portefeuille de recherche."
                        : "No research portfolios."}
                    </Empty>
                  ) : (
                    <Table
                      head={
                        locale === "fr"
                          ? ["Nom", "Liquidités", "Exposition", "P&L Réalisé", "Mode"]
                          : ["Name", "Cash", "Exposure", "Realized P&L", "Mode"]
                      }
                    >
                      {data.accounts.map((account) => (
                        <tr key={account.id}>
                          <td>{account.name}</td>
                          <td>{(account.cash_balance_cents / 100).toFixed(2)} €</td>
                          <td>{(account.open_exposure_cents / 100).toFixed(2)} €</td>
                          <td
                            className={
                              account.realized_pnl_cents > 0
                                ? "pnl-positive"
                                : account.realized_pnl_cents < 0
                                  ? "pnl-negative"
                                  : ""
                            }
                          >
                            {(account.realized_pnl_cents / 100).toFixed(2)} €
                          </td>
                          <td>
                            <State
                              tone="ok"
                              label={locale === "fr" ? "simulation-seule" : "paper-only"}
                            />
                          </td>
                        </tr>
                      ))}
                    </Table>
                  )}

                  <h3>{locale === "fr" ? "Missions récentes" : "Recent Missions"}</h3>
                  {data.recent_runs.length === 0 ? (
                    <Empty>
                      {locale === "fr"
                        ? "Aucune mission ACP exécutée."
                        : "No ACP missions executed."}
                    </Empty>
                  ) : (
                    <Table
                      head={
                        locale === "fr"
                          ? ["Créé", "État", "Mission", "Erreur"]
                          : ["Created", "State", "Mission", "Error"]
                      }
                    >
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

                  <h3>
                    {locale === "fr" ? "Marché de recherche papier" : "Paper Research Market"}
                  </h3>
                  <div className="inline-admin-form market-form">
                    <input
                      className="field"
                      value={marketQuestion}
                      onChange={(event) => setMarketQuestion(event.target.value)}
                      placeholder={locale === "fr" ? "Question du marché" : "Market question"}
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
                      {locale === "fr" ? "Créer" : "Create"}
                    </button>
                  </div>

                  <p className="muted">
                    Creation of missions and paper portfolios uses the NEXUS administrator API. No
                    live trading paths are exposed.
                  </p>
                </>
              ) : null}
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
    <div style={{ marginTop: "12px", borderTop: "1px dashed var(--nx-line)", paddingTop: "8px" }}>
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
      {error ? <p style={{ color: "var(--nx-danger)", marginTop: "6px" }}>{error}</p> : null}

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
                      background: "var(--nx-surface)",
                      border: "1px solid var(--nx-line)",
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
                background: "var(--nx-warn-bg)",
                border: "1px solid orange",
                borderRadius: "6px",
                padding: "10px",
              }}
            >
              <h4 style={{ margin: "0 0 6px 0", color: "var(--nx-warn)", fontSize: "0.95rem" }}>
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
                      background: "var(--nx-surface)",
                      border: "1px solid var(--nx-line)",
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
        console.warn(
          "Notification config load skipped:",
          cause instanceof Error ? cause.message : cause,
        );
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
              <button type="submit" className="button primary" disabled={configSaving}>
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

  const state = useSection(() => api.logs(applied), [applied]);

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

// ─────────────────────────────────────────────────────────────────────────────
// 14. Phase 2: Marketplace (Claude Contract)
// ─────────────────────────────────────────────────────────────────────────────

export function Marketplace({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.marketplacePlugins());
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const act = (op: () => Promise<unknown>) => {
    setActionError(null);
    void op()
      .then(() => state.reload())
      .catch((err: unknown) =>
        setActionError(err instanceof Error ? err.message : "Action failed."),
      );
  };

  return (
    <div className="content">
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <div
        className="filter-bar"
        style={{ marginBottom: "16px", display: "flex", gap: "12px", alignItems: "center" }}
      >
        <input
          className="field"
          type="search"
          placeholder="Filter plugins or declared tools…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: "320px" }}
        />
      </div>
      <Section state={state}>
        {(data) => {
          const filtered = data.plugins.filter((p) => {
            if (!search) return true;
            const q = search.toLowerCase();
            return (
              p.name.toLowerCase().includes(q) ||
              p.description.toLowerCase().includes(q) ||
              p.declaredTools.some((t) => t.toLowerCase().includes(q))
            );
          });

          if (filtered.length === 0) {
            return <Empty>No marketplace plugins found.</Empty>;
          }

          return (
            <Table
              head={[
                "Plugin",
                "Publisher",
                "Version",
                "Status",
                "Declared Tools",
                "Reputation",
                "Actions",
              ]}
            >
              {filtered.map((plugin) => (
                <tr key={plugin.id}>
                  <td>
                    <strong>{plugin.name}</strong>
                    <div className="muted">{plugin.description}</div>
                  </td>
                  <td>{plugin.publisher}</td>
                  <td className="mono muted">{plugin.version}</td>
                  <td>
                    <State
                      tone={
                        plugin.status === "installed"
                          ? "ok"
                          : plugin.status === "paused"
                            ? "degraded"
                            : plugin.status === "revoked"
                              ? "revoked"
                              : "muted"
                      }
                      label={plugin.status.toUpperCase()}
                    />
                  </td>
                  <td>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                      {plugin.declaredTools.map((t) => (
                        <span
                          key={t}
                          className="badge mono"
                          style={{
                            fontSize: "0.75rem",
                            background: "var(--nx-surface-hover)",
                            padding: "2px 6px",
                            borderRadius: "4px",
                          }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    {plugin.reputationScore !== undefined
                      ? `${String(plugin.reputationScore)} / 100`
                      : "—"}
                  </td>
                  <td>
                    <div className="table-actions">
                      {plugin.status === "uninstalled" ? (
                        <button
                          className="button primary compact"
                          type="button"
                          onClick={() => act(() => api.installPlugin(plugin.id))}
                        >
                          Install
                        </button>
                      ) : null}
                      {plugin.status === "installed" ? (
                        <button
                          className="button compact"
                          type="button"
                          onClick={() => act(() => api.togglePlugin(plugin.id, true))}
                        >
                          Pause
                        </button>
                      ) : null}
                      {plugin.status === "paused" ? (
                        <button
                          className="button compact"
                          type="button"
                          onClick={() => act(() => api.togglePlugin(plugin.id, false))}
                        >
                          Resume
                        </button>
                      ) : null}
                      {plugin.status === "installed" || plugin.status === "paused" ? (
                        <button
                          className="button danger compact"
                          type="button"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Revoke plugin "${plugin.name}"? This permanently uninstalls and disables all declared tools.`,
                              )
                            ) {
                              act(() => api.revokePlugin(plugin.id));
                            }
                          }}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          );
        }}
      </Section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. Phase 2: DAG Debugger (Codex Contract)
// ─────────────────────────────────────────────────────────────────────────────

export function DagDebugger({ api }: { api: DashboardApi }) {
  const [taskId, setTaskId] = useState("task-current");
  const [queriedTaskId, setQueriedTaskId] = useState("task-current");
  const state = useSection(() => api.dagDebug(queriedTaskId), [queriedTaskId]);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = (op: () => Promise<unknown>) => {
    setActionError(null);
    void op()
      .then(() => state.reload())
      .catch((err: unknown) =>
        setActionError(err instanceof Error ? err.message : "Action failed."),
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
              Task ID to debug
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
            Inspect DAG
          </button>
        </div>
      </section>

      <Section state={state}>
        {(dag) => (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div className="metrics">
              <Metric value={dag.taskId} label="active task" />
              <Metric value={String(dag.nodes.length)} label="total DAG steps" />
              <Metric
                value={dag.isPaused ? "PAUSED" : "RUNNING"}
                label="pipeline state"
                alert={dag.isPaused}
              />
            </div>

            {dag.nodes.length === 0 ? (
              <Empty>No execution nodes found in this DAG.</Empty>
            ) : (
              <Table
                head={[
                  "Step ID",
                  "Label",
                  "Status",
                  "Dependencies",
                  "Assigned Worker",
                  "Result / Error",
                  "Actions",
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
                            Pause step
                          </button>
                        ) : null}
                        {node.status === "paused" ? (
                          <button
                            className="button compact primary"
                            type="button"
                            onClick={() => act(() => api.resumeDagStep(dag.taskId, node.id))}
                          >
                            Resume step
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

// ─────────────────────────────────────────────────────────────────────────────
// 16. Phase 2: Quota Forecast (Codex Contract)
// ─────────────────────────────────────────────────────────────────────────────

export function QuotaForecast({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.quotaForecast());

  return (
    <div className="content">
      <Section state={state}>
        {(data) =>
          data.forecasts.length === 0 ? (
            <Empty>No quota forecasts available.</Empty>
          ) : (
            <Table
              head={[
                "Provider",
                "Account",
                "Current Usage",
                "Hard Limit",
                "Burn Gauge",
                "Projected Depletion",
                "Confidence",
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
                      {f.hardLimit ? f.hardLimit.toLocaleString() : "Uncapped"}
                    </td>
                    <td>
                      {f.hardLimit ? <Bar percent={percent} /> : <span className="muted">—</span>}
                    </td>
                    <td className="muted">
                      {f.estimatedDepletionDate
                        ? new Date(f.estimatedDepletionDate).toLocaleDateString()
                        : "No exhaustion detected"}
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

// ─────────────────────────────────────────────────────────────────────────────
// 17. Phase 2: Run Comparison (Codex Contract)
// ─────────────────────────────────────────────────────────────────────────────

export function RunComparison({ api }: { api: DashboardApi }) {
  const [runA, setRunA] = useState("");
  const [runB, setRunB] = useState("");
  const [queryRuns, setQueryRuns] = useState<{ a: string; b: string } | null>(null);
  const state = useSection(
    () => (queryRuns === null ? Promise.resolve(null) : api.compareRuns(queryRuns.a, queryRuns.b)),
    [queryRuns],
  );

  return (
    <div className="content">
      <section className="card" style={{ marginBottom: "16px" }}>
        <div style={{ display: "flex", gap: "12px", alignItems: "flex-end" }}>
          <div>
            <label
              htmlFor="run-a-input"
              style={{ display: "block", marginBottom: "4px", fontSize: "0.85rem" }}
            >
              Baseline Run (A)
            </label>
            <input
              id="run-a-input"
              className="field"
              value={runA}
              onChange={(e) => setRunA(e.target.value)}
              placeholder="e.g. run-1"
            />
          </div>
          <div>
            <label
              htmlFor="run-b-input"
              style={{ display: "block", marginBottom: "4px", fontSize: "0.85rem" }}
            >
              Comparison Run (B)
            </label>
            <input
              id="run-b-input"
              className="field"
              value={runB}
              onChange={(e) => setRunB(e.target.value)}
              placeholder="e.g. run-2"
            />
          </div>
          <button
            className="button primary"
            type="button"
            disabled={runA.trim().length === 0 || runB.trim().length === 0}
            onClick={() => setQueryRuns({ a: runA, b: runB })}
          >
            Compare Runs
          </button>
        </div>
      </section>

      <Section state={state}>
        {(comparison) =>
          comparison === null ? (
            <Empty>Enter two run IDs from the Agent runs page to compare them.</Empty>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div className="metrics">
                <Metric
                  value={`${formatDuration(Math.abs(comparison.diffSummary.durationDeltaMs))}`}
                  label={`duration delta (${comparison.diffSummary.fasterRunId} faster)`}
                />
                <Metric
                  value={`${comparison.diffSummary.tokenDelta > 0 ? "+" : ""}${String(comparison.diffSummary.tokenDelta)}`}
                  label="token delta (B - A)"
                />
                <Metric value={comparison.diffSummary.cheaperRunId} label="cheaper run" />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                <section className="card">
                  <h3>Run A ({comparison.runA.id})</h3>
                  <div
                    style={{
                      marginTop: "12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                    }}
                  >
                    <div>
                      <strong>Agent:</strong> {comparison.runA.agentKey}
                    </div>
                    <div>
                      <strong>Status:</strong> {comparison.runA.status}
                    </div>
                    <div>
                      <strong>Duration:</strong> {formatDuration(comparison.runA.durationMs)}
                    </div>
                    <div>
                      <strong>Tokens:</strong> {comparison.runA.tokenCount.toLocaleString()}
                    </div>
                    <div>
                      <strong>Cost:</strong> ${comparison.runA.costEstimateUsd.toFixed(4)}
                    </div>
                    <div>
                      <strong>Steps:</strong> {String(comparison.runA.stepCount)}
                    </div>
                  </div>
                </section>

                <section className="card">
                  <h3>Run B ({comparison.runB.id})</h3>
                  <div
                    style={{
                      marginTop: "12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                    }}
                  >
                    <div>
                      <strong>Agent:</strong> {comparison.runB.agentKey}
                    </div>
                    <div>
                      <strong>Status:</strong> {comparison.runB.status}
                    </div>
                    <div>
                      <strong>Duration:</strong> {formatDuration(comparison.runB.durationMs)}
                    </div>
                    <div>
                      <strong>Tokens:</strong> {comparison.runB.tokenCount.toLocaleString()}
                    </div>
                    <div>
                      <strong>Cost:</strong> ${comparison.runB.costEstimateUsd.toFixed(4)}
                    </div>
                    <div>
                      <strong>Steps:</strong> {String(comparison.runB.stepCount)}
                    </div>
                  </div>
                </section>
              </div>
            </div>
          )
        }
      </Section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 18. Phase 2: Communication Graph (Codex Contract)
// ─────────────────────────────────────────────────────────────────────────────

export function CommunicationGraph({ api }: { api: DashboardApi }) {
  const [range, setRange] = useState("24h");
  const state = useSection(() => api.communicationGraph(range), [range]);

  return (
    <div className="content">
      <div
        className="filter-bar"
        style={{ marginBottom: "16px", display: "flex", gap: "12px", alignItems: "center" }}
      >
        <label htmlFor="comm-range" style={{ fontSize: "0.85rem" }}>
          Time window:
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
          <option value="1h">Last 1 hour</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
        </select>
      </div>

      <Section state={state}>
        {(graph) => (
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div className="metrics">
              <Metric value={String(graph.nodes.length)} label="active agents" />
              <Metric
                value={String(graph.edges.length)}
                label="inter-agent communication channels"
              />
              <Metric
                value={String(graph.edges.reduce((sum, e) => sum + e.messageCount, 0))}
                label="total messages exchanged"
              />
            </div>

            <section className="card">
              <h3>Participating Agents</h3>
              <div style={{ marginTop: "12px" }}>
                {graph.nodes.length === 0 ? (
                  <Empty>No agents active in this time window.</Empty>
                ) : (
                  <Table head={["Agent Name", "Role", "Message Activity"]}>
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
              <h3>Inter-Agent Channels & Latencies</h3>
              <div style={{ marginTop: "12px" }}>
                {graph.edges.length === 0 ? (
                  <Empty>No message channels detected in this window.</Empty>
                ) : (
                  <Table
                    head={[
                      "Sender (Source)",
                      "Receiver (Target)",
                      "Messages Sent",
                      "Avg Round-trip Latency",
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

// ─────────────────────────────────────────────────────────────────────────────
// 19. Phase 2: Visual Control (Claude Contract)
// ─────────────────────────────────────────────────────────────────────────────

export function VisualControl({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.visualControlStatus());
  const [actionError, setActionError] = useState<string | null>(null);

  const act = (op: () => Promise<unknown>) => {
    setActionError(null);
    void op()
      .then(() => state.reload())
      .catch((err: unknown) =>
        setActionError(err instanceof Error ? err.message : "Action failed."),
      );
  };

  return (
    <div className="content">
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <Section state={state}>
        {(vc) => (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div className="metrics">
              <Metric
                value={vc.active ? "ACTIVE" : "IDLE"}
                label="automation session"
                alert={vc.active && vc.paused}
              />
              <Metric
                value={vc.paused ? "PAUSED" : "RUNNING"}
                label="execution state"
                alert={vc.paused}
              />
              <Metric
                value={`${String(vc.bounds.width)} × ${String(vc.bounds.height)}`}
                label="viewport resolution"
              />
            </div>

            <section className="card">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div>
                  <h3>Remote Viewport & Safety Monitor</h3>
                  <p className="muted">
                    Active Session: <span className="mono">{vc.activeSessionId ?? "None"}</span>
                  </p>
                </div>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <State
                    tone={vc.safetyBoundaryEnforced ? "ok" : "down"}
                    label={vc.safetyBoundaryEnforced ? "SAFETY BOUNDARY ENFORCED" : "UNRESTRICTED"}
                  />
                  <button
                    className={`button ${vc.paused ? "primary" : "danger"}`}
                    type="button"
                    onClick={() => act(() => api.toggleVisualControlPause(!vc.paused))}
                  >
                    {vc.paused ? "Resume Session" : "Pause Session (Emergency Stop)"}
                  </button>
                </div>
              </div>

              <div
                style={{
                  marginTop: "16px",
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  minHeight: "240px",
                  background: "var(--nx-canvas-sunken)",
                  borderRadius: "8px",
                  border: "1px dashed var(--nx-line-strong)",
                }}
              >
                {vc.lastScreenshotUrl ? (
                  <img
                    src={vc.lastScreenshotUrl}
                    alt="Live visual control preview"
                    style={{ maxWidth: "100%", maxHeight: "400px", borderRadius: "4px" }}
                  />
                ) : (
                  <div className="muted" style={{ textAlign: "center" }}>
                    <span>
                      No active frame capture. Remote viewport is waiting for agent interactions.
                    </span>
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </Section>
    </div>
  );
}
