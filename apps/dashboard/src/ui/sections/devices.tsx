import { useEffect, useState } from "react";
import { generateQrSvg } from "@nexus/client-core";
import type { DashboardApi, PairingTicket } from "../../lib/api.js";
import {
  KNOWN_PERMISSIONS,
  PERMISSION_PRESETS,
  formatAge,
  formatLatency,
} from "../../lib/format.js";
import { Empty, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

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
              {!data.inventoryAvailable ? (
                <Empty>
                  {tr(
                    "Peer inventory is unavailable inside the isolated Docker API. The configured Tailscale address remains available for secure pairing.",
                    "L’inventaire des appareils n’est pas accessible depuis l’API Docker isolée. L’adresse Tailscale configurée reste disponible pour le jumelage sécurisé.",
                  )}
                </Empty>
              ) : data.peers.length === 0 ? (
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
                                  aria-label={perm.id}
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
                                    aria-label={custom}
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
                              aria-label={tr(
                                "Custom (e.g. sensor.custom)",
                                "Personnalisé (ex: sensor.custom)",
                              )}
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
