import { useEffect, useMemo, useState } from "react";
import type {
  DashboardApi,
  SatelliteCommandAccepted,
  SatelliteCommandName,
  SatelliteView,
} from "../../lib/api.js";
import { Empty, useSection } from "../parts.js";
import {
  HomeAssistantPanel,
  HomeAutomationsPanel,
  HomeDevicesPanel,
  SatelliteEnrollmentPanel,
  VoiceSatellitesPanel,
} from "./domotique-home.js";
import { useI18n } from "../i18n/index.js";
import {
  IconArrowLeft,
  IconBattery,
  IconBatteryCharging,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconClock,
  IconClose,
  IconHardware,
  IconHome,
  IconMenu,
  IconMic,
  IconMicOff,
  IconMinus,
  IconPlay,
  IconPlus,
  IconPower,
  IconRadio,
  IconRefresh,
  IconSatellite,
  IconSettings,
  IconTv,
  IconVolume,
  IconVolumeX,
  IconWifi,
} from "../icons.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types & Telemetry Models
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

interface RemoteActionLog {
  id: string;
  action: string;
  key?: string | undefined;
  delivered: boolean;
  timestamp: string;
  error?: string | undefined;
  elapsedMs?: number;
}

/** Satellites that report no room are grouped here. No room is ever invented. */
const UNASSIGNED_ROOM = "—";

type DomotiqueMode = "normal" | "silence" | "nuit" | "intercom";
type DomotiqueTab = "home" | "automations" | "voice" | "ha" | "fleet" | "remote";

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
  return UNASSIGNED_ROOM;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactive Remote Control Component (D-Pad, Navigation & Media Keys)
// ─────────────────────────────────────────────────────────────────────────────

export function RemoteControl({ api, serial }: { api: DashboardApi; serial?: string }) {
  const { tr } = useI18n();
  // TVs come from the account's own list: no address is built in.
  const tvs = useSection(() => api.homeTvs());
  const [targetSerial, setTargetSerial] = useState(serial ?? "");
  const [newTvSerial, setNewTvSerial] = useState("");
  const [newTvName, setNewTvName] = useState("");
  const [tvError, setTvError] = useState<string | null>(null);
  useEffect(() => {
    const first = tvs.data?.[0];
    if (targetSerial === "" && first !== undefined) setTargetSerial(first.serial);
  }, [tvs.data, targetSerial]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [lastResult, setLastResult] = useState<{
    action: string;
    delivered: boolean;
    key?: string | undefined;
    error?: string | undefined;
    timestamp: string;
    latencyMs: number;
  } | null>(null);
  const [logs, setLogs] = useState<RemoteActionLog[]>([]);

  const dispatchKey = async (action: string) => {
    setActiveKey(action);
    setIsSending(true);
    const start = Date.now();
    try {
      const res = await api.sendFireTvRemote(
        action,
        targetSerial === "" ? undefined : targetSerial,
      );
      const elapsedMs = Date.now() - start;
      const record: RemoteActionLog = {
        id: `rem-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        action,
        key: res.key,
        delivered: res.delivered,
        error: res.error,
        timestamp: new Date().toLocaleTimeString(),
        elapsedMs,
      };
      setLastResult({
        action,
        delivered: res.delivered,
        key: res.key,
        error: res.error,
        timestamp: record.timestamp,
        latencyMs: elapsedMs,
      });
      setLogs((prev) => [record, ...prev.slice(0, 9)]);
    } catch (err) {
      const elapsedMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const record: RemoteActionLog = {
        id: `rem-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        action,
        delivered: false,
        error: errorMsg,
        timestamp: new Date().toLocaleTimeString(),
        elapsedMs,
      };
      setLastResult({
        action,
        delivered: false,
        error: errorMsg,
        timestamp: record.timestamp,
        latencyMs: elapsedMs,
      });
      setLogs((prev) => [record, ...prev.slice(0, 9)]);
    } finally {
      setIsSending(false);
      setTimeout(() => setActiveKey(null), 180);
    }
  };

  // Keyboard navigation shortcuts when remote is active
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in input
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      ) {
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        void dispatchKey("up");
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        void dispatchKey("down");
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        void dispatchKey("left");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        void dispatchKey("right");
      } else if (e.key === "Enter") {
        e.preventDefault();
        void dispatchKey("select");
      } else if (e.key === "Backspace" || e.key === "Escape") {
        e.preventDefault();
        void dispatchKey("back");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [targetSerial]);

  return (
    <div
      className="card"
      style={{
        background: "var(--nx-surface-raised)",
        border: "1px solid var(--nx-line)",
        borderRadius: "var(--nx-radius-lg)",
        padding: "1.5rem",
        boxShadow: "var(--nx-shadow-popover)",
      }}
    >
      {/* Remote Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "1rem",
          paddingBottom: "1.25rem",
          borderBottom: "1px solid var(--nx-line)",
          marginBottom: "1.5rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <div
            style={{
              width: "40px",
              height: "40px",
              borderRadius: "var(--nx-radius-md)",
              background: "var(--nx-accent-muted)",
              color: "var(--nx-accent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <IconTv size={22} />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: "1.15rem", color: "var(--nx-text)" }}>
              {tr("Fire TV & Media Remote", "Télécommande Fire TV & Médias")}
            </h3>
            <span
              style={{
                fontSize: "0.8rem",
                color: "var(--nx-text-muted)",
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
              }}
            >
              <span>ADB Target:</span>
              <code style={{ color: "var(--nx-accent)", fontWeight: 600 }}>{targetSerial}</code>
            </span>
          </div>
        </div>

        {/* Quick Power Controls */}
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button
            type="button"
            className="button compact secondary"
            onClick={() => void dispatchKey("wake")}
            disabled={isSending}
            title={tr("Turn on / Wake up display (CEC)", "Sortir de veille (HDMI-CEC)")}
            style={{
              borderColor: "var(--nx-ok-line)",
              color: "var(--nx-ok)",
              background: "var(--nx-ok-bg)",
            }}
          >
            <IconPower size={14} />
            <span>{tr("Wake / On", "Allumer")}</span>
          </button>
          <button
            type="button"
            className="button compact secondary"
            onClick={() => void dispatchKey("sleep")}
            disabled={isSending}
            title={tr("Put display to sleep", "Mettre en veille")}
            style={{
              borderColor: "var(--nx-danger-line)",
              color: "var(--nx-danger)",
              background: "var(--nx-danger-bg)",
            }}
          >
            <IconPower size={14} />
            <span>{tr("Sleep", "Veille")}</span>
          </button>
        </div>
      </div>

      {/* Main Remote Grid: Tactile Pad on Left, Controls & Audit Log on Right */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "2rem",
          alignItems: "center",
        }}
      >
        {/* Left Column: Tactile Remote Chassis */}
        <div
          style={{
            maxWidth: "320px",
            margin: "0 auto",
            width: "100%",
            background: "var(--nx-canvas-sunken)",
            borderRadius: "var(--nx-radius-xl)",
            border: "1px solid var(--nx-line-strong)",
            padding: "1.75rem 1.25rem",
            boxShadow: "inset 0 2px 6px rgba(0, 0, 0, 0.08)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "1.25rem",
          }}
        >
          {/* Top Chassis Navigation Keys: Back, Home, Menu */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              width: "100%",
              padding: "0 0.5rem",
            }}
          >
            <button
              type="button"
              className="button compact secondary"
              onClick={() => void dispatchKey("back")}
              disabled={isSending}
              title={tr("Back (KEYCODE_DPAD_BACK)", "Retour (KEYCODE_DPAD_BACK)")}
              style={{
                borderRadius: "var(--nx-radius-pill)",
                width: "42px",
                height: "42px",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: activeKey === "back" ? "var(--nx-accent)" : "var(--nx-surface-raised)",
                color: activeKey === "back" ? "var(--nx-text-on-accent)" : "var(--nx-text)",
                borderColor: "var(--nx-line)",
                transition: "all var(--nx-fast, 140ms) ease",
              }}
            >
              <IconArrowLeft size={18} />
            </button>

            <button
              type="button"
              className="button compact secondary"
              onClick={() => void dispatchKey("home")}
              disabled={isSending}
              title={tr("Home (KEYCODE_HOME)", "Accueil (KEYCODE_HOME)")}
              style={{
                borderRadius: "var(--nx-radius-pill)",
                width: "42px",
                height: "42px",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: activeKey === "home" ? "var(--nx-accent)" : "var(--nx-surface-raised)",
                color: activeKey === "home" ? "var(--nx-text-on-accent)" : "var(--nx-text)",
                borderColor: "var(--nx-line)",
                transition: "all var(--nx-fast, 140ms) ease",
              }}
            >
              <IconHome size={18} />
            </button>

            <button
              type="button"
              className="button compact secondary"
              onClick={() => void dispatchKey("menu")}
              disabled={isSending}
              title={tr("Menu (KEYCODE_MENU)", "Menu (KEYCODE_MENU)")}
              style={{
                borderRadius: "var(--nx-radius-pill)",
                width: "42px",
                height: "42px",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: activeKey === "menu" ? "var(--nx-accent)" : "var(--nx-surface-raised)",
                color: activeKey === "menu" ? "var(--nx-text-on-accent)" : "var(--nx-text)",
                borderColor: "var(--nx-line)",
                transition: "all var(--nx-fast, 140ms) ease",
              }}
            >
              <IconMenu size={18} />
            </button>
          </div>

          {/* Elegant Circular Cross D-Pad */}
          <div
            style={{
              position: "relative",
              width: "216px",
              height: "216px",
              borderRadius: "50%",
              background: "var(--nx-surface)",
              border: "2px solid var(--nx-line-strong)",
              boxShadow: "var(--nx-shadow-popover)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              userSelect: "none",
            }}
          >
            {/* UP Touch Key */}
            <button
              type="button"
              onClick={() => void dispatchKey("up")}
              disabled={isSending}
              style={{
                position: "absolute",
                top: "8px",
                left: "calc(50% - 24px)",
                width: "48px",
                height: "46px",
                background: activeKey === "up" ? "var(--nx-accent)" : "var(--nx-surface-raised)",
                color: activeKey === "up" ? "var(--nx-text-on-accent)" : "var(--nx-text)",
                border: "1px solid var(--nx-line)",
                borderRadius: "var(--nx-radius-md)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                transition: "all var(--nx-fast, 140ms) ease",
                boxShadow: activeKey === "up" ? "none" : "0 2px 4px rgba(0, 0, 0, 0.05)",
              }}
              title={tr("Direction Up (KEYCODE_DPAD_UP)", "Haut (KEYCODE_DPAD_UP)")}
            >
              <IconChevronUp size={22} />
            </button>

            {/* DOWN Touch Key */}
            <button
              type="button"
              onClick={() => void dispatchKey("down")}
              disabled={isSending}
              style={{
                position: "absolute",
                bottom: "8px",
                left: "calc(50% - 24px)",
                width: "48px",
                height: "46px",
                background: activeKey === "down" ? "var(--nx-accent)" : "var(--nx-surface-raised)",
                color: activeKey === "down" ? "var(--nx-text-on-accent)" : "var(--nx-text)",
                border: "1px solid var(--nx-line)",
                borderRadius: "var(--nx-radius-md)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                transition: "all var(--nx-fast, 140ms) ease",
                boxShadow: activeKey === "down" ? "none" : "0 2px 4px rgba(0, 0, 0, 0.05)",
              }}
              title={tr("Direction Down (KEYCODE_DPAD_DOWN)", "Bas (KEYCODE_DPAD_DOWN)")}
            >
              <IconChevronDown size={22} />
            </button>

            {/* LEFT Touch Key */}
            <button
              type="button"
              onClick={() => void dispatchKey("left")}
              disabled={isSending}
              style={{
                position: "absolute",
                left: "8px",
                top: "calc(50% - 24px)",
                width: "46px",
                height: "48px",
                background: activeKey === "left" ? "var(--nx-accent)" : "var(--nx-surface-raised)",
                color: activeKey === "left" ? "var(--nx-text-on-accent)" : "var(--nx-text)",
                border: "1px solid var(--nx-line)",
                borderRadius: "var(--nx-radius-md)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                transition: "all var(--nx-fast, 140ms) ease",
                boxShadow: activeKey === "left" ? "none" : "0 2px 4px rgba(0, 0, 0, 0.05)",
              }}
              title={tr("Direction Left (KEYCODE_DPAD_LEFT)", "Gauche (KEYCODE_DPAD_LEFT)")}
            >
              <IconChevronLeft size={22} />
            </button>

            {/* RIGHT Touch Key */}
            <button
              type="button"
              onClick={() => void dispatchKey("right")}
              disabled={isSending}
              style={{
                position: "absolute",
                right: "8px",
                top: "calc(50% - 24px)",
                width: "46px",
                height: "48px",
                background: activeKey === "right" ? "var(--nx-accent)" : "var(--nx-surface-raised)",
                color: activeKey === "right" ? "var(--nx-text-on-accent)" : "var(--nx-text)",
                border: "1px solid var(--nx-line)",
                borderRadius: "var(--nx-radius-md)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                transition: "all var(--nx-fast, 140ms) ease",
                boxShadow: activeKey === "right" ? "none" : "0 2px 4px rgba(0, 0, 0, 0.05)",
              }}
              title={tr("Direction Right (KEYCODE_DPAD_RIGHT)", "Droite (KEYCODE_DPAD_RIGHT)")}
            >
              <IconChevronRight size={22} />
            </button>

            {/* CENTRAL SELECT (OK) Touch Key */}
            <button
              type="button"
              onClick={() => void dispatchKey("select")}
              disabled={isSending}
              style={{
                width: "72px",
                height: "72px",
                borderRadius: "50%",
                background:
                  activeKey === "select"
                    ? "var(--nx-accent)"
                    : "var(--nx-surface-sunken, var(--nx-canvas))",
                color: activeKey === "select" ? "var(--nx-text-on-accent)" : "var(--nx-text)",
                border: "2px solid var(--nx-line-strong)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                fontWeight: 700,
                fontSize: "0.85rem",
                letterSpacing: "0.08em",
                transition: "all var(--nx-fast, 140ms) ease",
                boxShadow: "var(--nx-shadow-popover)",
                zIndex: 2,
              }}
              title={tr(
                "Select / Validate (KEYCODE_DPAD_CENTER)",
                "Valider / OK (KEYCODE_DPAD_CENTER)",
              )}
            >
              <span>OK</span>
            </button>
          </div>

          {/* Media Play/Pause Bar */}
          <div style={{ width: "100%", padding: "0 0.5rem" }}>
            <button
              type="button"
              className="button secondary"
              onClick={() => void dispatchKey("play_pause")}
              disabled={isSending}
              title={tr(
                "Play / Pause (KEYCODE_MEDIA_PLAY_PAUSE)",
                "Lecture / Pause (KEYCODE_MEDIA_PLAY_PAUSE)",
              )}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.5rem",
                borderRadius: "var(--nx-radius-md)",
                background:
                  activeKey === "play_pause" ? "var(--nx-accent)" : "var(--nx-surface-raised)",
                color: activeKey === "play_pause" ? "var(--nx-text-on-accent)" : "var(--nx-text)",
                borderColor: "var(--nx-line)",
                transition: "all var(--nx-fast, 140ms) ease",
              }}
            >
              <IconPlay size={16} />
              <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>
                {tr("Play / Pause", "Lecture / Pause")}
              </span>
            </button>
          </div>

          {/* Tactile Volume Bar (+, -, Mute) */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
              background: "var(--nx-surface-raised)",
              border: "1px solid var(--nx-line)",
              borderRadius: "var(--nx-radius-pill)",
              padding: "0.35rem 0.6rem",
              boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
            }}
          >
            {/* Volume Minus */}
            <button
              type="button"
              className="button compact secondary"
              onClick={() => void dispatchKey("volume_down")}
              disabled={isSending}
              title={tr("Volume Down (KEYCODE_VOLUME_DOWN)", "Volume Moins (KEYCODE_VOLUME_DOWN)")}
              style={{
                borderRadius: "var(--nx-radius-pill)",
                width: "36px",
                height: "36px",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: activeKey === "volume_down" ? "var(--nx-accent)" : "transparent",
                color: activeKey === "volume_down" ? "var(--nx-text-on-accent)" : "var(--nx-text)",
                borderColor: "transparent",
              }}
            >
              <IconMinus size={16} />
            </button>

            {/* Mute */}
            <button
              type="button"
              className="button compact secondary"
              onClick={() => void dispatchKey("mute")}
              disabled={isSending}
              title={tr("Mute (KEYCODE_VOLUME_MUTE)", "Couper le son (KEYCODE_VOLUME_MUTE)")}
              style={{
                borderRadius: "var(--nx-radius-pill)",
                width: "36px",
                height: "36px",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: activeKey === "mute" ? "var(--nx-warn-bg)" : "transparent",
                color: activeKey === "mute" ? "var(--nx-warn)" : "var(--nx-text-muted)",
                borderColor: "transparent",
              }}
            >
              <IconVolumeX size={16} />
            </button>

            {/* Volume Plus */}
            <button
              type="button"
              className="button compact secondary"
              onClick={() => void dispatchKey("volume_up")}
              disabled={isSending}
              title={tr("Volume Up (KEYCODE_VOLUME_UP)", "Volume Plus (KEYCODE_VOLUME_UP)")}
              style={{
                borderRadius: "var(--nx-radius-pill)",
                width: "36px",
                height: "36px",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: activeKey === "volume_up" ? "var(--nx-accent)" : "transparent",
                color: activeKey === "volume_up" ? "var(--nx-text-on-accent)" : "var(--nx-text)",
                borderColor: "transparent",
              }}
            >
              <IconPlus size={16} />
            </button>
          </div>
        </div>

        {/* Right Column: Status & Real-time Action Telemetry */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {/* Target TV (the account's own list) */}
          <div
            style={{
              padding: "1rem",
              background: "var(--nx-canvas-sunken)",
              borderRadius: "var(--nx-radius-md)",
              border: "1px solid var(--nx-line)",
              display: "grid",
              gap: "0.5rem",
            }}
          >
            <label
              htmlFor="remote-serial"
              style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--nx-text)" }}
            >
              {tr("Target TV", "TV ciblée")}
            </label>
            {(tvs.data ?? []).length === 0 ? (
              <span style={{ fontSize: "0.8rem", color: "var(--nx-text-muted)" }}>
                {tr(
                  "No TV yet. Enable ADB debugging on the TV (Developer options), then add its address below. TVs Home Assistant manages also appear in the Home tab.",
                  "Aucune TV. Activez le débogage ADB sur la TV (Options pour les développeurs), puis ajoutez son adresse ci-dessous. Les TV gérées par Home Assistant apparaissent aussi dans l'onglet Maison.",
                )}
              </span>
            ) : (
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <select
                  id="remote-serial"
                  className="input"
                  value={targetSerial}
                  onChange={(e) => setTargetSerial(e.target.value)}
                  style={{ flex: 1 }}
                >
                  {(tvs.data ?? []).map((tv) => (
                    <option key={tv.serial} value={tv.serial}>
                      {tv.name} ({tv.serial})
                    </option>
                  ))}
                </select>
                {(tvs.data ?? []).some((tv) => tv.serial === targetSerial && !tv.shared) && (
                  <button
                    type="button"
                    className="button secondary"
                    title={tr("Remove this TV", "Retirer cette TV")}
                    onClick={() =>
                      void api
                        .removeHomeTv(targetSerial)
                        .then(() => {
                          setTargetSerial("");
                          tvs.reload();
                        })
                        .catch((e: unknown) =>
                          setTvError(e instanceof Error ? e.message : String(e)),
                        )
                    }
                  >
                    <IconClose size={14} />
                  </button>
                )}
              </div>
            )}
            <form
              style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}
              onSubmit={(e) => {
                e.preventDefault();
                setTvError(null);
                void api
                  .addHomeTv(newTvSerial.trim(), newTvName.trim() || "TV")
                  .then((tv) => {
                    setNewTvSerial("");
                    setNewTvName("");
                    setTargetSerial(tv.serial);
                    tvs.reload();
                  })
                  .catch((err: unknown) =>
                    setTvError(err instanceof Error ? err.message : String(err)),
                  );
              }}
            >
              <input
                className="input"
                style={{ flex: 2, minWidth: 140 }}
                placeholder={tr("TV address (host:5555)", "Adresse de la TV (hôte:5555)")}
                value={newTvSerial}
                onChange={(e) => setNewTvSerial(e.target.value)}
              />
              <input
                className="input"
                style={{ flex: 1, minWidth: 90 }}
                placeholder={tr("Name", "Nom")}
                value={newTvName}
                onChange={(e) => setNewTvName(e.target.value)}
              />
              <button
                type="submit"
                className="button secondary"
                disabled={newTvSerial.trim() === ""}
              >
                <IconPlus size={14} />
              </button>
            </form>
            {tvError && (
              <span style={{ fontSize: "0.75rem", color: "var(--nx-danger)" }}>{tvError}</span>
            )}
          </div>

          {/* Last Dispatched Action Badge */}
          {lastResult && (
            <div
              style={{
                padding: "0.9rem 1.1rem",
                borderRadius: "var(--nx-radius-md)",
                background: lastResult.delivered ? "var(--nx-ok-bg)" : "var(--nx-accent-muted)",
                border: `1px solid ${
                  lastResult.delivered ? "var(--nx-ok-line)" : "var(--nx-accent-line)"
                }`,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <span
                  style={{
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: lastResult.delivered ? "var(--nx-ok)" : "var(--nx-accent)",
                    display: "block",
                  }}
                >
                  {lastResult.delivered
                    ? tr("COMMAND DELIVERED", "COMMANDE ENVOYÉE")
                    : tr("DISPATCH REGISTERED", "COMMANDE ENREGISTRÉE")}
                </span>
                <span style={{ fontSize: "0.95rem", fontWeight: 600, color: "var(--nx-text)" }}>
                  Action: <code>{lastResult.action}</code>
                  {lastResult.key ? ` → ${lastResult.key}` : ""}
                </span>
                {lastResult.error && (
                  <span
                    style={{
                      display: "block",
                      fontSize: "0.75rem",
                      color: "var(--nx-text-muted)",
                      marginTop: "0.2rem",
                    }}
                  >
                    Note: {lastResult.error}
                  </span>
                )}
              </div>
              <span
                style={{
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  color: "var(--nx-text-muted)",
                  background: "var(--nx-surface-raised)",
                  padding: "0.2rem 0.6rem",
                  borderRadius: "var(--nx-radius-pill)",
                  border: "1px solid var(--nx-line)",
                }}
              >
                {lastResult.latencyMs} ms
              </span>
            </div>
          )}

          {/* Real-time Remote Action Log */}
          <div>
            <h4
              style={{
                margin: "0 0 0.5rem 0",
                fontSize: "0.85rem",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--nx-text-muted)",
              }}
            >
              {tr("Recent Remote Dispatches", "Dernières Touches Envoyées")}
            </h4>
            {logs.length === 0 ? (
              <div
                style={{
                  padding: "1rem",
                  textAlign: "center",
                  color: "var(--nx-text-muted)",
                  fontSize: "0.85rem",
                  border: "1px dashed var(--nx-line)",
                  borderRadius: "var(--nx-radius-md)",
                }}
              >
                {tr(
                  "No keys pressed yet. Use the D-pad or keyboard arrows to control.",
                  "Aucune touche envoyée. Utilisez le D-pad tactile ou les flèches du clavier.",
                )}
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.35rem",
                  maxHeight: "180px",
                  overflowY: "auto",
                }}
              >
                {logs.map((log) => (
                  <div
                    key={log.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "0.4rem 0.75rem",
                      borderRadius: "var(--nx-radius-sm)",
                      background: "var(--nx-canvas-sunken)",
                      border: "1px solid var(--nx-line)",
                      fontSize: "0.8rem",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <span
                        style={{
                          width: "6px",
                          height: "6px",
                          borderRadius: "50%",
                          background: log.delivered ? "var(--nx-ok)" : "var(--nx-accent)",
                        }}
                      />
                      <strong>{log.action}</strong>
                      <code style={{ fontSize: "0.75rem", color: "var(--nx-text-muted)" }}>
                        {log.key ?? "KEYCODE"}
                      </code>
                    </div>
                    <span style={{ color: "var(--nx-text-muted)", fontSize: "0.75rem" }}>
                      {log.elapsedMs !== undefined ? `${log.elapsedMs}ms · ` : ""}
                      {log.timestamp}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Domotique & Flotte Satellites ESP32 (Smart Home Lab Section)
// ─────────────────────────────────────────────────────────────────────────────

export function Domotique({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const [selectedRoom, setSelectedRoom] = useState<string>("all");
  const [activeTab, setActiveTab] = useState<DomotiqueTab>("home");
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const [commandHistory, setCommandHistory] = useState<CommandExecutionRecord[]>([]);
  const [domotiqueMode, setDomotiqueMode] = useState<DomotiqueMode>("normal");
  const [modeNotice, setModeNotice] = useState<string | null>(null);

  // Pairing drawer state
  const [pairingOpen, setPairingOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const state = useSection(() => api.satellites());
  useEffect(() => {
    const timer = setInterval(() => state.reload(), 4_000);
    return () => clearInterval(timer);
  }, [state.reload]);

  const executeCommand = async (
    deviceId: string,
    command: SatelliteCommandName,
    params: Record<string, unknown> = {},
  ) => {
    setBusyDevice(deviceId);
    setActionError(null);
    const correlationId = `cmd-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const startTime = Date.now();

    const record: CommandExecutionRecord = {
      id: correlationId,
      deviceId,
      command,
      correlationId,
      status: "queued",
      timestamp: new Date().toLocaleTimeString(),
    };

    setCommandHistory((prev) => [record, ...prev.slice(0, 19)]);

    try {
      const accepted: SatelliteCommandAccepted = await api.sendSatelliteCommand(
        deviceId,
        command,
        params,
        correlationId,
      );
      const elapsedMs = Date.now() - startTime;

      setCommandHistory((prev) =>
        prev.map((item) =>
          item.id === correlationId
            ? {
                ...item,
                status: accepted.correlationId ? "delivered" : "failed",
                elapsedMs,
              }
            : item,
        ),
      );
      void state.reload();
    } catch (err) {
      const elapsedMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : "Command dispatch failed.";
      setActionError(errorMsg);
      setCommandHistory((prev) =>
        prev.map((item) =>
          item.id === correlationId
            ? {
                ...item,
                status: "failed",
                message: errorMsg,
                elapsedMs,
              }
            : item,
        ),
      );
    } finally {
      setBusyDevice(null);
    }
  };

  const handleApplyDomotiqueMode = async (mode: DomotiqueMode) => {
    setDomotiqueMode(mode);
    setModeNotice(null);
    setActionError(null);
    const onlineSats = (state.data?.satellites ?? []).filter((s) => s.online);

    try {
      if (mode === "silence") {
        await Promise.all(
          onlineSats.map((sat) =>
            api.sendSatelliteCommand(sat.deviceId, "audio.privacy", { muted: true }),
          ),
        );
        setModeNotice(
          tr(
            `Silence mode engaged: Microphones muted across ${onlineSats.length} satellite(s).`,
            `Mode silence engagé : Micros coupés sur ${onlineSats.length} satellite(s).`,
          ),
        );
      } else if (mode === "normal") {
        await Promise.all(
          onlineSats.map((sat) =>
            api.sendSatelliteCommand(sat.deviceId, "audio.privacy", { muted: false }),
          ),
        );
        setModeNotice(
          tr(
            `Normal mode engaged: Ambient listening active on ${onlineSats.length} satellite(s).`,
            `Mode normal engagé : Écoute ambiante active sur ${onlineSats.length} satellite(s).`,
          ),
        );
      } else if (mode === "nuit") {
        await Promise.all(
          onlineSats.map((sat) =>
            api.sendSatelliteCommand(sat.deviceId, "audio.privacy", { muted: true }),
          ),
        );
        setModeNotice(
          tr(
            `Night mode engaged: Audio privacy activated and brightness dimmed.`,
            `Mode nuit engagé : Confidentialité activée et luminosité atténuée.`,
          ),
        );
      } else if (mode === "intercom") {
        await Promise.all(
          onlineSats.map((sat) =>
            api.sendSatelliteCommand(sat.deviceId, "system.diagnostics", {
              target: "speaker",
              test: "chime",
            }),
          ),
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

  const fleet = state.data?.satellites ?? [];

  // Group fleet by room
  const roomsMap = useMemo(() => {
    const map = new Map<string, SatelliteView[]>();
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
    selectedRoom === "all" ? fleet : fleet.filter((s) => extractRoom(s) === selectedRoom);

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
        <div
          className="banner"
          style={{
            background: "var(--nx-accent-muted)",
            border: "1px solid var(--nx-accent-line)",
            color: "var(--nx-text)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>{modeNotice}</span>
          <button
            type="button"
            className="button compact secondary"
            onClick={() => setModeNotice(null)}
          >
            <IconClose size={14} />
          </button>
        </div>
      )}

      {/* Main Domotique Hub Header */}
      <section className="card" aria-labelledby="domotique-title">
        <div className="pairing-heading">
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                marginBottom: "0.25rem",
              }}
            >
              <IconHome size={22} color="var(--nx-accent)" />
              <span className="eyebrow" style={{ margin: 0 }}>
                {tr("NEXUS SMART HOME LAB", "LABORATOIRE DOMOTIQUE NEXUS")}
              </span>
            </div>
            <h2 id="domotique-title" style={{ margin: "0.25rem 0 0.5rem" }}>
              {tr("Domotique, Satellites & Télécommande", "Domotique, Satellites & Télécommande")}
            </h2>
            <p className="muted">
              {tr(
                "Centralized smart home automation, zone telemetry, ESP32 satellite fleet diagnostics, and Fire TV remote control.",
                "Supervision domotique centralisée, télémétrie par pièce, diagnostic de la flotte ESP32 et télécommande Fire TV.",
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
              onClick={() => setPairingOpen(!pairingOpen)}
            >
              <IconHardware size={16} />
              <span>
                {pairingOpen
                  ? tr("Close", "Fermer")
                  : tr("Add a satellite", "Ajouter un satellite")}
              </span>
            </button>
          </div>
        </div>

        {/* Global Domotique Automation Modes & Tab Switcher */}
        <div
          style={{
            marginTop: "1.25rem",
            padding: "1rem",
            background: "var(--nx-canvas-sunken)",
            borderRadius: "var(--nx-radius-md)",
            border: "1px solid var(--nx-line)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "1rem",
          }}
        >
          <div>
            <span
              style={{
                fontSize: "0.85rem",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--nx-text-muted)",
              }}
            >
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
                title={tr(
                  "Mute microphones across all rooms",
                  "Couper les micros de toutes les pièces",
                )}
              >
                <IconMicOff size={14} />
                <span>{tr("Silence / Privacy", "Silence / Privé")}</span>
              </button>
              <button
                type="button"
                className={`button compact ${domotiqueMode === "nuit" ? "primary" : "secondary"}`}
                onClick={() => void handleApplyDomotiqueMode("nuit")}
                title={tr(
                  "Night mode: privacy and reduced audio volume",
                  "Mode nuit : confidentialité et volume discret",
                )}
              >
                <IconVolumeX size={14} />
                <span>{tr("Night Mode", "Mode Nuit")}</span>
              </button>
              <button
                type="button"
                className={`button compact ${domotiqueMode === "intercom" ? "primary" : "secondary"}`}
                onClick={() => void handleApplyDomotiqueMode("intercom")}
                title={tr(
                  "Broadcast chime across all satellites",
                  "Diffuser un carillon sur tous les satellites",
                )}
              >
                <IconVolume size={14} />
                <span>{tr("Intercom Chime", "Carillon Intercom")}</span>
              </button>
            </div>
          </div>

          {/* Quick Metrics Bar */}
          <div style={{ display: "flex", gap: "1.25rem", alignItems: "center" }}>
            <div>
              <span className="muted" style={{ fontSize: "0.75rem", display: "block" }}>
                {tr("Active Satellites", "Satellites actifs")}
              </span>
              <span
                style={{
                  fontSize: "1.25rem",
                  fontWeight: 700,
                  color: onlineCount > 0 ? "var(--nx-accent-line)" : "var(--nx-text-muted)",
                }}
              >
                {onlineCount} / {totalSatellites}
              </span>
            </div>
            <div>
              <span className="muted" style={{ fontSize: "0.75rem", display: "block" }}>
                {tr("Microphones Listening", "Micros à l'écoute")}
              </span>
              <span
                style={{
                  fontSize: "1.25rem",
                  fontWeight: 700,
                  color: micActiveCount > 0 ? "var(--nx-ok)" : "var(--nx-warn)",
                }}
              >
                {micActiveCount}
              </span>
            </div>
            {avgBattery !== null && (
              <div>
                <span className="muted" style={{ fontSize: "0.75rem", display: "block" }}>
                  {tr("Avg Battery", "Batterie moy.")}
                </span>
                <span
                  style={{
                    fontSize: "1.25rem",
                    fontWeight: 700,
                    color: avgBattery > 20 ? "var(--nx-text)" : "var(--nx-danger)",
                  }}
                >
                  {avgBattery}%
                </span>
              </div>
            )}
          </div>
        </div>

        {/* View Switcher Tabs (Flotte vs Télécommande) */}
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            marginTop: "1.25rem",
            borderBottom: "1px solid var(--nx-line)",
            paddingBottom: "0.75rem",
          }}
        >
          <button
            type="button"
            className={`button ${activeTab === "home" ? "primary" : "secondary"}`}
            onClick={() => setActiveTab("home")}
          >
            <IconHome size={16} />
            <span>{tr("Home", "Maison")}</span>
          </button>
          <button
            type="button"
            className={`button ${activeTab === "automations" ? "primary" : "secondary"}`}
            onClick={() => setActiveTab("automations")}
          >
            <IconClock size={16} />
            <span>{tr("Scenes & routines", "Scènes & routines")}</span>
          </button>
          <button
            type="button"
            className={`button ${activeTab === "voice" ? "primary" : "secondary"}`}
            onClick={() => setActiveTab("voice")}
          >
            <IconMic size={16} />
            <span>{tr("Voice satellites", "Satellites vocaux")}</span>
          </button>
          <button
            type="button"
            className={`button ${activeTab === "ha" ? "primary" : "secondary"}`}
            onClick={() => setActiveTab("ha")}
          >
            <IconSettings size={16} />
            <span>Home Assistant</span>
          </button>
          <button
            type="button"
            className={`button ${activeTab === "fleet" ? "primary" : "secondary"}`}
            onClick={() => setActiveTab("fleet")}
          >
            <IconSatellite size={16} />
            <span>{tr("Satellites Fleet & Topology", "Flotte Satellites & Topologie")}</span>
          </button>
          <button
            type="button"
            className={`button ${activeTab === "remote" ? "primary" : "secondary"}`}
            onClick={() => setActiveTab("remote")}
          >
            <IconTv size={16} />
            <span>{tr("Interactive Remote Control", "Télécommande Interactive")}</span>
          </button>
        </div>

        {/* Network enrolment: a powered ESP32 announces itself, the user approves it here. */}
        {pairingOpen && (
          <div style={{ marginTop: "1.25rem" }}>
            <SatelliteEnrollmentPanel api={api} />
          </div>
        )}
      </section>

      {activeTab === "home" && (
        <HomeDevicesPanel api={api} onOpenSettings={() => setActiveTab("ha")} />
      )}
      {activeTab === "automations" && <HomeAutomationsPanel api={api} />}
      {activeTab === "voice" && <VoiceSatellitesPanel api={api} />}
      {activeTab === "ha" && <HomeAssistantPanel api={api} />}

      {/* Tab: Interactive Remote Control */}
      {activeTab === "remote" && (
        <section style={{ marginTop: "1rem" }}>
          <RemoteControl api={api} />
        </section>
      )}

      {/* Tab: Satellites Fleet & Room Topology */}
      {activeTab === "fleet" && (
        <>
          {/* Smart Home Zones Grid */}
          <section className="card" style={{ marginTop: "1rem" }} aria-labelledby="rooms-title">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "1rem",
              }}
            >
              <div>
                <h3 id="rooms-title" style={{ margin: 0 }}>
                  {tr("Rooms & Living Zones", "Pièces & Zones de vie")}
                </h3>
                <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                  {tr(
                    "Overview of audio satellites and automation coverage by room.",
                    "État de couverture acoustique et domotique par zone.",
                  )}
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

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                gap: "1rem",
              }}
            >
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
                      background: isSelected ? "var(--nx-accent-muted)" : "var(--nx-canvas-sunken)",
                      border: isSelected
                        ? "1px solid var(--nx-accent)"
                        : "1px solid var(--nx-line)",
                      padding: "1rem",
                      cursor: "pointer",
                    }}
                    onClick={() => setSelectedRoom(isSelected ? "all" : room)}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        marginBottom: "0.75rem",
                      }}
                    >
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
                          borderRadius: "var(--nx-radius-pill)",
                          background: onlineInRoom > 0 ? "var(--nx-ok-bg)" : "var(--nx-canvas)",
                          color: onlineInRoom > 0 ? "var(--nx-ok)" : "var(--nx-text-muted)",
                        }}
                      >
                        <IconSatellite size={12} />
                        <span>
                          {onlineInRoom > 0 ? tr("Covered", "Couvert") : tr("Inactive", "Inactif")}
                        </span>
                      </span>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        alignItems: "center",
                        fontSize: "0.8rem",
                        color: "var(--nx-text-muted)",
                      }}
                    >
                      {anyMicMuted ? (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.3rem",
                            color: "var(--nx-warn)",
                          }}
                        >
                          <IconMicOff size={14} color="var(--nx-warn)" />
                          <span>{tr("Muted in room", "Micro coupé")}</span>
                        </span>
                      ) : (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.3rem",
                            color: onlineInRoom > 0 ? "var(--nx-ok)" : "var(--nx-text-muted)",
                          }}
                        >
                          <IconMic
                            size={14}
                            color={onlineInRoom > 0 ? "var(--nx-ok)" : "var(--nx-text-muted)"}
                          />
                          <span>{tr("Listening", "À l'écoute")}</span>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Satellite Fleet Detailed Cards */}
          <section className="card" style={{ marginTop: "1rem" }} aria-labelledby="fleet-title">
            <div className="pairing-heading">
              <div>
                <span className="eyebrow">{tr("FLEET MANAGEMENT", "GESTION DE LA FLOTTE")}</span>
                <h3 id="fleet-title">
                  {selectedRoom === "all"
                    ? tr("All Registered Satellites", "Tous les Satellites Enregistrés")
                    : `${tr("Satellites in", "Satellites dans")} ${selectedRoom}`}
                </h3>
              </div>
              <span className="badge">
                {filteredSatellites.length} {tr("device(s)", "appareil(s)")}
              </span>
            </div>

            {filteredSatellites.length === 0 ? (
              <Empty>
                {selectedRoom === "all"
                  ? tr(
                      "No satellites have reported yet. Click 'Pair New Satellite' to generate a QR config.",
                      "Aucun satellite n'a encore transmis. Cliquez sur 'Appairer un satellite' pour générer un QR.",
                    )
                  : tr(
                      `No satellites assigned to zone "${selectedRoom}".`,
                      `Aucun satellite assigné à la zone "${selectedRoom}".`,
                    )}
              </Empty>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                  gap: "1rem",
                }}
              >
                {filteredSatellites.map((sat) => {
                  const room = extractRoom(sat);
                  const battery = extractBattery(sat.health);
                  const rssi = extractRssi(sat.health);
                  const mic = extractMic(sat.health);
                  const speaker = extractSpeaker(sat.health);
                  const firmware = extractFirmware(sat.health);
                  const uptime = extractUptime(sat.health);
                  const isBusy = busyDevice === sat.deviceId;

                  return (
                    <div
                      key={sat.deviceId}
                      className="card"
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "space-between",
                        position: "relative",
                        borderLeft: sat.online
                          ? "4px solid var(--nx-ok)"
                          : "4px solid var(--nx-danger)",
                        background: "var(--nx-surface-raised)",
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
                                color={sat.online ? "var(--nx-accent)" : "var(--nx-text-muted)"}
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
                                borderRadius: "var(--nx-radius-pill)",
                                fontWeight: 600,
                                background: sat.online ? "var(--nx-ok-bg)" : "var(--nx-danger-bg)",
                                color: sat.online ? "var(--nx-ok)" : "var(--nx-danger)",
                              }}
                            >
                              <span
                                style={{
                                  width: "6px",
                                  height: "6px",
                                  borderRadius: "50%",
                                  background: sat.online ? "var(--nx-ok)" : "var(--nx-danger)",
                                }}
                              />
                              <span>
                                {sat.online
                                  ? tr("ONLINE", "EN LIGNE")
                                  : tr("OFFLINE", "HORS LIGNE")}
                              </span>
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
                            background: "var(--nx-canvas-sunken)",
                            borderRadius: "var(--nx-radius-sm)",
                            marginBottom: "0.75rem",
                            fontSize: "0.8rem",
                          }}
                        >
                          {/* RSSI Signal */}
                          <div>
                            <span
                              className="muted"
                              style={{ display: "block", fontSize: "0.7rem" }}
                            >
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
                                      ? "var(--nx-ok)"
                                      : rssi.quality === "fair"
                                        ? "var(--nx-warn)"
                                        : "var(--nx-danger)"
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
                            <span
                              className="muted"
                              style={{ display: "block", fontSize: "0.7rem" }}
                            >
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
                                  <IconBatteryCharging size={14} color="var(--nx-ok)" />
                                ) : (
                                  <IconBattery
                                    size={14}
                                    color={
                                      battery.percent > 20 ? "var(--nx-text)" : "var(--nx-danger)"
                                    }
                                  />
                                )}
                                <span>
                                  {battery.percent}%{battery.charging ? " (chg)" : ""}
                                </span>
                              </div>
                            ) : (
                              <span className="muted">{tr("Mains", "Secteur")}</span>
                            )}
                          </div>

                          {/* Uptime */}
                          <div>
                            <span
                              className="muted"
                              style={{ display: "block", fontSize: "0.7rem" }}
                            >
                              {tr("Uptime", "Disponibilité")}
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
                            background: "var(--nx-canvas-sunken)",
                            borderRadius: "var(--nx-radius-sm)",
                            marginBottom: "0.75rem",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                            {/* Microphone Privacy Toggle */}
                            <button
                              type="button"
                              className="button compact secondary"
                              style={{
                                borderColor: mic.muted ? "var(--nx-warn)" : "var(--nx-line)",
                                color: mic.muted ? "var(--nx-warn)" : "var(--nx-text)",
                              }}
                              disabled={!sat.online || isBusy}
                              onClick={() =>
                                void executeCommand(sat.deviceId, "audio.privacy", {
                                  muted: !mic.muted,
                                })
                              }
                              title={
                                mic.muted
                                  ? tr(
                                      "Microphone is MUTED. Click to activate.",
                                      "Microphone COUPÉ. Cliquer pour activer.",
                                    )
                                  : tr(
                                      "Microphone is ACTIVE. Click to mute.",
                                      "Microphone ACTIF. Cliquer pour couper.",
                                    )
                              }
                            >
                              {mic.muted ? (
                                <IconMicOff size={14} color="var(--nx-warn)" />
                              ) : (
                                <IconMic size={14} color="var(--nx-ok)" />
                              )}
                              <span>
                                {mic.muted ? tr("Muted", "Coupé") : tr("Active", "Actif")}
                              </span>
                            </button>

                            {/* Speaker Status */}
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "0.3rem",
                                fontSize: "0.8rem",
                                color: "var(--nx-text-muted)",
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
                            onClick={() => void executeCommand(sat.deviceId, "system.ping")}
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
                              void executeCommand(sat.deviceId, "system.diagnostics", {
                                target: "audio",
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
                            onClick={() =>
                              void executeCommand(sat.deviceId, "led.set", { pattern: "blink" })
                            }
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
                                  background: "var(--nx-canvas-sunken)",
                                  padding: "0.15rem 0.4rem",
                                  borderRadius: "var(--nx-radius-xs)",
                                  color: "var(--nx-text-muted)",
                                }}
                              >
                                {cap.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
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
                  <span className="eyebrow">
                    {tr("COMMAND BUS TELEMETRY", "TÉLÉMÉTRIE DU BUS")}
                  </span>
                  <h3 id="history-title">
                    {tr("Live Hardware Command Log", "Journal des Commandes")}
                  </h3>
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
                      <th>{tr("Correlation ID", "ID Corrélation")}</th>
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
                                  ? "var(--nx-ok)"
                                  : rec.status === "failed"
                                    ? "var(--nx-danger)"
                                    : "var(--nx-warn)",
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
        </>
      )}
    </div>
  );
}

export default Domotique;
