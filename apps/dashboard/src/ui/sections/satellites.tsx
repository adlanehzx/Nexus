import { useEffect, useState } from "react";
import { generateQrSvg } from "@nexus/client-core";
import type {
  DashboardApi,
  PairingTicket,
  SatelliteCommandAccepted,
  SatelliteCommandName,
  SatelliteCommandResult,
  SatelliteView,
} from "../../lib/api.js";
import { formatAge } from "../../lib/format.js";
import { Empty, Metric, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";
import {
  IconBattery,
  IconBatteryCharging,
  IconCheck,
  IconClose,
  IconHardware,
  IconMic,
  IconMicOff,
  IconRefresh,
  IconSatellite,
  IconVolume,
  IconVolumeX,
  IconWifi,
} from "../icons.js";

// ─────────────────────────────────────────────────────────────────────────────
// Satellites ESP32 Monitoring & Management Section (Lot 11.2)
// ─────────────────────────────────────────────────────────────────────────────

interface CommandExecutionRecord {
  id: string;
  deviceId: string;
  command: SatelliteCommandName;
  correlationId: string;
  status: "queued" | "delivered" | "completed" | "failed";
  timestamp: string;
  message?: string;
  elapsedMs?: number;
}

const DEFAULT_ROOMS = [
  "Salon / Living Room",
  "Bureau / Office",
  "Cuisine / Kitchen",
  "Chambre / Bedroom",
  "Entree / Hallway",
  "Atelier / Lab",
];

function extractBattery(health: Record<string, unknown>): {
  percent: number;
  charging: boolean;
  voltage?: number;
} | null {
  const percentCandidate =
    health.batteryPercent ?? health.batteryLevel ?? health.battery ?? health.battery_level;
  if (typeof percentCandidate === "number") {
    const charging = Boolean(health.charging ?? health.onMains ?? health.usbPower);
    const voltage = typeof health.batteryVoltage === "number" ? health.batteryVoltage : undefined;
    return {
      percent: Math.max(0, Math.min(100, Math.round(percentCandidate))),
      charging,
      ...(voltage !== undefined ? { voltage } : {}),
    };
  }
  if (typeof percentCandidate === "object" && percentCandidate !== null) {
    const obj = percentCandidate as Record<string, unknown>;
    const p = typeof obj.percent === "number" ? obj.percent : 0;
    const voltage = typeof obj.voltage === "number" ? obj.voltage : undefined;
    return {
      percent: Math.max(0, Math.min(100, Math.round(p))),
      charging: Boolean(obj.charging),
      ...(voltage !== undefined ? { voltage } : {}),
    };
  }
  return null;
}

function extractRssi(health: Record<string, unknown>): {
  rssi: number;
  quality: "excellent" | "good" | "fair" | "weak";
  ssid?: string;
} | null {
  const raw = health.wifiRssi ?? health.rssi ?? health.wifi_rssi ?? health.signal;
  if (typeof raw !== "number") return null;
  const ssid = typeof health.wifiSsid === "string" ? health.wifiSsid : undefined;
  let quality: "excellent" | "good" | "fair" | "weak" = "weak";
  if (raw >= -60) quality = "excellent";
  else if (raw >= -72) quality = "good";
  else if (raw >= -84) quality = "fair";
  return { rssi: raw, quality, ...(ssid !== undefined ? { ssid } : {}) };
}

function extractMic(health: Record<string, unknown>): {
  active: boolean;
  muted: boolean;
  gain?: number;
} {
  const raw = health.microphone ?? health.audioPrivacy ?? health.mic;
  if (typeof raw === "boolean") {
    return { active: raw, muted: !raw };
  }
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const muted = Boolean(obj.muted ?? health.privacyMuted ?? health.audioPrivacy);
    const active = obj.active !== undefined ? Boolean(obj.active) : !muted;
    const gain = typeof obj.gain === "number" ? obj.gain : undefined;
    return { active, muted, ...(gain !== undefined ? { gain } : {}) };
  }
  const privacyMuted = Boolean(health.privacyMuted ?? health.audioPrivacy);
  return { active: !privacyMuted, muted: privacyMuted };
}

function extractSpeaker(health: Record<string, unknown>): {
  active: boolean;
  volume?: number;
} {
  const raw = health.speaker ?? health.audioOutput;
  if (typeof raw === "boolean") {
    return { active: raw };
  }
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const active = obj.active !== false;
    const volume = typeof obj.volume === "number" ? obj.volume : undefined;
    return { active, ...(volume !== undefined ? { volume } : {}) };
  }
  return { active: true };
}

function extractFirmware(health: Record<string, unknown>): string {
  const fw = health.firmwareVersion ?? health.firmware ?? health.fw_version ?? health.version;
  return typeof fw === "string" ? fw : "v1.0.0-esp32";
}

function extractUptime(health: Record<string, unknown>): string {
  const uptimeMs =
    typeof health.uptimeMs === "number"
      ? health.uptimeMs
      : typeof health.uptime === "number"
        ? health.uptime * 1000
        : undefined;
  if (uptimeMs === undefined) return "--";
  const seconds = Math.floor(uptimeMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m ${seconds % 60}s`;
}

function extractRoom(sat: SatelliteView): string {
  if (typeof sat.health.room === "string" && sat.health.room.trim().length > 0) {
    return sat.health.room.trim();
  }
  return sat.name;
}

export function Satellites({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.satellites());

  // Pairing / registration state
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingDeviceId, setPairingDeviceId] = useState("");
  const [pairingName, setPairingName] = useState("");
  const [pairingRoom, setPairingRoom] = useState(DEFAULT_ROOMS[0] ?? "Salon");
  const [pairingTicket, setPairingTicket] = useState<PairingTicket | null>(null);
  const [provisioningPayload, setProvisioningPayload] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);

  // Filter & Room selection
  const [selectedRoom, setSelectedRoom] = useState<string>("all");

  // Commands execution state & telemetry
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeCommandBusy, setActiveCommandBusy] = useState<string | null>(null);
  const [commandHistory, setCommandHistory] = useState<CommandExecutionRecord[]>([]);

  // Expiration countdown for pairing ticket
  useEffect(() => {
    if (pairingTicket === null) return;
    const remaining = Math.max(0, new Date(pairingTicket.expiresAt).getTime() - Date.now());
    const timer = window.setTimeout(() => {
      setPairingTicket(null);
      setProvisioningPayload(null);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [pairingTicket]);

  const handlePairingSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const cleanId = pairingDeviceId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-");
    if (!cleanId) {
      setPairingError(
        tr(
          "Device ID is required (alphanumeric, dashes, underscores).",
          "L'identifiant d'appareil est requis (alphanumerique, tirets).",
        ),
      );
      return;
    }

    setPairingBusy(true);
    setPairingError(null);
    try {
      const res = await api.registerSatellite({
        deviceId: cleanId,
        name: pairingName.trim() || cleanId,
        room: pairingRoom,
      });
      setPairingTicket(res.ticket);
      setProvisioningPayload(res.provisioningPayload);
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : "Pairing registration failed.");
    } finally {
      setPairingBusy(false);
    }
  };

  const executeCommand = async (
    deviceId: string,
    command: SatelliteCommandName,
    params: Record<string, unknown> = {},
  ): Promise<void> => {
    setActionError(null);
    setActiveCommandBusy(`${deviceId}:${command}`);
    const startTime = Date.now();
    const tempId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const initialRecord: CommandExecutionRecord = {
      id: tempId,
      deviceId,
      command,
      correlationId: "pending",
      status: "queued",
      timestamp: new Date().toLocaleTimeString(),
    };
    setCommandHistory((prev) => [initialRecord, ...prev.slice(0, 19)]);

    try {
      const accepted: SatelliteCommandAccepted = await api.sendSatelliteCommand(
        deviceId,
        command,
        params,
      );

      setCommandHistory((prev) =>
        prev.map((rec) =>
          rec.id === tempId
            ? { ...rec, correlationId: accepted.correlationId, status: "delivered" }
            : rec,
        ),
      );

      // Poll for completion status
      let attempts = 0;
      const poll = async () => {
        try {
          const statusRes = await api.satelliteCommandStatus(deviceId, accepted.correlationId);
          if (statusRes.state === "completed" || statusRes.result !== null) {
            const result: SatelliteCommandResult | null = statusRes.result;
            const ok = result ? result.ok : true;
            const elapsed = Date.now() - startTime;
            setCommandHistory((prev) =>
              prev.map((rec) =>
                rec.id === tempId
                  ? {
                      ...rec,
                      status: ok ? "completed" : "failed",
                      elapsedMs: elapsed,
                      message: result?.message ?? (ok ? "Success" : "Hardware error"),
                    }
                  : rec,
              ),
            );
            setActiveCommandBusy(null);
            void state.reload();
          } else if (attempts < 6) {
            attempts++;
            setTimeout(() => {
              void poll();
            }, 600);
          } else {
            setActiveCommandBusy(null);
          }
        } catch {
          setActiveCommandBusy(null);
        }
      };

      setTimeout(() => {
        void poll();
      }, 400);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Command dispatch failed.");
      setCommandHistory((prev) =>
        prev.map((rec) =>
          rec.id === tempId
            ? {
                ...rec,
                status: "failed",
                message: err instanceof Error ? err.message : "Error",
              }
            : rec,
        ),
      );
      setActiveCommandBusy(null);
    }
  };

  const qrSvg = (() => {
    if (!provisioningPayload && !pairingTicket) return null;
    try {
      return generateQrSvg(provisioningPayload ?? pairingTicket?.payload ?? "");
    } catch {
      return null;
    }
  })();

  return (
    <div className="content">
      {actionError && <p className="banner error">{actionError}</p>}

      {/* Header section with Stats & Actions */}
      <section className="card" aria-labelledby="satellites-title">
        <div className="pairing-heading">
          <div>
            <span className="eyebrow">{tr("ESP32 HARDWARE FLEET", "PARC MATERIEL ESP32")}</span>
            <h2 id="satellites-title">
              {tr("Hardware Satellites Management", "Supervision des Satellites ESP32")}
            </h2>
            <p className="muted">
              {tr(
                "Real-time acoustic telemetry, Wi-Fi signal, room distribution, microphone privacy, and low-latency hardware command bus.",
                "Telemetrie acoustique temps reel, signal Wi-Fi, distribution par piece, confidentialite microphone et bus de commande materiel.",
              )}
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button
              type="button"
              className="button secondary"
              onClick={() => state.reload()}
              title={tr("Refresh fleet state", "Actualiser la flotte")}
            >
              <IconRefresh size={16} />
              <span>{tr("Refresh", "Actualiser")}</span>
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => {
                setPairingOpen(!pairingOpen);
                setPairingError(null);
              }}
            >
              <IconHardware size={16} />
              <span>
                {pairingOpen
                  ? tr("Close Pairing", "Fermer l'appairage")
                  : tr("Pair New Satellite", "Appairer un satellite")}
              </span>
            </button>
          </div>
        </div>

        {/* Pairing / Registration Drawer */}
        {pairingOpen && (
          <div
            className="card"
            style={{
              marginTop: "1.25rem",
              background: "rgba(255, 255, 255, 0.03)",
              border: "1px dashed var(--accent, #6366f1)",
            }}
          >
            <div className="pairing-heading">
              <div>
                <span className="eyebrow">
                  {tr("HARDWARE PROVISIONING", "PROVISIONNEMENT MATERIEL")}
                </span>
                <h3>{tr("Register & Flash ESP32 Satellite", "Enregistrer & Flasher un ESP32")}</h3>
                <p className="muted">
                  {tr(
                    "Generate authentication credentials and provisioning token for your ESP32-S3 or ESP32-Audio board.",
                    "Generez les identifiants d'authentification et le jeton de provisionnement pour votre carte ESP32-S3.",
                  )}
                </p>
              </div>
              <button
                type="button"
                className="button secondary"
                onClick={() => setPairingOpen(false)}
                title={tr("Close", "Fermer")}
              >
                <IconClose size={16} />
              </button>
            </div>

            {pairingError && <p className="banner error">{pairingError}</p>}

            <form onSubmit={(e) => void handlePairingSubmit(e)} style={{ marginTop: "1rem" }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "1rem",
                }}
              >
                <div>
                  <label
                    htmlFor="sat-device-id"
                    style={{ display: "block", marginBottom: "0.25rem" }}
                  >
                    {tr("Device ID", "Identifiant materiel (Device ID)")}
                  </label>
                  <input
                    id="sat-device-id"
                    className="field"
                    style={{ width: "100%" }}
                    value={pairingDeviceId}
                    placeholder="sat-esp32-salon"
                    required
                    onChange={(e) => setPairingDeviceId(e.target.value)}
                  />
                  <small className="muted">
                    {tr("Unique ID for hardware", "Identifiant unique")}
                  </small>
                </div>
                <div>
                  <label htmlFor="sat-name" style={{ display: "block", marginBottom: "0.25rem" }}>
                    {tr("Display Name", "Nom convivial")}
                  </label>
                  <input
                    id="sat-name"
                    className="field"
                    style={{ width: "100%" }}
                    value={pairingName}
                    placeholder="Satellite Salon"
                    onChange={(e) => setPairingName(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="sat-room" style={{ display: "block", marginBottom: "0.25rem" }}>
                    {tr("Room Assignment", "Attribution de piece")}
                  </label>
                  <select
                    id="sat-room"
                    className="field"
                    style={{ width: "100%" }}
                    value={pairingRoom}
                    onChange={(e) => setPairingRoom(e.target.value)}
                  >
                    {DEFAULT_ROOMS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ marginTop: "1rem", display: "flex", gap: "0.75rem" }}>
                <button type="submit" className="button primary" disabled={pairingBusy}>
                  {pairingBusy
                    ? tr("Generating credentials...", "Generation des identifiants...")
                    : tr("Generate Pairing Credentials", "Generer les identifiants")}
                </button>
              </div>
            </form>

            {pairingTicket && (
              <div
                style={{
                  marginTop: "1.5rem",
                  padding: "1rem",
                  background: "rgba(0, 0, 0, 0.25)",
                  borderRadius: "6px",
                  display: "flex",
                  gap: "1.5rem",
                  flexWrap: "wrap",
                }}
              >
                {qrSvg && (
                  <div
                    style={{
                      background: "#ffffff",
                      padding: "8px",
                      borderRadius: "4px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    dangerouslySetInnerHTML={{ __html: qrSvg }}
                  />
                )}
                <div style={{ flex: 1, minWidth: "260px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <IconCheck size={18} color="var(--success, #10b981)" />
                    <strong>
                      {tr("Pairing ticket generated", "Ticket d'appairage genere avec succes")}
                    </strong>
                  </div>
                  <p className="muted" style={{ margin: "0.5rem 0" }}>
                    {tr(
                      "Token expires in 5 minutes. Flash this configuration to your ESP32 or paste it in your firmware configuration.",
                      "Ce jeton expire dans 5 minutes. Flashez cette configuration sur l'ESP32 ou collez-la dans vos parametres de firmware.",
                    )}
                  </p>
                  <pre
                    style={{
                      background: "rgba(0,0,0,0.5)",
                      padding: "0.75rem",
                      borderRadius: "4px",
                      fontSize: "0.85rem",
                      overflowX: "auto",
                    }}
                  >
                    {provisioningPayload}
                  </pre>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Main Satellite Fleet Grid */}
      <Section state={state}>
        {(data) => {
          const satellites: SatelliteView[] = data.satellites ?? [];
          const totalCount = satellites.length;
          const onlineCount = satellites.filter((s) => s.online).length;
          const distinctRooms = Array.from(new Set(satellites.map((s) => extractRoom(s))));

          const filteredSatellites =
            selectedRoom === "all"
              ? satellites
              : satellites.filter((s) => extractRoom(s) === selectedRoom);

          return (
            <>
              {/* Summary KPIs */}
              <div className="grid-cards" style={{ marginBottom: "1.5rem" }}>
                <Metric
                  label={tr("Online Satellites", "Satellites en ligne")}
                  value={`${onlineCount} / ${totalCount}`}
                  {...(onlineCount > 0 ? { tone: "positive" as const } : {})}
                />
                <Metric
                  label={tr("Active Rooms", "Pieces couvertes")}
                  value={String(distinctRooms.length)}
                />
                <Metric
                  label={tr("Hardware Transceivers", "Transmetteurs materiels")}
                  value={String(
                    satellites.reduce(
                      (acc, s) =>
                        acc +
                        (s.capabilities.some(
                          (c) => c.name.includes("infrared") || c.name.includes("audio"),
                        )
                          ? 1
                          : 0),
                      0,
                    ),
                  )}
                />
                <Metric
                  label={tr("Fleet Status", "Etat du parc")}
                  value={
                    onlineCount === totalCount && totalCount > 0
                      ? "100%"
                      : `${Math.round((onlineCount / (totalCount || 1)) * 100)}%`
                  }
                  {...(onlineCount === totalCount && totalCount > 0
                    ? { tone: "positive" as const }
                    : {})}
                />
              </div>

              {/* Room Filter Pills */}
              {distinctRooms.length > 1 && (
                <div
                  style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", flexWrap: "wrap" }}
                >
                  <button
                    type="button"
                    className={`button ${selectedRoom === "all" ? "primary" : "secondary"}`}
                    onClick={() => setSelectedRoom("all")}
                  >
                    {tr("All Rooms", "Toutes les pieces")} ({satellites.length})
                  </button>
                  {distinctRooms.map((room) => (
                    <button
                      key={room}
                      type="button"
                      className={`button ${selectedRoom === room ? "primary" : "secondary"}`}
                      onClick={() => setSelectedRoom(room)}
                    >
                      {room} ({satellites.filter((s) => extractRoom(s) === room).length})
                    </button>
                  ))}
                </div>
              )}

              {/* Empty state */}
              {filteredSatellites.length === 0 ? (
                <Empty>
                  <div style={{ textAlign: "center", padding: "1.5rem" }}>
                    <IconSatellite size={36} style={{ marginBottom: "0.75rem", opacity: 0.6 }} />
                    <p>
                      {tr(
                        "No ESP32 satellites detected on this network.",
                        "Aucun satellite ESP32 detecte sur ce reseau.",
                      )}
                    </p>
                    <button
                      type="button"
                      className="button primary"
                      style={{ marginTop: "0.5rem" }}
                      onClick={() => setPairingOpen(true)}
                    >
                      {tr(
                        "Pair your first ESP32 satellite",
                        "Appairer votre premier satellite ESP32",
                      )}
                    </button>
                  </div>
                </Empty>
              ) : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
                    gap: "1.25rem",
                  }}
                >
                  {filteredSatellites.map((sat) => {
                    const battery = extractBattery(sat.health);
                    const rssi = extractRssi(sat.health);
                    const mic = extractMic(sat.health);
                    const speaker = extractSpeaker(sat.health);
                    const fw = extractFirmware(sat.health);
                    const uptime = extractUptime(sat.health);
                    const roomName = extractRoom(sat);
                    const isBusy = activeCommandBusy?.startsWith(sat.deviceId);

                    return (
                      <article
                        key={sat.deviceId}
                        className="card"
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "space-between",
                          border: sat.online
                            ? "1px solid rgba(255, 255, 255, 0.12)"
                            : "1px solid rgba(255, 255, 255, 0.05)",
                          opacity: sat.online ? 1 : 0.75,
                        }}
                      >
                        {/* Card Header */}
                        <div>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "flex-start",
                              marginBottom: "0.75rem",
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                              <IconSatellite size={22} color="var(--accent, #6366f1)" />
                              <div>
                                <strong style={{ fontSize: "1.05rem" }}>{sat.name}</strong>
                                <div className="muted" style={{ fontSize: "0.8rem" }}>
                                  <code>{sat.deviceId}</code>
                                </div>
                              </div>
                            </div>
                            <State
                              tone={sat.online ? "ok" : "unconfigured"}
                              label={
                                sat.online ? tr("ONLINE", "EN LIGNE") : tr("OFFLINE", "HORS LIGNE")
                              }
                            />
                          </div>

                          <div
                            style={{
                              display: "flex",
                              gap: "0.5rem",
                              marginBottom: "1rem",
                              flexWrap: "wrap",
                            }}
                          >
                            <span
                              style={{
                                fontSize: "0.75rem",
                                padding: "2px 8px",
                                borderRadius: "4px",
                                background: "rgba(99, 102, 241, 0.15)",
                                color: "#818cf8",
                              }}
                            >
                              {roomName}
                            </span>
                            <span className="muted" style={{ fontSize: "0.75rem" }}>
                              {tr("Last seen:", "Vu il y a:")} {formatAge(sat.lastSeenAt)}
                            </span>
                          </div>

                          {/* Telemetry Grid */}
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "1fr 1fr",
                              gap: "0.75rem",
                              padding: "0.75rem",
                              background: "rgba(0, 0, 0, 0.2)",
                              borderRadius: "6px",
                              marginBottom: "1rem",
                              fontSize: "0.85rem",
                            }}
                          >
                            {/* Battery telemetry */}
                            <div>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "0.35rem",
                                  color: "var(--muted)",
                                }}
                              >
                                {battery?.charging ? (
                                  <IconBatteryCharging size={15} color="#10b981" />
                                ) : (
                                  <IconBattery size={15} />
                                )}
                                <span>{tr("Battery", "Batterie")}</span>
                              </div>
                              <div style={{ marginTop: "0.2rem", fontWeight: 600 }}>
                                {battery ? (
                                  <>
                                    <span>{battery.percent}%</span>
                                    {battery.voltage && (
                                      <small className="muted" style={{ marginLeft: "0.35rem" }}>
                                        ({battery.voltage.toFixed(2)}V)
                                      </small>
                                    )}
                                  </>
                                ) : (
                                  <span className="muted">{tr("Mains powered", "Secteur")}</span>
                                )}
                              </div>
                            </div>

                            {/* Wi-Fi RSSI Telemetry */}
                            <div>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "0.35rem",
                                  color: "var(--muted)",
                                }}
                              >
                                <IconWifi size={15} />
                                <span>{tr("Wi-Fi Signal", "Signal Wi-Fi")}</span>
                              </div>
                              <div style={{ marginTop: "0.2rem", fontWeight: 600 }}>
                                {rssi ? (
                                  <span
                                    style={{
                                      color:
                                        rssi.quality === "excellent" || rssi.quality === "good"
                                          ? "#10b981"
                                          : rssi.quality === "fair"
                                            ? "#f59e0b"
                                            : "#ef4444",
                                    }}
                                  >
                                    {rssi.rssi} dBm ({rssi.quality})
                                  </span>
                                ) : (
                                  <span className="muted">--</span>
                                )}
                              </div>
                            </div>

                            {/* Microphone state */}
                            <div>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "0.35rem",
                                  color: "var(--muted)",
                                }}
                              >
                                {mic.muted ? (
                                  <IconMicOff size={15} color="#ef4444" />
                                ) : (
                                  <IconMic size={15} color="#10b981" />
                                )}
                                <span>{tr("Microphone", "Microphone")}</span>
                              </div>
                              <div style={{ marginTop: "0.2rem", fontWeight: 600 }}>
                                {mic.muted ? (
                                  <span style={{ color: "#ef4444" }}>
                                    {tr("Muted / Privacy", "Coupe / Discretion")}
                                  </span>
                                ) : (
                                  <span style={{ color: "#10b981" }}>
                                    {tr("Active (Listening)", "Actif (Ecoute)")}
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* Speaker state */}
                            <div>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "0.35rem",
                                  color: "var(--muted)",
                                }}
                              >
                                {speaker.active ? (
                                  <IconVolume size={15} color="#10b981" />
                                ) : (
                                  <IconVolumeX size={15} color="#ef4444" />
                                )}
                                <span>{tr("Speaker", "Haut-parleur")}</span>
                              </div>
                              <div style={{ marginTop: "0.2rem", fontWeight: 600 }}>
                                {speaker.volume !== undefined ? (
                                  <span>{speaker.volume}%</span>
                                ) : speaker.active ? (
                                  <span style={{ color: "#10b981" }}>
                                    {tr("Ready", "Operationnel")}
                                  </span>
                                ) : (
                                  <span className="muted">{tr("Disabled", "Desactive")}</span>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Hardware / Firmware info */}
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              fontSize: "0.75rem",
                              color: "var(--muted)",
                              marginBottom: "1rem",
                            }}
                          >
                            <span>
                              {tr("Firmware:", "Firmware:")} <code>{fw}</code>
                            </span>
                            <span>
                              {tr("Uptime:", "Uptime:")} {uptime}
                            </span>
                          </div>

                          {/* Capabilities tags */}
                          {sat.capabilities.length > 0 && (
                            <div
                              style={{
                                display: "flex",
                                gap: "0.35rem",
                                flexWrap: "wrap",
                                marginBottom: "1rem",
                              }}
                            >
                              {sat.capabilities.map((cap) => (
                                <span
                                  key={cap.name}
                                  style={{
                                    fontSize: "0.7rem",
                                    padding: "2px 6px",
                                    borderRadius: "3px",
                                    background: "rgba(255, 255, 255, 0.05)",
                                    border: "1px solid rgba(255, 255, 255, 0.1)",
                                  }}
                                >
                                  {cap.name}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Interactive Hardware Actions */}
                        <div
                          style={{
                            display: "flex",
                            gap: "0.5rem",
                            flexWrap: "wrap",
                            borderTop: "1px solid rgba(255, 255, 255, 0.08)",
                            paddingTop: "0.75rem",
                          }}
                        >
                          <button
                            type="button"
                            className="button secondary"
                            disabled={!sat.online || isBusy}
                            onClick={() => void executeCommand(sat.deviceId, "system.ping")}
                            title={tr("Send hardware ping", "Envoyer un ping materiel")}
                          >
                            <IconSatellite size={14} />
                            <span>{tr("Ping", "Ping")}</span>
                          </button>
                          <button
                            type="button"
                            className="button secondary"
                            disabled={!sat.online || isBusy}
                            onClick={() =>
                              void executeCommand(sat.deviceId, "system.diagnostics", {
                                target: "audio",
                              })
                            }
                            title={tr(
                              "Test voice & speaker diagnostics",
                              "Tester micro et haut-parleur",
                            )}
                          >
                            <IconVolume size={14} />
                            <span>{tr("Audio Test", "Test Audio")}</span>
                          </button>
                          <button
                            type="button"
                            className={`button ${mic.muted ? "primary" : "secondary"}`}
                            disabled={!sat.online || isBusy}
                            onClick={() =>
                              void executeCommand(sat.deviceId, "audio.privacy", {
                                muted: !mic.muted,
                              })
                            }
                            title={tr("Toggle microphone privacy", "Basculer la discretion audio")}
                          >
                            {mic.muted ? <IconMic size={14} /> : <IconMicOff size={14} />}
                            <span>
                              {mic.muted
                                ? tr("Unmute Mic", "Activer Micro")
                                : tr("Privacy Mute", "Mode Discretion")}
                            </span>
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}

              {/* Hardware Command Telemetry & Logs */}
              {commandHistory.length > 0 && (
                <section className="card" style={{ marginTop: "2rem" }}>
                  <div className="pairing-heading" style={{ marginBottom: "0.75rem" }}>
                    <div>
                      <span className="eyebrow">{tr("TELEMETRY", "TELEMETRIE")}</span>
                      <h3>{tr("Recent Hardware Commands", "Historique des Commandes Materiel")}</h3>
                    </div>
                  </div>
                  <Table
                    head={[
                      tr("Time", "Heure"),
                      tr("Device", "Appareil"),
                      tr("Command", "Commande"),
                      tr("Correlation ID", "ID Correlation"),
                      tr("Status", "Statut"),
                      tr("Latency / Result", "Latence / Resultat"),
                    ]}
                  >
                    {commandHistory.map((rec) => (
                      <tr key={rec.id}>
                        <td>{rec.timestamp}</td>
                        <td>
                          <code>{rec.deviceId}</code>
                        </td>
                        <td>
                          <strong>{rec.command}</strong>
                        </td>
                        <td>
                          <code style={{ fontSize: "0.75rem" }}>{rec.correlationId}</code>
                        </td>
                        <td>
                          <State
                            tone={
                              rec.status === "completed"
                                ? "ok"
                                : rec.status === "failed"
                                  ? "error"
                                  : "pending"
                            }
                            label={rec.status.toUpperCase()}
                          />
                        </td>
                        <td>
                          {rec.elapsedMs !== undefined ? `${rec.elapsedMs} ms` : "--"}
                          {rec.message && ` (${rec.message})`}
                        </td>
                      </tr>
                    ))}
                  </Table>
                </section>
              )}
            </>
          );
        }}
      </Section>
    </div>
  );
}
