import { useEffect, useMemo, useState } from "react";
import { generateQrSvg } from "@nexus/client-core";
import type {
  DashboardApi,
  PairingTicket,
  SatelliteCommandAccepted,
  SatelliteCommandName,
  SatelliteCommandResult,
  SatelliteView,
} from "../../lib/api.js";
import { Empty, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";
import {
  IconBattery,
  IconBatteryCharging,
  IconCheck,
  IconClose,
  IconHardware,
  IconHome,
  IconMic,
  IconMicOff,
  IconRadio,
  IconRefresh,
  IconSatellite,
  IconVolume,
  IconVolumeX,
  IconWifi,
} from "../icons.js";

// ─────────────────────────────────────────────────────────────────────────────
// Domotique & Flotte Satellites ESP32 (Smart Home Lab Section)
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
  "Salon",
  "Bureau",
  "Cuisine",
  "Chambre",
  "Entrée",
  "Atelier",
];

type DomotiqueMode = "normal" | "silence" | "nuit" | "intercom";

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

export function Domotique({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.satellites());

  // Domotique global mode state
  const [domotiqueMode, setDomotiqueMode] = useState<DomotiqueMode>("normal");
  const [modeNotice, setModeNotice] = useState<string | null>(null);

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

  const handleApplyDomotiqueMode = async (mode: DomotiqueMode) => {
    setDomotiqueMode(mode);
    setModeNotice(null);
    const fleet = state.data?.satellites ?? [];
    if (fleet.length === 0) return;

    try {
      if (mode === "silence" || mode === "nuit") {
        // Mute privacy on all satellites
        await Promise.all(
          fleet.map((s) => api.setSatellitePrivacy(s.deviceId, true)),
        );
        setModeNotice(
          tr(
            "Privacy mode active: Microphones muted on all home satellites.",
            "Mode silence actif : Microphones coupés sur l'ensemble des satellites.",
          ),
        );
      } else if (mode === "normal") {
        // Unmute privacy on all satellites
        await Promise.all(
          fleet.map((s) => api.setSatellitePrivacy(s.deviceId, false)),
        );
        setModeNotice(
          tr(
            "Normal mode active: Voice satellites ready for interaction.",
            "Mode normal actif : Satellites vocaux prêts pour l'interaction.",
          ),
        );
      } else if (mode === "intercom") {
        // Broadcast test chime across all online satellites
        const onlineSats = fleet.filter((s) => s.online);
        await Promise.all(
          onlineSats.map((s) => api.testSatelliteVoiceSpeaker(s.deviceId, 70)),
        );
        setModeNotice(
          tr(
            `Intercom chime broadcasted to ${onlineSats.length} satellite(s).`,
            `Signal d'intercom diffusé sur ${onlineSats.length} satellite(s).`,
          ),
        );
      }
      void state.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Domotique mode trigger failed.");
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

  const fleet = state.data?.satellites ?? [];

  // Group fleet by room
  const roomsMap = useMemo(() => {
    const map = new Map<string, SatelliteView[]>();
    for (const room of DEFAULT_ROOMS) {
      map.set(room, []);
    }
    for (const sat of fleet) {
      const r = extractRoom(sat);
      if (!map.has(r)) {
        map.set(r, []);
      }
      map.get(r)!.push(sat);
    }
    return map;
  }, [fleet]);

  const activeRooms = Array.from(roomsMap.keys());
  const filteredSatellites =
    selectedRoom === "all"
      ? fleet
      : fleet.filter((s) => extractRoom(s) === selectedRoom);

  const totalSatellites = fleet.length;
  const onlineCount = fleet.filter((s) => s.online).length;
  const micActiveCount = fleet.filter((s) => {
    const mic = extractMic(s.health);
    return mic.active && !mic.muted;
  }).length;
  const avgBattery = (() => {
    const values = fleet
      .map((s) => extractBattery(s.health)?.percent)
      .filter((v): v is number => typeof v === "number");
    if (values.length === 0) return null;
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  })();

  return (
    <div className="content">
      {actionError && <p className="banner error">{actionError}</p>}
      {modeNotice && (
        <div className="banner" style={{ background: "rgba(56, 189, 248, 0.1)", border: "1px solid rgba(56, 189, 248, 0.3)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>{modeNotice}</span>
          <button type="button" className="button compact secondary" onClick={() => setModeNotice(null)}>
            <IconClose size={14} />
          </button>
        </div>
      )}

      {/* Main Domotique Hub Header */}
      <section className="card" aria-labelledby="domotique-title">
        <div className="pairing-heading">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
              <IconHome size={22} color="var(--accent, #6366f1)" />
              <span className="eyebrow" style={{ margin: 0 }}>
                {tr("NEXUS SMART HOME LAB", "LABORATOIRE DOMOTIQUE NEXUS")}
              </span>
            </div>
            <h2 id="domotique-title" style={{ margin: "0.25rem 0 0.5rem" }}>
              {tr("Domotique & ESP32 Satellites Hub", "Domotique & Satellites ESP32")}
            </h2>
            <p className="muted">
              {tr(
                "Centralized smart home automation, zone telemetry, microphone privacy management, and ESP32 satellite fleet diagnostics.",
                "Supervision domotique centralisée, télémétrie par pièce, gestion de confidentialité des microphones et diagnostic de la flotte ESP32.",
              )}
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
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

        {/* Global Domotique Automation Modes */}
        <div
          style={{
            marginTop: "1.25rem",
            padding: "1rem",
            background: "rgba(255, 255, 255, 0.02)",
            borderRadius: "var(--nx-radius-md, 8px)",
            border: "1px solid var(--nx-line, rgba(255, 255, 255, 0.08))",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "1rem",
          }}
        >
          <div>
            <span style={{ fontSize: "0.85rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--nx-text-muted, #71717a)" }}>
              {tr("Smart Home Operating Mode", "Mode de fonctionnement domotique")}
            </span>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
              <button
                type="button"
                className={`button compact ${domotiqueMode === "normal" ? "primary" : "secondary"}`}
                onClick={() => void handleApplyDomotiqueMode("normal")}
              >
                <IconCheck size={14} />
                <span>{tr("Active Mode", "Mode Actif")}</span>
              </button>
              <button
                type="button"
                className={`button compact ${domotiqueMode === "silence" ? "primary" : "secondary"}`}
                onClick={() => void handleApplyDomotiqueMode("silence")}
                title={tr("Mute microphones across all rooms", "Couper les micros de toutes les pièces")}
              >
                <IconMicOff size={14} />
                <span>{tr("Silence / Privacy", "Silence / Privé")}</span>
              </button>
              <button
                type="button"
                className={`button compact ${domotiqueMode === "nuit" ? "primary" : "secondary"}`}
                onClick={() => void handleApplyDomotiqueMode("nuit")}
                title={tr("Night mode: privacy and reduced audio volume", "Mode nuit : confidentialité et volume discret")}
              >
                <IconVolumeX size={14} />
                <span>{tr("Night Mode", "Mode Nuit")}</span>
              </button>
              <button
                type="button"
                className={`button compact ${domotiqueMode === "intercom" ? "primary" : "secondary"}`}
                onClick={() => void handleApplyDomotiqueMode("intercom")}
                title={tr("Broadcast chime across all online satellites", "Diffuser un signal audio sur tous les satellites")}
              >
                <IconVolume size={14} />
                <span>{tr("Broadcast Intercom", "Diffusion Intercom")}</span>
              </button>
            </div>
          </div>

          {/* Quick Metrics Bar */}
          <div style={{ display: "flex", gap: "1.25rem", alignItems: "center" }}>
            <div>
              <span className="muted" style={{ fontSize: "0.75rem", display: "block" }}>
                {tr("Active Satellites", "Satellites actifs")}
              </span>
              <span style={{ fontSize: "1.25rem", fontWeight: 700, color: onlineCount > 0 ? "var(--nx-accent-line, #38bdf8)" : "var(--nx-text-muted)" }}>
                {onlineCount} / {totalSatellites}
              </span>
            </div>
            <div>
              <span className="muted" style={{ fontSize: "0.75rem", display: "block" }}>
                {tr("Microphones Listening", "Micros à l'écoute")}
              </span>
              <span style={{ fontSize: "1.25rem", fontWeight: 700, color: micActiveCount > 0 ? "#10b981" : "#f59e0b" }}>
                {micActiveCount}
              </span>
            </div>
            {avgBattery !== null && (
              <div>
                <span className="muted" style={{ fontSize: "0.75rem", display: "block" }}>
                  {tr("Avg Battery", "Batterie moy.")}
                </span>
                <span style={{ fontSize: "1.25rem", fontWeight: 700, color: avgBattery > 20 ? "var(--nx-text, #f4f4f5)" : "#ef4444" }}>
                  {avgBattery}%
                </span>
              </div>
            )}
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
                  <small className="muted">{tr("Friendly room alias", "Nom lisible")}</small>
                </div>
                <div>
                  <label htmlFor="sat-room" style={{ display: "block", marginBottom: "0.25rem" }}>
                    {tr("Room / Zone", "Piece / Zone")}
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
                  <small className="muted">{tr("Assigned zone", "Zone assignee")}</small>
                </div>
              </div>

              <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
                <button type="submit" className="button primary" disabled={pairingBusy}>
                  <IconHardware size={16} />
                  <span>
                    {pairingBusy
                      ? tr("Generating Ticket...", "Generation du jeton...")
                      : tr("Generate Pairing Ticket & QR", "Generer le jeton & QR code")}
                  </span>
                </button>
              </div>
            </form>

            {/* Generated QR Code & Flashing instructions */}
            {pairingTicket && (
              <div
                style={{
                  marginTop: "1.5rem",
                  padding: "1rem",
                  background: "rgba(0, 0, 0, 0.25)",
                  borderRadius: "var(--radius, 8px)",
                  border: "1px solid rgba(255, 255, 255, 0.08)",
                }}
              >
                <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "center" }}>
                  {qrSvg && (
                    <div
                      style={{
                        padding: "0.75rem",
                        background: "#fff",
                        borderRadius: "8px",
                        display: "inline-block",
                      }}
                      dangerouslySetInnerHTML={{ __html: qrSvg }}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: "260px" }}>
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.4rem",
                        color: "#10b981",
                        fontWeight: 600,
                        fontSize: "0.9rem",
                        marginBottom: "0.5rem",
                      }}
                    >
                      <IconCheck size={16} />
                      <span>{tr("Pairing Ticket Active", "Jeton d'appairage actif")}</span>
                    </div>
                    <p style={{ margin: "0.25rem 0", fontSize: "0.85rem" }}>
                      <strong>{tr("Device ID:", "ID Appareil :")}</strong> {pairingTicket.deviceId}
                    </p>
                    <p style={{ margin: "0.25rem 0", fontSize: "0.85rem" }}>
                      <strong>{tr("Ticket ID:", "ID Jeton :")}</strong> {pairingTicket.ticketId}
                    </p>
                    <p style={{ margin: "0.25rem 0", fontSize: "0.85rem" }}>
                      <strong>{tr("Expires at:", "Expire a :")}</strong>{" "}
                      {new Date(pairingTicket.expiresAt).toLocaleTimeString()}
                    </p>
                    <div style={{ marginTop: "0.75rem" }}>
                      <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted)" }}>
                        {tr("Provisioning Payload (JSON)", "Payload de provisionnement (JSON)")}
                      </label>
                      <pre
                        style={{
                          background: "#000",
                          padding: "0.5rem",
                          borderRadius: "4px",
                          fontSize: "0.75rem",
                          overflowX: "auto",
                        }}
                      >
                        {provisioningPayload ?? pairingTicket.payload}
                      </pre>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Smart Home Zones Grid */}
      <section className="card" style={{ marginTop: "1rem" }} aria-labelledby="rooms-title">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <div>
            <h3 id="rooms-title" style={{ margin: 0 }}>
              {tr("Rooms & Living Zones", "Pièces & Zones de vie")}
            </h3>
            <p className="muted" style={{ margin: "0.25rem 0 0" }}>
              {tr("Overview of audio satellites and automation coverage by room.", "État de couverture acoustique et domotique par zone.")}
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <button
              type="button"
              className={`button compact ${selectedRoom === "all" ? "primary" : "secondary"}`}
              onClick={() => setSelectedRoom("all")}
            >
              <span>{tr("All Rooms", "Toutes les pièces")}</span>
            </button>
            {activeRooms.map((room) => (
              <button
                key={room}
                type="button"
                className={`button compact ${selectedRoom === room ? "primary" : "secondary"}`}
                onClick={() => setSelectedRoom(room)}
              >
                <span>{room}</span>
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "1rem" }}>
          {activeRooms.map((room) => {
            const satsInRoom = roomsMap.get(room) ?? [];
            const onlineInRoom = satsInRoom.filter((s) => s.online).length;
            const anyMicMuted = satsInRoom.some((s) => extractMic(s.health).muted);
            const isSelected = selectedRoom === room;

            return (
              <div
                key={room}
                className="card"
                style={{
                  background: isSelected ? "rgba(99, 102, 241, 0.08)" : "rgba(255, 255, 255, 0.02)",
                  border: isSelected ? "1px solid var(--accent, #6366f1)" : "1px solid var(--nx-line, rgba(255, 255, 255, 0.08))",
                  padding: "1rem",
                  cursor: "pointer",
                }}
                onClick={() => setSelectedRoom(isSelected ? "all" : room)}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
                  <div>
                    <h4 style={{ margin: 0, fontSize: "1.05rem" }}>{room}</h4>
                    <span className="muted" style={{ fontSize: "0.8rem" }}>
                      {satsInRoom.length === 0
                        ? tr("No satellites assigned", "Aucun satellite")
                        : `${satsInRoom.length} satellite(s) (${onlineInRoom} ${tr("online", "en ligne")})`}
                    </span>
                  </div>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.25rem",
                      fontSize: "0.75rem",
                      padding: "0.2rem 0.5rem",
                      borderRadius: "999px",
                      background: onlineInRoom > 0 ? "rgba(16, 185, 129, 0.15)" : "rgba(255, 255, 255, 0.05)",
                      color: onlineInRoom > 0 ? "#10b981" : "var(--nx-text-muted)",
                    }}
                  >
                    <IconSatellite size={12} />
                    <span>{onlineInRoom > 0 ? tr("Covered", "Couvert") : tr("Inactive", "Inactif")}</span>
                  </span>
                </div>

                <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", fontSize: "0.8rem", color: "var(--nx-text-muted)" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                    {anyMicMuted ? (
                      <IconMicOff size={14} color="#f59e0b" />
                    ) : (
                      <IconMic size={14} color="#10b981" />
                    )}
                    <span>{anyMicMuted ? tr("Mic Muted", "Micro muet") : tr("Mic Active", "Micro actif")}</span>
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                    <IconVolume size={14} />
                    <span>{tr("Speaker Ready", "Haut-parleur prêt")}</span>
                  </span>
                </div>

                {satsInRoom.length > 0 && (
                  <div style={{ marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: "1px solid rgba(255, 255, 255, 0.05)", display: "flex", gap: "0.5rem" }}>
                    <button
                      type="button"
                      className="button compact secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        satsInRoom.forEach((s) => void executeCommand(s.deviceId, "ping"));
                      }}
                    >
                      <IconRadio size={12} />
                      <span>{tr("Ping Zone", "Ping zone")}</span>
                    </button>
                    <button
                      type="button"
                      className="button compact secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        satsInRoom.forEach((s) => void executeCommand(s.deviceId, "test-voice", { volume: 75 }));
                      }}
                    >
                      <IconVolume size={12} />
                      <span>{tr("Test Audio", "Test audio")}</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Satellites ESP32 Hardware Fleet Section */}
      <section className="card" style={{ marginTop: "1rem" }} aria-labelledby="fleet-title">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <div>
            <h3 id="fleet-title" style={{ margin: 0 }}>
              {tr("ESP32 Hardware Satellites Fleet", "Flotte des Satellites ESP32")}
            </h3>
            <p className="muted" style={{ margin: "0.25rem 0 0" }}>
              {selectedRoom === "all"
                ? tr("Displaying all provisioned ESP32 audio nodes.", "Affichage de tous les modules audio ESP32 provisionnés.")
                : tr(`Filtering for room: ${selectedRoom}`, `Filtré pour la pièce : ${selectedRoom}`)}
            </p>
          </div>
        </div>

        {filteredSatellites.length === 0 ? (
          <Empty
            text={
              selectedRoom === "all"
                ? tr(
                    "No ESP32 satellites connected yet. Click 'Pair New Satellite' to provision a node.",
                    "Aucun satellite ESP32 connecte pour l'instant. Cliquez sur 'Appairer un satellite' pour provisionner un module.",
                  )
                : tr(
                    `No satellites found in room '${selectedRoom}'.`,
                    `Aucun satellite trouve dans la piece '${selectedRoom}'.`,
                  )
            }
          />
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: "1rem",
            }}
          >
            {filteredSatellites.map((sat) => {
              const battery = extractBattery(sat.health);
              const rssi = extractRssi(sat.health);
              const mic = extractMic(sat.health);
              const speaker = extractSpeaker(sat.health);
              const firmware = extractFirmware(sat.health);
              const uptime = extractUptime(sat.health);
              const room = extractRoom(sat);
              const isBusy = activeCommandBusy?.startsWith(sat.deviceId);

              return (
                <div
                  key={sat.deviceId}
                  className="card"
                  style={{
                    background: "rgba(255, 255, 255, 0.02)",
                    border: sat.online
                      ? "1px solid var(--nx-line, rgba(255, 255, 255, 0.1))"
                      : "1px solid rgba(239, 68, 68, 0.2)",
                    position: "relative",
                  }}
                >
                  {/* Card Header: Name, Room, Status badge */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      marginBottom: "0.75rem",
                    }}
                  >
                    <div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.4rem",
                          marginBottom: "0.2rem",
                        }}
                      >
                        <IconSatellite
                          size={18}
                          color={sat.online ? "var(--accent, #6366f1)" : "var(--muted)"}
                        />
                        <h4 style={{ margin: 0, fontSize: "1.1rem" }}>{sat.name}</h4>
                      </div>
                      <span className="muted" style={{ fontSize: "0.8rem" }}>
                        <code>{sat.deviceId}</code> &bull; {room}
                      </span>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.3rem",
                          fontSize: "0.75rem",
                          padding: "0.2rem 0.6rem",
                          borderRadius: "999px",
                          fontWeight: 600,
                          background: sat.online
                            ? "rgba(16, 185, 129, 0.15)"
                            : "rgba(239, 68, 68, 0.15)",
                          color: sat.online ? "#10b981" : "#ef4444",
                        }}
                      >
                        <span
                          style={{
                            width: "6px",
                            height: "6px",
                            borderRadius: "50%",
                            background: sat.online ? "#10b981" : "#ef4444",
                          }}
                        />
                        <span>{sat.online ? tr("ONLINE", "EN LIGNE") : tr("OFFLINE", "HORS LIGNE")}</span>
                      </span>
                    </div>
                  </div>

                  {/* Telemetry row: Wi-Fi RSSI, Battery, Uptime */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr 1fr",
                      gap: "0.5rem",
                      padding: "0.6rem 0.75rem",
                      background: "rgba(0, 0, 0, 0.2)",
                      borderRadius: "6px",
                      marginBottom: "0.75rem",
                      fontSize: "0.8rem",
                    }}
                  >
                    {/* RSSI Signal */}
                    <div>
                      <span className="muted" style={{ display: "block", fontSize: "0.7rem" }}>
                        {tr("Wi-Fi Signal", "Signal Wi-Fi")}
                      </span>
                      {rssi ? (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.3rem",
                            marginTop: "0.15rem",
                          }}
                        >
                          <IconWifi
                            size={14}
                            color={
                              rssi.quality === "excellent" || rssi.quality === "good"
                                ? "#10b981"
                                : rssi.quality === "fair"
                                  ? "#f59e0b"
                                  : "#ef4444"
                            }
                          />
                          <span>{rssi.rssi} dBm</span>
                        </div>
                      ) : (
                        <span className="muted">--</span>
                      )}
                    </div>

                    {/* Battery */}
                    <div>
                      <span className="muted" style={{ display: "block", fontSize: "0.7rem" }}>
                        {tr("Battery", "Batterie")}
                      </span>
                      {battery ? (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.3rem",
                            marginTop: "0.15rem",
                          }}
                        >
                          {battery.charging ? (
                            <IconBatteryCharging size={14} color="#10b981" />
                          ) : (
                            <IconBattery
                              size={14}
                              color={battery.percent > 20 ? "currentColor" : "#ef4444"}
                            />
                          )}
                          <span>
                            {battery.percent}%{battery.charging ? " (chg)" : ""}
                          </span>
                        </div>
                      ) : (
                        <span className="muted">Secteur / Mains</span>
                      )}
                    </div>

                    {/* Uptime */}
                    <div>
                      <span className="muted" style={{ display: "block", fontSize: "0.7rem" }}>
                        {tr("Uptime", "Disponibilite")}
                      </span>
                      <span style={{ display: "block", marginTop: "0.15rem" }}>{uptime}</span>
                    </div>
                  </div>

                  {/* Audio Controls & Privacy: Mic status & Speaker */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "0.5rem 0.75rem",
                      background: "rgba(255, 255, 255, 0.03)",
                      borderRadius: "6px",
                      marginBottom: "0.75rem",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                      {/* Microphone Privacy Toggle */}
                      <button
                        type="button"
                        className="button compact secondary"
                        style={{
                          borderColor: mic.muted ? "#f59e0b" : "rgba(255, 255, 255, 0.15)",
                          color: mic.muted ? "#f59e0b" : "currentColor",
                        }}
                        disabled={!sat.online || isBusy}
                        onClick={() => void executeCommand(sat.deviceId, "set-privacy", { muted: !mic.muted })}
                        title={
                          mic.muted
                            ? tr("Microphone is MUTED. Click to activate.", "Microphone COUPE. Cliquer pour activer.")
                            : tr("Microphone is ACTIVE. Click to mute.", "Microphone ACTIF. Cliquer pour couper.")
                        }
                      >
                        {mic.muted ? <IconMicOff size={14} color="#f59e0b" /> : <IconMic size={14} color="#10b981" />}
                        <span>{mic.muted ? tr("Muted", "Coupe") : tr("Active", "Actif")}</span>
                      </button>

                      {/* Speaker Status */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.3rem",
                          fontSize: "0.8rem",
                          color: "var(--muted)",
                        }}
                      >
                        <IconVolume size={14} />
                        <span>
                          {speaker.volume !== undefined
                            ? `${speaker.volume}%`
                            : tr("Speaker OK", "Haut-parleur OK")}
                        </span>
                      </div>
                    </div>

                    <span className="muted" style={{ fontSize: "0.75rem" }}>
                      {firmware}
                    </span>
                  </div>

                  {/* Hardware Command Actions */}
                  <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="button compact secondary"
                      disabled={!sat.online || isBusy}
                      onClick={() => void executeCommand(sat.deviceId, "ping")}
                      title={tr("Send low-latency ping", "Envoyer un ping")}
                    >
                      <IconRadio size={14} />
                      <span>{tr("Ping", "Ping")}</span>
                    </button>
                    <button
                      type="button"
                      className="button compact secondary"
                      disabled={!sat.online || isBusy}
                      onClick={() =>
                        void executeCommand(sat.deviceId, "test-voice", {
                          volume: speaker.volume ?? 80,
                        })
                      }
                      title={tr("Play voice chime test", "Tester le haut-parleur")}
                    >
                      <IconVolume size={14} />
                      <span>{tr("Test Speaker", "Test Haut-parleur")}</span>
                    </button>
                    <button
                      type="button"
                      className="button compact secondary"
                      disabled={!sat.online || isBusy}
                      onClick={() => void executeCommand(sat.deviceId, "identify")}
                      title={tr("Blink LED on device", "Faire clignoter la LED")}
                    >
                      <IconHardware size={14} />
                      <span>{tr("Blink", "Identifier")}</span>
                    </button>
                  </div>

                  {/* Capabilities tags */}
                  {sat.capabilities.length > 0 && (
                    <div
                      style={{
                        marginTop: "0.75rem",
                        display: "flex",
                        gap: "0.3rem",
                        flexWrap: "wrap",
                      }}
                    >
                      {sat.capabilities.map((cap) => (
                        <span
                          key={cap.name}
                          style={{
                            fontSize: "0.68rem",
                            background: "rgba(255, 255, 255, 0.05)",
                            padding: "0.15rem 0.4rem",
                            borderRadius: "4px",
                            color: "var(--muted)",
                          }}
                        >
                          {cap.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Real-time Hardware Command Audit Log */}
      {commandHistory.length > 0 && (
        <section className="card" style={{ marginTop: "1rem" }} aria-labelledby="history-title">
          <div className="pairing-heading">
            <div>
              <span className="eyebrow">{tr("COMMAND BUS TELEMETRY", "TELEMETRIE DU BUS")}</span>
              <h3 id="history-title">{tr("Live Hardware Command Log", "Journal des Commandes")}</h3>
            </div>
            <button
              type="button"
              className="button compact secondary"
              onClick={() => setCommandHistory([])}
            >
              {tr("Clear Log", "Effacer")}
            </button>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ width: "100%", fontSize: "0.85rem" }}>
              <thead>
                <tr>
                  <th>{tr("Time", "Heure")}</th>
                  <th>{tr("Device", "Appareil")}</th>
                  <th>{tr("Command", "Commande")}</th>
                  <th>{tr("Correlation ID", "ID Correlation")}</th>
                  <th>{tr("Latency", "Latence")}</th>
                  <th>{tr("Status", "Statut")}</th>
                </tr>
              </thead>
              <tbody>
                {commandHistory.map((rec) => (
                  <tr key={rec.id}>
                    <td>{rec.timestamp}</td>
                    <td>
                      <code>{rec.deviceId}</code>
                    </td>
                    <td>
                      <span className="badge">{rec.command}</span>
                    </td>
                    <td>
                      <code style={{ fontSize: "0.75rem" }}>{rec.correlationId}</code>
                    </td>
                    <td>{rec.elapsedMs !== undefined ? `${rec.elapsedMs} ms` : "--"}</td>
                    <td>
                      <span
                        style={{
                          color:
                            rec.status === "completed"
                              ? "#10b981"
                              : rec.status === "failed"
                                ? "#ef4444"
                                : "#f59e0b",
                          fontWeight: 600,
                        }}
                      >
                        {rec.status.toUpperCase()}
                      </span>
                      {rec.message ? ` (${rec.message})` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

