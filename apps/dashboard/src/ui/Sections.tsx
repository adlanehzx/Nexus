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
import { Futuristic3DCanvas } from "./Futuristic3DCanvas.js";
import { Futuristic3DCard } from "./Futuristic3DCard.js";

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
  const { tr } = useI18n();
  const state = useSection(() => api.overview());

  return (
    <div className="content">
      <Section state={state}>
        {(data) => (
          <>
            {/* 3D Holographic AI Core & Real-time HUD */}
            <div className="cyber-core-hero cyber-reticle">
              <div className="cyber-core-canvas-container">
                <Futuristic3DCanvas />
                <div className="cyber-core-overlay">
                  <div className="cyber-hud-column">
                    <div className="cyber-hud-stat">
                      <div className="cyber-hud-stat-label">
                        <span className="radar-pulse-ring" />
                        {tr("Active Neural Mesh", "Réseau Neural Actif")}
                      </div>
                      <div className="cyber-hud-stat-value">
                        {formatCount(data.workers.connected)}{" "}
                        {tr("Workers Connected", "Agents Connectés")}
                      </div>
                    </div>
                    <div className="cyber-hud-stat">
                      <div className="cyber-hud-stat-label">
                        <span className="system-dot" />
                        {tr("Work Queue Flow", "Flux des Tâches")}
                      </div>
                      <div className="cyber-hud-stat-value">
                        {formatCount(data.tasks.running)} {tr("Running Tasks", "Tâches en Cours")}
                      </div>
                    </div>
                  </div>

                  <div
                    className="cyber-hud-column"
                    style={{ alignItems: "flex-end", textAlign: "right" }}
                  >
                    <div className="cyber-hud-stat">
                      <div className="cyber-hud-stat-label" style={{ justifyContent: "flex-end" }}>
                        <div className="hud-audio-bars">
                          <span className="hud-audio-bar" />
                          <span className="hud-audio-bar" />
                          <span className="hud-audio-bar" />
                          <span className="hud-audio-bar" />
                          <span className="hud-audio-bar" />
                        </div>
                        {tr("Singularity Core", "Cœur de Singularité")}
                      </div>
                      <div className="cyber-hud-stat-value">
                        {overallHealth(data.health) === "down"
                          ? tr("DEGRADED", "DÉGRADÉ")
                          : tr("OPERATIONAL 100%", "OPÉRATIONNEL 100%")}
                      </div>
                    </div>
                    <div className="cyber-hud-stat">
                      <div className="cyber-hud-stat-label" style={{ justifyContent: "flex-end" }}>
                        {tr("Security Grid", "Grille de Sécurité")}
                      </div>
                      <div className="cyber-hud-stat-value">
                        {tr("SHIELD ACTIVE", "BOUCLIER ACTIF")}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="metrics">
              <Futuristic3DCard>
                <Metric
                  value={formatCount(data.devices.online)}
                  label={tr("online devices", "appareils en ligne")}
                />
              </Futuristic3DCard>
              <Futuristic3DCard>
                <Metric
                  value={formatCount(data.workers.connected)}
                  label={tr("connected workers", "agents connectés")}
                />
              </Futuristic3DCard>
              <Futuristic3DCard>
                <Metric
                  value={formatCount(data.tasks.running)}
                  label={tr("running tasks", "tâches en cours")}
                />
              </Futuristic3DCard>
              <Futuristic3DCard>
                <Metric
                  value={formatCount(data.tasks.failed)}
                  label={tr("failed tasks", "tâches échouées")}
                  alert={data.tasks.failed > 0}
                />
              </Futuristic3DCard>
              <Futuristic3DCard>
                <Metric
                  value={formatCount(data.agentRuns.running)}
                  label={tr("active agent runs", "exécutions actives")}
                />
              </Futuristic3DCard>
              <Futuristic3DCard>
                <Metric
                  value={formatCount(data.agentRuns.waitingForConfirmation)}
                  label={tr("pending confirmation", "en attente de confirmation")}
                  alert={data.agentRuns.waitingForConfirmation > 0}
                />
              </Futuristic3DCard>
              <Futuristic3DCard>
                <Metric
                  value={formatCount(data.notifications.unread)}
                  label={tr("unread alerts", "alertes non lues")}
                />
              </Futuristic3DCard>
              <Futuristic3DCard>
                <Metric
                  value={tr(
                    HEALTH_LABELS[levelOf(overallHealth(data.health))],
                    HEALTH_LABELS[levelOf(overallHealth(data.health))] === "healthy"
                      ? "sain"
                      : HEALTH_LABELS[levelOf(overallHealth(data.health))] === "degraded"
                        ? "dégradé"
                        : HEALTH_LABELS[levelOf(overallHealth(data.health))] === "down"
                          ? "hors service"
                          : "non configuré",
                  )}
                  label={tr("overall health", "santé globale")}
                  alert={overallHealth(data.health) === "down"}
                />
              </Futuristic3DCard>
            </div>

            <h3>{tr("Subsystem Health", "Santé des Sous-systèmes")}</h3>
            <Table
              head={[tr("Subsystem", "Sous-système"), tr("State", "État"), tr("Detail", "Détail")]}
            >
              {data.health.map((entry) => (
                <tr key={entry.name}>
                  <td>{entry.name}</td>
                  <td>
                    <State
                      tone={entry.level}
                      label={tr(
                        HEALTH_LABELS[entry.level],
                        entry.level === "ok"
                          ? "opérationnel"
                          : entry.level === "degraded"
                            ? "dégradé"
                            : entry.level === "down"
                              ? "hors service"
                              : "non configuré",
                      )}
                    />
                  </td>
                  <td className="muted">{entry.detail}</td>
                </tr>
              ))}
            </Table>

            <h3>{tr("Recent Activity", "Activité Récente")}</h3>
            {data.recentActivity.length === 0 ? (
              <Empty>{tr("Nothing to report.", "Rien à signaler.")}</Empty>
            ) : (
              <Table head={[tr("When", "Quand"), tr("Source", "Source"), tr("Event", "Événement")]}>
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
  const { tr } = useI18n();
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
            <span className="eyebrow">{tr("PRIVATE NETWORK", "RÉSEAU PRIVÉ")}</span>
            <h3 id="private-network-title">
              {tr("Automatic device discovery", "Découverte automatique d'appareils")}
            </h3>
            <p className="muted">
              {tr(
                "NEXUS detects machines visible through Tailscale. Discovery never grants trust: pairing and approval remain explicit security boundaries.",
                "NEXUS détecte les machines visibles via Tailscale. La découverte n'accorde jamais de confiance : le jumelage et l'approbation restent des limites de sécurité explicites.",
              )}
            </p>
          </div>
          <button className="button" type="button" onClick={() => network.reload()}>
            {tr("Refresh network", "Actualiser le réseau")}
          </button>
        </div>
        <Section state={network}>
          {(data) => (
            <>
              <div className="network-summary">
                <State
                  tone={data.running ? "ok" : data.installed ? "degraded" : "unconfigured"}
                  label={
                    data.running
                      ? tr("TAILSCALE CONNECTED", "TAILSCALE CONNECTÉ")
                      : data.backendState.toUpperCase()
                  }
                />
                <div>
                  <strong>{data.self?.name ?? tr("NEXUS host", "Hôte NEXUS")}</strong>
                  <span className="muted">{data.suggestedApiUrl ?? data.guidance}</span>
                </div>
                {data.automaticPairingUrl ? (
                  <span className="network-auto-badge">
                    {tr(
                      "Pairing address managed automatically",
                      "Adresse de jumelage gérée automatiquement",
                    )}
                  </span>
                ) : null}
              </div>
              {data.peers.length === 0 ? (
                <Empty>
                  {tr(
                    "No other Tailscale devices detected.",
                    "Aucun autre appareil Tailscale détecté.",
                  )}
                </Empty>
              ) : (
                <div className="network-peer-grid">
                  {data.peers.map((peer) => (
                    <article className="network-peer" key={peer.id}>
                      <div>
                        <strong>{peer.name}</strong>
                        <span className="muted">
                          {peer.os} ·{" "}
                          {peer.online ? tr("online", "en ligne") : tr("offline", "hors ligne")}
                        </span>
                      </div>
                      <State
                        tone={peer.online ? "ok" : "unconfigured"}
                        label={
                          peer.online ? tr("REACHABLE", "ACCESSIBLE") : tr("OFFLINE", "HORS LIGNE")
                        }
                      />
                      <button
                        className="button primary"
                        type="button"
                        disabled={!peer.online || pairingBusy}
                        onClick={() => issuePairing(peer.name)}
                      >
                        {tr("Pair with NEXUS", "Jumeler avec NEXUS")}
                      </button>
                    </article>
                  ))}
                </div>
              )}
              <p className="muted network-security-note">
                {tr(
                  "A discovered device cannot execute tasks or access NEXUS data until its client uses a single-use pairing ticket and you approve it.",
                  "Un appareil découvert ne peut pas exécuter de tâches ni accéder aux données NEXUS tant que son client n'utilise pas un ticket de jumelage à usage unique et que vous ne l'approuvez pas.",
                )}
              </p>
            </>
          )}
        </Section>
      </section>
      <section className="card pairing-card" aria-labelledby="pairing-title">
        <div className="pairing-heading">
          <div>
            <span className="eyebrow">{tr("NEW WORKER", "NOUVEL AGENT")}</span>
            <h3 id="pairing-title">{tr("Add machine", "Ajouter une machine")}</h3>
            <p className="muted">
              {tr(
                "The code expires after five minutes and can only be used once. The machine will remain pending until approved below.",
                "Le code expire après cinq minutes et ne peut être utilisé qu'une seule fois. La machine restera en attente jusqu'à approbation ci-dessous.",
              )}
            </p>
          </div>
          <div className="pairing-create">
            <label htmlFor="pairing-label">{tr("Expected name", "Nom attendu")}</label>
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
              {pairingBusy ? tr("Creating…", "Création…") : tr("Generate code", "Générer le code")}
            </button>
          </div>
        </div>
        {pairing === null || windowsCommand === null || linuxCommand === null ? (
          <div className="pairing-platforms">
            <div>
              <strong>Windows</strong>
              <span>
                {tr("Installer + automatic service", "Installateur + service automatique")}
              </span>
            </div>
            <div>
              <strong>Android worker</strong>
              <span>{tr("NEXUS APK then pairing link", "APK NEXUS puis lien de jumelage")}</span>
            </div>
            <div>
              <strong>iOS client</strong>
              <span>{tr("NEXUS app then connection", "Application NEXUS puis connexion")}</span>
            </div>
            <div>
              <strong>Linux / NAS / Raspberry Pi</strong>
              <span>
                {tr(
                  "Isolated Docker image, amd64 and arm64",
                  "Image Docker isolée, amd64 et arm64",
                )}
              </span>
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
                  {tr("Scan with NEXUS mobile app", "Scanner avec l'application mobile NEXUS")}
                </span>
              </div>
            ) : null}
            <strong>
              {tr(
                "Windows (run in Administrator PowerShell — secret piped via stdin):",
                "Windows (exécuter dans PowerShell Administrateur — secret injecté via stdin) :",
              )}
            </strong>
            <code>{windowsCommand}</code>
            <strong>
              {tr(
                "Linux / Docker (secret piped via stdin):",
                "Linux / Docker (secret injecté via stdin) :",
              )}
            </strong>
            <code>{linuxCommand}</code>
            <div className="table-actions">
              <button
                className="button"
                type="button"
                onClick={() => void navigator.clipboard.writeText(windowsCommand)}
              >
                {tr("Copy Windows command", "Copier commande Windows")}
              </button>
              <button
                className="button"
                type="button"
                onClick={() => void navigator.clipboard.writeText(pairing.payload)}
              >
                {tr("Copy pairing link", "Copier lien de jumelage")}
              </button>
              <button
                className="button"
                type="button"
                onClick={() => void navigator.clipboard.writeText(linuxCommand)}
              >
                {tr("Copy Linux command", "Copier commande Linux")}
              </button>
              <button className="button" type="button" onClick={() => setPairing(null)}>
                {tr("Hide code", "Masquer le code")}
              </button>
            </div>
            <div className="callout info network-managed-note">
              <strong>{tr("Private connectivity:", "Connectivité privée :")}</strong>{" "}
              {tr(
                "NEXUS automatically uses the host Tailscale address when no explicit public API address is configured. No tailnet key is read or stored.",
                "NEXUS utilise automatiquement l'adresse Tailscale de l'hôte lorsqu'aucune adresse d'API publique explicite n'est configurée. Aucune clé tailnet n'est lue ni stockée.",
              )}
            </div>
            <small style={{ display: "block", marginTop: "8px" }}>
              {tr("Expires at", "Expire à")} {new Date(pairing.expiresAt).toLocaleTimeString()}.{" "}
              {tr("Single-use ticket.", "Ticket à usage unique.")}
            </small>
          </div>
        )}
      </section>
      <Section state={state}>
        {(data) =>
          data.devices.length === 0 ? (
            <Empty>{tr("No paired devices.", "Aucun appareil jumelé.")}</Empty>
          ) : (
            <Table
              head={[
                tr("Device", "Appareil"),
                tr("Role", "Rôle"),
                tr("Platform", "Plateforme"),
                tr("Status", "Statut"),
                tr("Trust", "Confiance"),
                tr("Capabilities", "Capacités"),
                tr("Last Heartbeat", "Dernier signal"),
                tr("Health", "Santé"),
                tr("Permissions", "Permissions"),
                tr("Actions", "Actions"),
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
                              {tr("Pause all", "Tout suspendre")}
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
                              {tr("Save", "Enregistrer")}
                            </button>
                            <button
                              className="button"
                              type="button"
                              onClick={() => setEditingCapabilitiesDeviceId(null)}
                            >
                              {tr("Cancel", "Annuler")}
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
                      {device.health.activeTasks}/{device.health.maxConcurrentTasks}{" "}
                      {tr("task(s)", "tâche(s)")}
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
                            <strong style={{ fontSize: "0.75rem", width: "100%" }}>
                              {tr("Presets:", "Préréglages :")}
                            </strong>
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
                              placeholder={tr(
                                "Custom (e.g. sensor.custom)",
                                "Personnalisé (ex: sensor.custom)",
                              )}
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
                              {tr("Add", "Ajouter")}
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
                              {tr("Save", "Enregistrer")}
                            </button>
                            <button
                              className="button compact"
                              type="button"
                              onClick={() => setEditingPermissionsDeviceId(null)}
                            >
                              {tr("Cancel", "Annuler")}
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
                            {tr("Approve", "Approuver")}
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
                              {isEditingCapabilities
                                ? tr("Close", "Fermer")
                                : tr("Capabilities", "Capacités")}
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
                              {isEditingPermissions
                                ? tr("Close", "Fermer")
                                : tr("Permissions", "Permissions")}
                            </button>
                            {device.status === "ONLINE" ? (
                              <button
                                className="button"
                                type="button"
                                onClick={() => act(() => api.disconnectDevice(device.id))}
                              >
                                {tr("Disconnect", "Déconnecter")}
                              </button>
                            ) : null}
                            <button
                              className="button danger"
                              type="button"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    tr(
                                      `Permanently revoke ${device.name}? All active sessions will terminate and credentials will be destroyed.`,
                                      `Révoquer définitivement ${device.name} ? Toutes les sessions actives se termineront et les identifiants seront détruits.`,
                                    ),
                                  )
                                )
                                  act(() => api.revokeDevice(device.id));
                              }}
                            >
                              {tr("Revoke", "Révoquer")}
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

// ─────────────────────────────────────────────────────────────────────────────
// 4. Tasks
// ─────────────────────────────────────────────────────────────────────────────

export function Tasks({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.tasks());
  const [selected, setSelected] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <div className="content">
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

// ─────────────────────────────────────────────────────────────────────────────
// 5. Agent Runs
// ─────────────────────────────────────────────────────────────────────────────

export function Runs({ api }: { api: DashboardApi }) {
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
    <div className="content">
      <p className="muted" style={{ marginTop: 0 }}>
        {tr(
          "Status, actions, tools, progress, results, errors, and metrics. The model's reasoning is not exposed — the server does not transmit it.",
          "Statut, actions, outils, progression, résultats, erreurs et métriques. Le raisonnement interne n'est pas exposé — le serveur ne le transmet pas.",
        )}
      </p>

      <Section state={observability}>
        {(summary) => (
          <>
            <div className="metrics">
              <Metric
                value={formatCount(summary.totals.runs)}
                label={tr("analyzed runs", "exécutions analysées")}
              />
              <Metric
                value={asPercent(summary.rates.fallback)}
                label={tr("fallback rate", "taux de secours")}
              />
              <Metric
                value={asPercent(summary.rates.toolError)}
                label={tr("tool errors", "erreurs d'outils")}
                alert={summary.rates.toolError > 0.1}
              />
              <Metric
                value={asPercent(summary.rates.runError)}
                label={tr("failed runs", "exécutions échouées")}
              />
              <Metric
                value={formatEstimatedCost(summary.totals.estimatedApiEquivalentCostUsd)}
                label={tr("equivalent API cost", "coût API équivalent")}
              />
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
  return cost === null ? "not configured" : `${cost.toFixed(4)} $`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Tools
// ─────────────────────────────────────────────────────────────────────────────

export function Tools({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.tools());

  return (
    <div className="content">
      <Section state={state}>
        {(data) =>
          data.tools.length === 0 ? (
            <Empty>
              {tr(
                "No registered tools. The catalog populates when the agent service starts.",
                "Aucun outil enregistré. Le catalogue se remplit au démarrage du service d'agent.",
              )}
            </Empty>
          ) : (
            <Table
              head={[
                tr("Tool", "Outil"),
                tr("Source", "Source"),
                tr("Description", "Description"),
                tr("Risk", "Risque"),
                tr("Permissions", "Permissions"),
                tr("Allowed", "Autorisé"),
              ]}
            >
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
                      label={tool.allowed ? tr("yes", "oui") : tr("no", "non")}
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
  const { tr } = useI18n();
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
        setActionError(
          cause instanceof Error ? cause.message : tr("Action failed.", "Échec de l'action."),
        ),
      );
  };

  const save = (): void => {
    let refs: Record<string, string>;
    try {
      refs = secretRefs.trim() === "" ? {} : (JSON.parse(secretRefs) as Record<string, string>);
    } catch {
      setActionError(
        tr(
          "Secret references must be a JSON object.",
          "Les références de secrets doivent être un objet JSON.",
        ),
      );
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
    act(
      () => api.saveMcp(config),
      tr(`Server ${name} saved and connected.`, `Serveur ${name} enregistré et connecté.`),
    );
  };

  return (
    <div className="content">
      {message === null ? null : <p className="banner success">{message}</p>}
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <section className="settings-panel">
        <h3>{tr("Add or Replace an MCP Server", "Ajouter ou remplacer un serveur MCP")}</h3>
        <div className="settings-grid">
          <label>
            {tr("Name", "Nom")}
            <input
              className="field mono"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="filesystem"
            />
          </label>
          <label>
            {tr("Transport", "Transport")}
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
            {transport === "stdio" ? tr("Command", "Commande") : "URL"}
            <input
              className="field mono"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={transport === "stdio" ? "npx" : "https://…"}
            />
          </label>
          {transport === "stdio" ? (
            <label className="settings-wide">
              {tr("Arguments · one per line", "Arguments · un par ligne")}
              <textarea
                className="field mono"
                rows={3}
                value={args}
                onChange={(event) => setArgs(event.target.value)}
              />
            </label>
          ) : null}
          <label className="settings-wide">
            {transport === "stdio" ? "envRefs" : "headerRefs"} ·{" "}
            {tr("JSON to vault://nexus/…", "JSON vers vault://nexus/…")}
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
            {tr("Save and connect", "Enregistrer et connecter")}
          </button>
        </div>
      </section>
      <Section state={state}>
        {(data) =>
          data.configurations.length === 0 ? (
            <Empty>{tr("No MCP servers configured.", "Aucun serveur MCP configuré.")}</Empty>
          ) : (
            <Table
              head={[
                tr("Server", "Serveur"),
                tr("State", "État"),
                tr("Tools", "Outils"),
                tr("Failures", "Échecs"),
                tr("Reconnects", "Reconnexions"),
                tr("Circuit", "Disjoncteur"),
                tr("Last error", "Dernière erreur"),
                tr("Actions", "Actions"),
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
                      ? tr("closed", "fermé")
                      : `${tr("open until", "ouvert jusqu'à")} ${server.circuitOpenUntil}`}
                  </td>
                  <td className="muted">{server.lastError ?? "—"}</td>
                  <td>
                    <button
                      className="button compact"
                      type="button"
                      onClick={() =>
                        act(
                          () => api.reconnectMcp(server.name),
                          tr(`${server.name} reconnected.`, `${server.name} reconnecté.`),
                        )
                      }
                    >
                      {tr("Reconnect", "Reconnecter")}
                    </button>{" "}
                    <button
                      className="button compact danger"
                      type="button"
                      onClick={() => {
                        if (
                          window.confirm(
                            tr(
                              `Delete server ${server.name}?`,
                              `Supprimer le serveur ${server.name} ?`,
                            ),
                          )
                        )
                          act(
                            () => api.removeMcp(server.name),
                            tr(`${server.name} deleted.`, `${server.name} supprimé.`),
                          );
                      }}
                    >
                      {tr("Delete", "Supprimer")}
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
  const { tr } = useI18n();
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
        setActionError(
          cause instanceof Error ? cause.message : tr("Action failed.", "Échec de l'action."),
        ),
      );
  };

  return (
    <div className="content">
      {message === null ? null : <p className="banner success">{message}</p>}
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <section className="settings-panel">
        <h3>{tr("Configure Browser Use", "Configurer Browser Use")}</h3>
        <p className="muted">
          {tr(
            "Local mode uses the official harness with Codex or Claude as the brain. It requires no API keys and maintains a separate NEXUS Chromium profile.",
            "Le mode local utilise le banc officiel avec Codex ou Claude comme cerveau. Il ne requiert aucune clé d'API et maintient un profil Chromium NEXUS séparé.",
          )}
        </p>
        <div className="settings-grid">
          <label className="settings-wide">
            {tr("Mode", "Mode")}
            <select
              className="field"
              value={mode}
              onChange={(event) => setMode(event.target.value as "local-harness" | "remote-worker")}
            >
              <option value="local-harness">
                {tr("Local browser — no API key", "Navigateur local — sans clé API")}
              </option>
              <option value="remote-worker">
                {tr(
                  "Autonomous worker — LLM provider required",
                  "Agent autonome — fournisseur LLM requis",
                )}
              </option>
            </select>
          </label>
          {mode === "local-harness" ? (
            <label className="settings-wide">
              {tr("Local CDP URL", "URL CDP locale")}
              <input
                className="field mono"
                value={cdpUrl}
                onChange={(event) => setCdpUrl(event.target.value)}
              />
            </label>
          ) : (
            <>
              <label className="settings-wide">
                {tr("Worker URL", "URL de l'agent")}
                <input
                  className="field mono"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </label>
              <label className="settings-wide">
                {tr("Token reference", "Référence du jeton")}
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
            {tr("Enable Browser Use", "Activer Browser Use")}
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
                tr("Browser configuration saved.", "Configuration du navigateur enregistrée."),
              )
            }
          >
            {tr("Save", "Enregistrer")}
          </button>
          <button
            className="button"
            type="button"
            onClick={() =>
              act(
                () => api.testBrowser(),
                tr("Browser worker reachable.", "Agent de navigation accessible."),
              )
            }
          >
            {tr("Test", "Tester")}
          </button>
        </div>
      </section>
      <Section state={state}>
        {(data) => (
          <>
            <div className="metrics">
              <Metric
                value={data.configured ? tr("yes", "oui") : tr("no", "non")}
                label={tr("configured", "configuré")}
              />
              <Metric
                value={data.reachable ? tr("ready", "prêt") : tr("unreachable", "inaccessible")}
                label={tr("browser", "navigateur")}
                alert={data.configured && !data.reachable}
              />
            </div>

            <p className="muted">{data.detail}</p>
            {data.configuration?.mode === "remote-worker" ? (
              <p className="muted">
                {tr("Secret:", "Secret :")}{" "}
                {data.tokenConfigured
                  ? tr("present in keyring", "présent dans le trousseau")
                  : tr("missing", "manquant")}
              </p>
            ) : null}

            {data.health === null ? null : (
              <>
                <h3>{tr("Reported Health", "Santé Rapportée")}</h3>
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
  const { tr } = useI18n();
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
        setActionError(
          cause instanceof Error ? cause.message : tr("Action failed.", "Échec de l'action."),
        ),
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
                      {tr(
                        "Simulation & Research — No Real Money",
                        "Simulation & Recherche — Aucun fonds réel",
                      )}
                    </strong>
                    <p className="muted" style={{ margin: "4px 0 0" }}>
                      {tr(
                        "Creation of missions and paper portfolios uses the NEXUS administrator API. No live trading paths are exposed.",
                        "La création de missions et de portefeuilles de recherche utilise l'API administrateur NEXUS. Aucune route d'exécution financière réelle n'est exposée.",
                      )}
                    </p>
                  </div>
                </div>
              ) : null}

              <div className="metrics">
                <Metric
                  value={data.configured ? tr("yes", "oui") : tr("no", "non")}
                  label={tr("configured", "configuré")}
                />
                <Metric
                  value={
                    data.reachable
                      ? tr("reachable", "accessible")
                      : tr("unreachable", "inaccessible")
                  }
                  label={tr("ACP engine", "moteur ACP")}
                  alert={data.configured && !data.reachable}
                />
                {isTrading ? (
                  <>
                    <Metric
                      value={`${(cash / 100).toFixed(2)} €`}
                      label={tr("paper cash", "liquidités papier")}
                    />
                    <Metric
                      value={`${(exposure / 100).toFixed(2)} €`}
                      label={tr("paper exposure", "exposition papier")}
                    />
                  </>
                ) : (
                  <>
                    <Metric
                      value={
                        data.health?.worker_enabled === true
                          ? tr("active", "actif")
                          : tr("stopped", "arrêté")
                      }
                      label={tr("workers", "agents")}
                      alert={data.configured && data.health?.worker_enabled !== true}
                    />
                    <Metric
                      value={String(data.health?.worker_concurrency ?? 0)}
                      label={tr("concurrency", "concurrence")}
                    />
                    <Metric
                      value={
                        data.audit?.valid === true
                          ? tr("valid", "valide")
                          : tr("invalid", "invalide")
                      }
                      label={tr("audit chain", "chaîne d'audit")}
                      alert={data.configured && data.audit?.valid !== true}
                    />
                    <Metric
                      value={formatCount(data.audit?.checked ?? 0)}
                      label={tr("audited events", "événements audités")}
                    />
                  </>
                )}
                <Metric
                  value={formatCount(activeRuns)}
                  label={tr("active missions", "missions actives")}
                />
              </div>

              <p className="muted">{data.detail}</p>

              {isTrading ? null : (
                <>
                  <h3>{tr("NEXUS · ACP profiles", "NEXUS · Profils ACP")}</h3>
                  <p className="mono muted">
                    {data.health === null || data.health.profiles.length === 0
                      ? tr("none", "aucun")
                      : data.health.profiles.join(", ")}
                  </p>

                  <h3>{tr("Autonomous Schedules", "Planifications Autonomes")}</h3>
                  <div className="admin-form-card schedule-form-card">
                    <div className="inline-admin-form schedule-form">
                      <input
                        className="field"
                        value={scheduleName}
                        onChange={(event) => setScheduleName(event.target.value)}
                        placeholder={tr("Schedule name", "Nom de la planification")}
                      />
                      <select
                        className="field"
                        value={scheduleKind}
                        onChange={(event) =>
                          setScheduleKind(event.target.value as "one_shot" | "cron")
                        }
                      >
                        <option value="cron">{tr("Recurring · cron", "Récurrent · cron")}</option>
                        <option value="one_shot">{tr("One-shot", "Ponctuel")}</option>
                      </select>
                      <select
                        className="field"
                        value={scheduleProfile}
                        onChange={(event) => setScheduleProfile(event.target.value)}
                      >
                        <option value="">
                          {tr(
                            "Automatically select first profile",
                            "Sélectionner automatiquement le premier profil",
                          )}
                        </option>
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
                        <option value="skip">
                          {tr("Skip missed occurrences", "Ignorer occurrences manquées")}
                        </option>
                        <option value="latest">
                          {tr(
                            "Catch up latest occurrence only",
                            "Rattraper la dernière occurrence uniquement",
                          )}
                        </option>
                        <option value="all">
                          {tr(
                            "Catch up all missed occurrences",
                            "Rattraper toutes les occurrences manquées",
                          )}
                        </option>
                      </select>
                    </div>
                    <textarea
                      className="field schedule-instruction"
                      value={scheduleInstruction}
                      onChange={(event) => setScheduleInstruction(event.target.value)}
                      placeholder={tr(
                        "Mission to execute automatically",
                        "Mission à exécuter automatiquement",
                      )}
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
                      {tr("Create schedule", "Créer la planification")}
                    </button>
                    {data.health?.scheduler_enabled === true ? null : (
                      <p className="muted">
                        {tr(
                          "Schedule dispatcher is disabled.",
                          "Le répartiteur de planification est désactivé.",
                        )}
                      </p>
                    )}
                  </div>

                  {data.schedules.length === 0 ? (
                    <Empty>
                      {tr("No schedules for this account.", "Aucune planification pour ce compte.")}
                    </Empty>
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
                              {tr("Timezone:", "Fuseau horaire :")} {schedule.timezone} ·{" "}
                              {tr("Next run:", "Prochaine exécution :")}{" "}
                              {schedule.next_run_at === null
                                ? tr("none", "aucune")
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
                                  {tr("Pause", "Suspendre")}
                                </button>
                              ) : schedule.state === "paused" ? (
                                <button
                                  className="button compact"
                                  type="button"
                                  onClick={() => act(() => api.resumeSchedule(schedule.id))}
                                >
                                  {tr("Resume", "Reprendre")}
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
                                          : tr("History unavailable.", "Historique indisponible."),
                                      ),
                                    );
                                }}
                              >
                                {tr("Load history", "Charger l'historique")}
                              </button>
                            </div>
                            {scheduleHistory[schedule.id] === undefined ? null : scheduleHistory[
                                schedule.id
                              ]?.length === 0 ? (
                              <p className="muted">
                                {tr("No occurrences executed.", "Aucune occurrence exécutée.")}
                              </p>
                            ) : (
                              <Table
                                head={[
                                  tr("Scheduled", "Planifié"),
                                  tr("State", "État"),
                                  tr("Mission", "Mission"),
                                  tr("Error", "Erreur"),
                                ]}
                              >
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

                  <h3>{tr("Unified Mission Timeline", "Chronologie Unifiée des Missions")}</h3>
                  {data.missions.length === 0 ? (
                    <Empty>
                      {tr(
                        "No NEXUS ACP missions for this account.",
                        "Aucune mission ACP NEXUS pour ce compte.",
                      )}
                    </Empty>
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
                            {mission.title} · {mission.tasks.length} {tr("step(s)", "étape(s)")} ·{" "}
                            {formatAge(mission.created_at)}
                          </summary>
                          <Table
                            head={[
                              tr("Step", "Étape"),
                              tr("Agent", "Agent"),
                              tr("State", "État"),
                              tr("Dependencies", "Dépendances"),
                              tr("Attempts", "Tentatives"),
                              tr("Duration", "Durée"),
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
                  <h3>{tr("Paper Portfolios", "Portefeuilles de recherche papier")}</h3>
                  <div className="inline-admin-form">
                    <input
                      className="field"
                      value={accountName}
                      onChange={(event) => setAccountName(event.target.value)}
                      placeholder={tr("Portfolio name", "Nom du portefeuille")}
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
                          api.createPaperAccount({
                            name: accountName.trim(),
                            bankroll_eur: bankroll,
                          }),
                        )
                      }
                    >
                      {tr("Create", "Créer")}
                    </button>
                  </div>
                  {data.accounts.length === 0 ? (
                    <Empty>
                      {tr("No research portfolios.", "Aucun portefeuille de recherche.")}
                    </Empty>
                  ) : (
                    <Table
                      head={[
                        tr("Name", "Nom"),
                        tr("Cash", "Liquidités"),
                        tr("Exposure", "Exposition"),
                        tr("Realized P&L", "P&L Réalisé"),
                        tr("Mode", "Mode"),
                      ]}
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
                            <State tone="ok" label={tr("paper-only", "simulation-seule")} />
                          </td>
                        </tr>
                      ))}
                    </Table>
                  )}

                  <h3>{tr("Recent Missions", "Missions récentes")}</h3>
                  {data.recent_runs.length === 0 ? (
                    <Empty>{tr("No ACP missions executed.", "Aucune mission ACP exécutée.")}</Empty>
                  ) : (
                    <Table
                      head={[
                        tr("Created", "Créé"),
                        tr("State", "État"),
                        tr("Mission", "Mission"),
                        tr("Error", "Erreur"),
                      ]}
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

                  <h3>{tr("Paper Research Market", "Marché de recherche papier")}</h3>
                  <div className="inline-admin-form market-form">
                    <input
                      className="field"
                      value={marketQuestion}
                      onChange={(event) => setMarketQuestion(event.target.value)}
                      placeholder={tr("Market question", "Question du marché")}
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
                      {tr("Create", "Créer")}
                    </button>
                  </div>

                  <p className="muted">
                    {tr(
                      "Creation of missions and paper portfolios uses the NEXUS administrator API. No live trading paths are exposed.",
                      "La création de missions et de portefeuilles de recherche utilise l'API administrateur NEXUS. Aucune route d'exécution financière réelle n'est exposée.",
                    )}
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
  const { tr } = useI18n();
  const state = useSection(() => api.memory());
  const [content, setContent] = useState("");
  const [layer, setLayer] = useState<"LONG_TERM" | "PREFERENCE">("LONG_TERM");
  const [tags, setTags] = useState("");
  const [acknowledgedSensitive, setAcknowledgedSensitive] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <div className="content">
      <div className="admin-form-card">
        <h3>{tr("Add Memory", "Ajouter une Mémoire")}</h3>
        <div className="inline-admin-form memory-form">
          <input
            className="field"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={tr("What NEXUS should remember", "Ce dont NEXUS doit se souvenir")}
          />
          <select
            className="field"
            value={layer}
            onChange={(event) => setLayer(event.target.value as "LONG_TERM" | "PREFERENCE")}
          >
            <option value="LONG_TERM">{tr("Long-term", "Long terme")}</option>
            <option value="PREFERENCE">{tr("Preference", "Préférence")}</option>
          </select>
          <input
            className="field"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder={tr("tags, comma, separated", "tags, séparés, par des virgules")}
          />
          <label className="check-label">
            <input
              type="checkbox"
              checked={acknowledgedSensitive}
              onChange={(event) => setAcknowledgedSensitive(event.target.checked)}
            />
            {tr("sensitive content verified", "contenu sensible vérifié")}
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
                  setActionError(
                    cause instanceof Error
                      ? cause.message
                      : tr("Unable to save.", "Impossible d'enregistrer."),
                  ),
                );
            }}
          >
            {tr("Remember", "Mémoriser")}
          </button>
        </div>
      </div>
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <Section state={state}>
        {(data) => (
          <>
            <div className="metrics">
              <Metric value={formatCount(data.total)} label={tr("memories", "mémoires")} />
              <Metric
                value={formatCount(data.byLayer.PREFERENCE ?? 0)}
                label={tr("preferences", "préférences")}
              />
              <Metric
                value={formatCount(data.byOrigin.AGENT ?? 0)}
                label={tr("inferred by agent", "déduit par l'agent")}
              />
              <Metric
                value={formatCount(data.bySensitivity.PERSONAL ?? 0)}
                label={tr("marked personal", "marqué personnel")}
              />
            </div>

            <h3>{tr("Recent Memories", "Mémoires Récentes")}</h3>
            {data.recent.length === 0 ? (
              <Empty>{tr("No memories stored.", "Aucune mémoire enregistrée.")}</Empty>
            ) : (
              <Table
                head={[
                  tr("Content", "Contenu"),
                  tr("Layer", "Couche"),
                  tr("Origin", "Origine"),
                  tr("Created", "Créé"),
                  tr("Actions", "Actions"),
                ]}
              >
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
                          if (
                            !window.confirm(
                              tr(
                                "Permanently forget this memory?",
                                "Oublier définitivement cette mémoire ?",
                              ),
                            )
                          )
                            return;
                          void api
                            .forget(record.id)
                            .then(() => state.reload())
                            .catch((cause: unknown) =>
                              setActionError(
                                cause instanceof Error
                                  ? cause.message
                                  : tr("Deletion failed.", "Échec de suppression."),
                              ),
                            );
                        }}
                      >
                        {tr("Forget", "Oublier")}
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
  const { tr } = useI18n();
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
      setConfigFeedback(
        tr(
          "External notification configuration saved.",
          "Configuration des notifications externes enregistrée.",
        ),
      );
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
          <h2>{tr("Notifications", "Notifications")}</h2>
          <p className="muted">
            {tr(
              "Central log and broadcast to external channels (desktop, mobile push ntfy, webhooks).",
              "Journal central et diffusion vers les canaux externes (bureau, push mobile ntfy, webhooks).",
            )}
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            className="button secondary"
            type="button"
            onClick={() => setShowConfig((curr) => !curr)}
          >
            {showConfig
              ? tr("Hide channel config", "Masquer la configuration")
              : tr("Configure channels", "Configurer les canaux")}
          </button>
          <button
            className="button"
            type="button"
            disabled={testing}
            onClick={() => void handleTest()}
          >
            {testing
              ? tr("Testing...", "Test en cours...")
              : tr("Test external channels", "Tester les canaux externes")}
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
          <h3 style={{ marginTop: 0 }}>
            {tr("External Notification Channels", "Canaux de Notification Externes")}
          </h3>

          <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "12px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
              />
              <strong>
                {tr(
                  "Enable external notification broadcast",
                  "Activer la diffusion externe des notifications",
                )}
              </strong>
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <label>
                {tr("Desktop Alert Urgency", "Urgence alerte bureau")}
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
                  <option value="low">{tr("Low", "Faible")}</option>
                  <option value="normal">{tr("Normal", "Normal")}</option>
                  <option value="critical">{tr("Critical", "Critique")}</option>
                </select>
              </label>

              <label>
                {tr("Dashboard Base URL", "URL de base du tableau de bord")}
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
                {tr("Ntfy Server URL", "URL serveur Ntfy")}
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
                {tr("Ntfy Topic", "Sujet Ntfy")}
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
                {tr("Webhook URL", "URL Webhook")}
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
                {tr("Webhook Format", "Format Webhook")}
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
                {configSaving
                  ? tr("Saving...", "Enregistrement...")
                  : tr("Save notification settings", "Enregistrer les paramètres")}
              </button>
            </div>
          </div>
        </form>
      )}

      <Section state={state}>
        {(data) => (
          <>
            <div className="metrics">
              <Metric value={formatCount(data.unread)} label={tr("unread", "non lues")} />
              <Metric
                value={formatCount(data.notifications.length)}
                label={tr("stored", "enregistrées")}
              />
            </div>

            {data.notifications.length === 0 ? (
              <Empty>{tr("No notifications.", "Aucune notification.")}</Empty>
            ) : (
              <Table
                head={[
                  tr("When", "Quand"),
                  tr("Severity", "Gravité"),
                  tr("Title", "Titre"),
                  tr("Body", "Message"),
                  tr("Read", "Lu"),
                  tr("Actions", "Actions"),
                ]}
              >
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
                    <td className="muted">
                      {notification.readAt === null ? tr("no", "non") : tr("yes", "oui")}
                    </td>
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
                          {tr("Mark read", "Marquer comme lu")}
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
  const { tr } = useI18n();
  const state = useSection(() => api.security());

  return (
    <div className="content">
      <Section state={state}>
        {(data) => (
          <>
            <div className="metrics">
              <Metric
                value={formatCount(data.trust.trusted)}
                label={tr("trusted devices", "appareils de confiance")}
              />
              <Metric
                value={formatCount(data.trust.pending)}
                label={tr("pending approval", "en attente d'approbation")}
                alert={data.trust.pending > 0}
              />
              <Metric value={formatCount(data.trust.revoked)} label={tr("revoked", "révoqués")} />
              <Metric
                value={formatCount(data.byKind["auth.login_failed"] ?? 0)}
                label={tr("login failures", "échecs de connexion")}
                alert={(data.byKind["auth.login_failed"] ?? 0) > 0}
              />
              <Metric
                value={formatCount(data.byKind["memory.refused"] ?? 0)}
                label={tr("rejected memories", "mémoires refusées")}
              />
            </div>

            <h3>{tr("Effective Permissions", "Permissions Effectives")}</h3>
            <p className="mono muted">
              {data.permissions.length === 0 ? tr("none", "aucune") : data.permissions.join(", ")}
            </p>

            <h3>{tr("Events", "Événements")}</h3>
            {data.events.length === 0 ? (
              <Empty>{tr("No security events.", "Aucun événement de sécurité.")}</Empty>
            ) : (
              <Table head={[tr("When", "Quand"), tr("Type", "Type"), tr("Summary", "Résumé")]}>
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
  const { tr } = useI18n();
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
          <option value="">{tr("all levels", "tous les niveaux")}</option>
          <option value="info">{tr("info and above", "info et supérieur")}</option>
          <option value="warn">{tr("warnings", "avertissements")}</option>
          <option value="error">{tr("errors", "erreurs")}</option>
        </select>

        <input
          className="field"
          style={{ flex: 1 }}
          value={search}
          placeholder={tr("Search messages…", "Rechercher des messages…")}
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
          {tr("Filter", "Filtrer")}
        </button>
      </div>

      <Section state={state}>
        {(data) =>
          data.entries.length === 0 ? (
            <Empty>{tr("No log lines matched.", "Aucune ligne de journal correspondante.")}</Empty>
          ) : (
            <Table
              head={[
                tr("When", "Quand"),
                tr("Level", "Niveau"),
                tr("Message", "Message"),
                tr("Correlation", "Corrélation"),
              ]}
            >
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
  const { tr } = useI18n();
  const state = useSection(() => api.marketplacePlugins());
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

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
      <div
        className="filter-bar"
        style={{ marginBottom: "16px", display: "flex", gap: "12px", alignItems: "center" }}
      >
        <input
          className="field"
          type="search"
          placeholder={tr(
            "Filter plugins or declared tools…",
            "Filtrer les plugins ou outils déclarés…",
          )}
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
            return (
              <Empty>
                {tr("No marketplace plugins found.", "Aucun plugin trouvé sur le marketplace.")}
              </Empty>
            );
          }

          return (
            <Table
              head={[
                tr("Plugin", "Plugin"),
                tr("Publisher", "Éditeur"),
                tr("Version", "Version"),
                tr("Status", "Statut"),
                tr("Declared Tools", "Outils Déclarés"),
                tr("Reputation", "Réputation"),
                tr("Actions", "Actions"),
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
                          {tr("Install", "Installer")}
                        </button>
                      ) : null}
                      {plugin.status === "installed" ? (
                        <button
                          className="button compact"
                          type="button"
                          onClick={() => act(() => api.togglePlugin(plugin.id, true))}
                        >
                          {tr("Pause", "Suspendre")}
                        </button>
                      ) : null}
                      {plugin.status === "paused" ? (
                        <button
                          className="button compact"
                          type="button"
                          onClick={() => act(() => api.togglePlugin(plugin.id, false))}
                        >
                          {tr("Resume", "Reprendre")}
                        </button>
                      ) : null}
                      {plugin.status === "installed" || plugin.status === "paused" ? (
                        <button
                          className="button danger compact"
                          type="button"
                          onClick={() => {
                            if (
                              window.confirm(
                                tr(
                                  `Revoke plugin "${plugin.name}"? This permanently uninstalls and disables all declared tools.`,
                                  `Révoquer le plugin "${plugin.name}" ? Cela désinstalle définitivement et désactive tous les outils déclarés.`,
                                ),
                              )
                            ) {
                              act(() => api.revokePlugin(plugin.id));
                            }
                          }}
                        >
                          {tr("Revoke", "Révoquer")}
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
            <div className="metrics">
              <Metric value={dag.taskId} label={tr("active task", "tâche active")} />
              <Metric
                value={String(dag.nodes.length)}
                label={tr("total DAG steps", "étapes DAG totales")}
              />
              <Metric
                value={dag.isPaused ? tr("PAUSED", "EN PAUSE") : tr("RUNNING", "EN COURS")}
                label={tr("pipeline state", "état du pipeline")}
                alert={dag.isPaused}
              />
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

// ─────────────────────────────────────────────────────────────────────────────
// 16. Phase 2: Quota Forecast (Codex Contract)
// ─────────────────────────────────────────────────────────────────────────────

export function QuotaForecast({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.quotaForecast());

  return (
    <div className="content">
      <Section state={state}>
        {(data) =>
          data.forecasts.length === 0 ? (
            <Empty>
              {tr("No quota forecasts available.", "Aucune prévision de quota disponible.")}
            </Empty>
          ) : (
            <Table
              head={[
                tr("Provider", "Fournisseur"),
                tr("Account", "Compte"),
                tr("Current Usage", "Utilisation Actuelle"),
                tr("Hard Limit", "Limite Stricte"),
                tr("Burn Gauge", "Jauge de Consommation"),
                tr("Projected Depletion", "Épuisement Estimé"),
                tr("Confidence", "Confiance"),
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
                      {f.hardLimit ? f.hardLimit.toLocaleString() : tr("Uncapped", "Illimité")}
                    </td>
                    <td>
                      {f.hardLimit ? <Bar percent={percent} /> : <span className="muted">—</span>}
                    </td>
                    <td className="muted">
                      {f.estimatedDepletionDate
                        ? new Date(f.estimatedDepletionDate).toLocaleDateString()
                        : tr("No exhaustion detected", "Aucun épuisement détecté")}
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
  const { tr } = useI18n();
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
              {tr("Baseline Run (A)", "Exécution de Référence (A)")}
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
              {tr("Comparison Run (B)", "Exécution de Comparaison (B)")}
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
            {tr("Compare Runs", "Comparer les Exécutions")}
          </button>
        </div>
      </section>

      <Section state={state}>
        {(comparison) =>
          comparison === null ? (
            <Empty>
              {tr(
                "Enter two run IDs from the Agent runs page to compare them.",
                "Entrez deux identifiants d'exécution depuis la page Exécutions pour les comparer.",
              )}
            </Empty>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div className="metrics">
                <Metric
                  value={`${formatDuration(Math.abs(comparison.diffSummary.durationDeltaMs))}`}
                  label={tr(
                    `duration delta (${comparison.diffSummary.fasterRunId} faster)`,
                    `écart de durée (${comparison.diffSummary.fasterRunId} plus rapide)`,
                  )}
                />
                <Metric
                  value={`${comparison.diffSummary.tokenDelta > 0 ? "+" : ""}${String(comparison.diffSummary.tokenDelta)}`}
                  label={tr("token delta (B - A)", "écart de jetons (B - A)")}
                />
                <Metric
                  value={comparison.diffSummary.cheaperRunId}
                  label={tr("cheaper run", "exécution la plus économique")}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                <section className="card">
                  <h3>
                    {tr("Run A", "Exécution A")} ({comparison.runA.id})
                  </h3>
                  <div
                    style={{
                      marginTop: "12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                    }}
                  >
                    <div>
                      <strong>{tr("Agent:", "Agent :")}</strong> {comparison.runA.agentKey}
                    </div>
                    <div>
                      <strong>{tr("Status:", "Statut :")}</strong> {comparison.runA.status}
                    </div>
                    <div>
                      <strong>{tr("Duration:", "Durée :")}</strong>{" "}
                      {formatDuration(comparison.runA.durationMs)}
                    </div>
                    <div>
                      <strong>{tr("Tokens:", "Jetons :")}</strong>{" "}
                      {comparison.runA.tokenCount.toLocaleString()}
                    </div>
                    <div>
                      <strong>{tr("Cost:", "Coût :")}</strong> $
                      {comparison.runA.costEstimateUsd.toFixed(4)}
                    </div>
                    <div>
                      <strong>{tr("Steps:", "Étapes :")}</strong>{" "}
                      {String(comparison.runA.stepCount)}
                    </div>
                  </div>
                </section>

                <section className="card">
                  <h3>
                    {tr("Run B", "Exécution B")} ({comparison.runB.id})
                  </h3>
                  <div
                    style={{
                      marginTop: "12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                    }}
                  >
                    <div>
                      <strong>{tr("Agent:", "Agent :")}</strong> {comparison.runB.agentKey}
                    </div>
                    <div>
                      <strong>{tr("Status:", "Statut :")}</strong> {comparison.runB.status}
                    </div>
                    <div>
                      <strong>{tr("Duration:", "Durée :")}</strong>{" "}
                      {formatDuration(comparison.runB.durationMs)}
                    </div>
                    <div>
                      <strong>{tr("Tokens:", "Jetons :")}</strong>{" "}
                      {comparison.runB.tokenCount.toLocaleString()}
                    </div>
                    <div>
                      <strong>{tr("Cost:", "Coût :")}</strong> $
                      {comparison.runB.costEstimateUsd.toFixed(4)}
                    </div>
                    <div>
                      <strong>{tr("Steps:", "Étapes :")}</strong>{" "}
                      {String(comparison.runB.stepCount)}
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
            <div className="metrics">
              <Metric
                value={String(graph.nodes.length)}
                label={tr("active agents", "agents actifs")}
              />
              <Metric
                value={String(graph.edges.length)}
                label={tr(
                  "inter-agent communication channels",
                  "canaux de communication inter-agents",
                )}
              />
              <Metric
                value={String(graph.edges.reduce((sum, e) => sum + e.messageCount, 0))}
                label={tr("total messages exchanged", "total des messages échangés")}
              />
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

// ─────────────────────────────────────────────────────────────────────────────
// 19. Phase 2: Visual Control (Claude Contract)
// ─────────────────────────────────────────────────────────────────────────────

export function VisualControl({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.visualControlStatus());
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
      <Section state={state}>
        {(vc) => (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div className="metrics">
              <Metric
                value={vc.active ? tr("ACTIVE", "ACTIF") : tr("IDLE", "INACTIF")}
                label={tr("automation session", "session d'automatisation")}
                alert={vc.active && vc.paused}
              />
              <Metric
                value={vc.paused ? tr("PAUSED", "EN PAUSE") : tr("RUNNING", "EN COURS")}
                label={tr("execution state", "état d'exécution")}
                alert={vc.paused}
              />
              <Metric
                value={`${String(vc.bounds.width)} × ${String(vc.bounds.height)}`}
                label={tr("viewport resolution", "résolution de la vue")}
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
                  <h3>
                    {tr("Remote Viewport & Safety Monitor", "Vue Distante & Moniteur de Sécurité")}
                  </h3>
                  <p className="muted">
                    {tr("Active Session:", "Session active :")}{" "}
                    <span className="mono">{vc.activeSessionId ?? tr("None", "Aucune")}</span>
                  </p>
                </div>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <State
                    tone={vc.safetyBoundaryEnforced ? "ok" : "down"}
                    label={
                      vc.safetyBoundaryEnforced
                        ? tr("SAFETY BOUNDARY ENFORCED", "LIMITE DE SÉCURITÉ ACTIVE")
                        : tr("UNRESTRICTED", "SANS RESTRICTION")
                    }
                  />
                  <button
                    className={`button ${vc.paused ? "primary" : "danger"}`}
                    type="button"
                    onClick={() => act(() => api.toggleVisualControlPause(!vc.paused))}
                  >
                    {vc.paused
                      ? tr("Resume Session", "Reprendre la session")
                      : tr(
                          "Pause Session (Emergency Stop)",
                          "Suspendre la session (Arrêt d'urgence)",
                        )}
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
                    alt={tr("Live visual control preview", "Aperçu du contrôle visuel en direct")}
                    style={{ maxWidth: "100%", maxHeight: "400px", borderRadius: "4px" }}
                  />
                ) : (
                  <div className="muted" style={{ textAlign: "center" }}>
                    <span>
                      {tr(
                        "No active frame capture. Remote viewport is waiting for agent interactions.",
                        "Aucune capture d'image active. La vue distante attend les interactions de l'agent.",
                      )}
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
