import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type {
  DashboardApi,
  HomeAction,
  HomeActionOutcome,
  HomeAssistantStatus,
  HomeDeviceView,
  HomeRoomView,
  HomeRoutineInput,
  HomeRoutineView,
  HomeSceneInput,
  HomeSceneView,
} from "../../lib/api.js";
import { Empty, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";
import {
  IconBolt,
  IconBulb,
  IconCheck,
  IconClock,
  IconHome,
  IconLock,
  IconMic,
  IconMicOff,
  IconPlay,
  IconPlug,
  IconPlus,
  IconPower,
  IconRefresh,
  IconSatellite,
  IconSettings,
  IconShield,
  IconThermometer,
  IconTrash,
  IconTv,
  IconVolume,
  IconVolumeX,
  IconWarning,
} from "../icons.js";

/**
 * Lab 4 — Domotique panels.
 *
 * Everything shown comes from the API: Home Assistant entities, satellites,
 * the Fire TV and NEXUS workers. When Home Assistant is not connected, the
 * panels say so; they never fill the gap with sample devices.
 */

type Tr = (en: string, fr: string) => string;

function useLive<T>(load: () => Promise<T>, intervalMs: number) {
  const section = useSection(load);
  useEffect(() => {
    const timer = setInterval(() => section.reload(), intervalMs);
    return () => clearInterval(timer);
  }, [section.reload, intervalMs]);
  return section;
}

const chip = (tone: "ok" | "warn" | "danger" | "muted"): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  padding: "0.15rem 0.55rem",
  borderRadius: "var(--nx-radius-pill)",
  fontSize: "0.75rem",
  fontWeight: 600,
  border: `1px solid ${
    tone === "ok"
      ? "var(--nx-ok-line)"
      : tone === "danger"
        ? "var(--nx-danger-line)"
        : tone === "warn"
          ? "var(--nx-warn)"
          : "var(--nx-line)"
  }`,
  background:
    tone === "ok"
      ? "var(--nx-ok-bg)"
      : tone === "danger"
        ? "var(--nx-danger-bg)"
        : tone === "warn"
          ? "var(--nx-warn-bg)"
          : "var(--nx-canvas-sunken)",
  color:
    tone === "ok"
      ? "var(--nx-ok)"
      : tone === "danger"
        ? "var(--nx-danger)"
        : tone === "warn"
          ? "var(--nx-warn)"
          : "var(--nx-text-muted)",
});

const grid = (min: number): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${String(min)}px), 1fr))`,
  gap: "0.75rem",
});

const row: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "center",
  flexWrap: "wrap",
};

function connectionLabel(state: HomeAssistantStatus["connection"]["state"], tr: Tr): string {
  switch (state) {
    case "connected":
      return tr("Connected", "Connecté");
    case "connecting":
      return tr("Connecting", "Connexion en cours");
    case "unreachable":
      return tr("Unreachable, retrying", "Injoignable, nouvelle tentative");
    case "auth_failed":
      return tr("Token rejected", "Jeton refusé");
    case "token_missing":
      return tr("Token missing", "Jeton manquant");
    case "disconnected":
      return tr("Disabled", "Désactivé");
    case "not_configured":
      return tr("Not connected", "Non connecté");
  }
}

function connectionTone(
  state: HomeAssistantStatus["connection"]["state"],
): "ok" | "warn" | "danger" | "muted" {
  if (state === "connected") return "ok";
  if (state === "connecting" || state === "unreachable") return "warn";
  if (state === "auth_failed" || state === "token_missing") return "danger";
  return "muted";
}

export function HomeAssistantStatusChip({ status }: { status: HomeAssistantStatus | undefined }) {
  const { tr } = useI18n();
  if (status === undefined) return null;
  return (
    <span style={chip(connectionTone(status.connection.state))}>
      Home Assistant: {connectionLabel(status.connection.state, tr)}
    </span>
  );
}

function outcomeText(
  outcome: HomeActionOutcome | { status: string; message: string },
  tr: Tr,
): string {
  if (outcome.status === "pending_confirmation") {
    return tr(
      `Confirmation required (sensitive device): ${outcome.message}. Approve it in Confirmations.`,
      `Confirmation requise (appareil sensible) : ${outcome.message}. Validez-la dans Confirmations.`,
    );
  }
  return outcome.message;
}

// ─────────────────────────────────────────────────────────────────────────────
// Home Assistant settings
// ─────────────────────────────────────────────────────────────────────────────

const SENSITIVE_CLASS_OPTIONS: { id: string; en: string; fr: string }[] = [
  { id: "lock", en: "Locks", fr: "Serrures" },
  { id: "alarm_control_panel", en: "Alarm panels", fr: "Alarmes" },
  { id: "climate", en: "Heating / climate", fr: "Chauffage / climatisation" },
  { id: "water_heater", en: "Water heaters", fr: "Chauffe-eau" },
  { id: "cover", en: "Shutters / garage", fr: "Volets / garage" },
  { id: "switch", en: "All plugs and switches", fr: "Toutes les prises et interrupteurs" },
];

export function HomeAssistantPanel({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const status = useLive(() => api.homeAssistantStatus(), 3_000);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [classes, setClasses] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const current = status.data;

  useEffect(() => {
    if (current !== undefined && baseUrl === "" && current.baseUrl !== null)
      setBaseUrl(current.baseUrl);
    if (current !== undefined && classes === null) setClasses(current.sensitiveClasses);
  }, [current, baseUrl, classes]);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setNotice(null);
    try {
      setNotice({ tone: "ok", text: await work() });
      status.reload();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      await api.configureHomeAssistant({
        baseUrl: baseUrl.trim(),
        ...(token.trim() === "" ? {} : { token: token.trim() }),
        enabled: true,
        ...(classes === null ? {} : { sensitiveClasses: classes }),
      });
      setToken("");
      return tr("Saved. Connecting to Home Assistant.", "Enregistré. Connexion à Home Assistant.");
    });

  const connection = current?.connection;
  return (
    <section className="card" style={{ marginTop: "1rem" }} aria-labelledby="ha-title">
      <div className="pairing-heading">
        <div>
          <span className="eyebrow">{tr("THE HANDS OF NEXUS", "LES MAINS DE NEXUS")}</span>
          <h3 id="ha-title" style={{ margin: "0.25rem 0" }}>
            Home Assistant
          </h3>
          <p className="muted" style={{ margin: 0 }}>
            {tr(
              "Home Assistant speaks Wi-Fi, Zigbee, Matter and TV protocols; NEXUS decides. Create a long-lived access token in your HA profile (Security tab) and paste it here. See docs/integration/home-assistant.md.",
              "Home Assistant parle Wi-Fi, Zigbee, Matter et TV ; NEXUS décide. Créez un jeton d'accès longue durée dans votre profil HA (onglet Sécurité) et collez-le ici. Voir docs/integration/home-assistant.md.",
            )}
          </p>
        </div>
        <HomeAssistantStatusChip status={current} />
      </div>

      {status.error && <p className="banner error">{status.error}</p>}
      {notice && (
        <p className={`banner ${notice.tone === "error" ? "error" : ""}`}>{notice.text}</p>
      )}

      {connection && (
        <div style={{ ...grid(180), marginTop: "1rem" }}>
          <Stat
            label={tr("Connection", "Connexion")}
            value={connectionLabel(connection.state, tr)}
          />
          <Stat label={tr("HA version", "Version HA")} value={connection.haVersion ?? "-"} />
          <Stat label={tr("Entities", "Entités")} value={String(current?.entityCount ?? 0)} />
          <Stat label={tr("Areas", "Zones")} value={String(current?.areaCount ?? 0)} />
          <Stat
            label={tr("Token", "Jeton")}
            value={
              current?.token.stored
                ? current.token.persistence === "vault"
                  ? tr("Stored in vault", "Dans le coffre")
                  : tr("In memory only", "En mémoire seulement")
                : tr("None", "Aucun")
            }
          />
          <Stat
            label={tr("Last sync", "Dernière synchro")}
            value={current?.syncedAt ? new Date(current.syncedAt).toLocaleTimeString() : "-"}
          />
        </div>
      )}
      {connection?.lastError && (
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          <IconWarning size={14} /> {connection.lastError}
          {connection.nextRetryAt &&
            ` · ${tr("next retry", "prochaine tentative")} ${new Date(connection.nextRetryAt).toLocaleTimeString()}`}
        </p>
      )}

      <form
        style={{ display: "grid", gap: "0.75rem", marginTop: "1.25rem", maxWidth: 640 }}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label style={{ display: "grid", gap: "0.3rem" }}>
          <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>
            {tr("Home Assistant URL", "URL de Home Assistant")}
          </span>
          <input
            className="input"
            type="url"
            required
            placeholder="http://192.168.1.10:8123"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <label style={{ display: "grid", gap: "0.3rem" }}>
          <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>
            {tr("Long-lived access token", "Jeton d'accès longue durée")}
          </span>
          <input
            className="input"
            type="password"
            autoComplete="off"
            placeholder={
              current?.token.stored
                ? tr(
                    "Stored. Leave empty to keep it.",
                    "Enregistré. Laisser vide pour le conserver.",
                  )
                : "eyJ..."
            }
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <fieldset
          style={{
            border: "1px solid var(--nx-line)",
            borderRadius: "var(--nx-radius-md)",
            padding: "0.75rem",
          }}
        >
          <legend style={{ fontWeight: 600, fontSize: "0.85rem", padding: "0 0.3rem" }}>
            <IconShield size={14} />{" "}
            {tr("Always ask for confirmation for", "Toujours demander confirmation pour")}
          </legend>
          <div style={grid(220)}>
            {SENSITIVE_CLASS_OPTIONS.map((option) => (
              <label key={option.id} style={row}>
                <input
                  type="checkbox"
                  checked={(classes ?? []).includes(option.id)}
                  onChange={(e) =>
                    setClasses((prev) => {
                      const set = new Set(prev ?? []);
                      if (e.target.checked) set.add(option.id);
                      else set.delete(option.id);
                      return [...set];
                    })
                  }
                />
                <span>{tr(option.en, option.fr)}</span>
              </label>
            ))}
          </div>
          <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.8rem" }}>
            {tr(
              "Individual devices (e.g. a high-power plug) can be flagged from their card.",
              "Un appareil précis (ex. prise de forte puissance) peut être marqué depuis sa carte.",
            )}
          </p>
        </fieldset>
        <div style={row}>
          <button type="submit" className="button primary" disabled={busy || baseUrl.trim() === ""}>
            <IconCheck size={16} />
            <span>{tr("Save and connect", "Enregistrer et connecter")}</span>
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || !current?.configured}
            onClick={() =>
              void run(async () => {
                const result = await api.testHomeAssistant();
                return result.ok
                  ? `${tr("Reachable", "Joignable")}: ${result.locationName ?? "Home Assistant"} ${result.version ?? ""}`
                  : (result.error ?? tr("Unreachable", "Injoignable"));
              })
            }
          >
            <IconBolt size={16} />
            <span>{tr("Test", "Tester")}</span>
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || connection?.state !== "connected"}
            onClick={() =>
              void run(async () => {
                await api.resyncHomeAssistant();
                return tr(
                  "Entities, areas and devices re-read.",
                  "Entités, zones et appareils relus.",
                );
              })
            }
          >
            <IconRefresh size={16} />
            <span>{tr("Resync", "Resynchroniser")}</span>
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || !current?.configured}
            onClick={() => {
              if (
                !window.confirm(
                  tr(
                    "Unlink Home Assistant and delete its token?",
                    "Délier Home Assistant et supprimer son jeton ?",
                  ),
                )
              )
                return;
              void run(async () => {
                await api.unlinkHomeAssistant();
                setBaseUrl("");
                return tr("Home Assistant unlinked.", "Home Assistant délié.");
              });
            }}
          >
            <IconTrash size={16} />
            <span>{tr("Unlink", "Délier")}</span>
          </button>
        </div>
      </form>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div
      style={{
        background: "var(--nx-canvas-sunken)",
        border: "1px solid var(--nx-line)",
        borderRadius: "var(--nx-radius-md)",
        padding: "0.6rem 0.8rem",
      }}
    >
      <div
        className="muted"
        style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em" }}
      >
        {label}
      </div>
      <div style={{ fontWeight: 600, marginTop: "0.2rem" }}>{value}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Rooms & devices
// ─────────────────────────────────────────────────────────────────────────────

function DeviceIcon({ device }: { device: HomeDeviceView }) {
  const color = device.state.on ? "var(--nx-accent)" : "var(--nx-text-muted)";
  switch (device.domain) {
    case "light":
      return (
        <IconBulb
          size={20}
          color={device.state.on && device.state.color ? device.state.color : color}
        />
      );
    case "switch":
    case "fan":
      return <IconPlug size={20} color={color} />;
    case "media_player":
    case "fire_tv":
      return <IconTv size={20} color={color} />;
    case "lock":
      return <IconLock size={20} color={color} />;
    case "climate":
    case "water_heater":
      return <IconThermometer size={20} color={color} />;
    case "satellite":
      return <IconSatellite size={20} color={color} />;
    case "alarm_control_panel":
      return <IconShield size={20} color={color} />;
    default:
      return <IconPower size={20} color={color} />;
  }
}

export function HomeDevicesPanel({
  api,
  onOpenSettings,
}: {
  api: DashboardApi;
  onOpenSettings: () => void;
}) {
  const { tr } = useI18n();
  const home = useLive(() => api.homeDevices(), 3_000);
  const [roomFilter, setRoomFilter] = useState<string>("all");
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [newRoom, setNewRoom] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const devices = home.data?.devices ?? [];
  const rooms = home.data?.rooms ?? [];
  const status = home.data?.homeAssistant;
  const unassigned = devices.filter((d) => d.roomId === null);

  const act = async (device: HomeDeviceView, action: HomeAction) => {
    setBusy(device.id);
    setNotice(null);
    try {
      const outcome = await api.runHomeDeviceAction(device.id, action);
      setNotice({
        tone: outcome.status === "failed" ? "error" : "ok",
        text: outcomeText(outcome, tr),
      });
      home.reload();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const patchDevice = async (
    device: HomeDeviceView,
    patch: Parameters<DashboardApi["updateHomeDevice"]>[1],
  ) => {
    try {
      await api.updateHomeDevice(device.id, patch);
      home.reload();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const roomAction = async (work: () => Promise<unknown>) => {
    try {
      await work();
      home.reload();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const visibleRooms: {
    id: string;
    room: HomeRoomView | null;
    name: string;
    devices: HomeDeviceView[];
  }[] = [
    ...rooms.map((room) => ({
      id: room.id,
      room,
      name: room.name,
      devices: devices.filter((d) => d.roomId === room.id),
    })),
    ...(unassigned.length > 0
      ? [{ id: "unassigned", room: null, name: tr("No room", "Sans pièce"), devices: unassigned }]
      : []),
  ].filter((group) => roomFilter === "all" || group.id === roomFilter);

  const selectedRoom = rooms.find((r) => r.id === roomFilter);

  return (
    <>
      {status && status.connection.state !== "connected" && (
        <section
          className="card"
          style={{
            marginTop: "1rem",
            border: "1px solid var(--nx-warn)",
            background: "var(--nx-warn-bg)",
          }}
        >
          <div style={{ ...row, justifyContent: "space-between" }}>
            <div style={row}>
              <IconWarning size={18} color="var(--nx-warn)" />
              <strong>
                {status.configured
                  ? `Home Assistant: ${connectionLabel(status.connection.state, tr)}`
                  : tr("Home Assistant is not connected", "Home Assistant n'est pas connecté")}
              </strong>
              <span className="muted">
                {tr(
                  "Lights, plugs and TVs managed by Home Assistant will appear once it is connected.",
                  "Les lumières, prises et TV gérées par Home Assistant apparaîtront une fois connecté.",
                )}
              </span>
            </div>
            <button type="button" className="button compact primary" onClick={onOpenSettings}>
              <IconSettings size={14} />
              <span>{tr("Configure", "Configurer")}</span>
            </button>
          </div>
        </section>
      )}

      {home.error && <p className="banner error">{home.error}</p>}
      {notice && (
        <p className={`banner ${notice.tone === "error" ? "error" : ""}`}>{notice.text}</p>
      )}

      <section className="card" style={{ marginTop: "1rem" }} aria-labelledby="home-rooms-title">
        <div className="pairing-heading">
          <div>
            <span className="eyebrow">{tr("ROOMS", "PIÈCES")}</span>
            <h3 id="home-rooms-title" style={{ margin: "0.25rem 0" }}>
              {tr("Rooms & devices", "Pièces & appareils")}
            </h3>
            <p className="muted" style={{ margin: 0 }}>
              {tr(
                `${String(devices.length)} device(s), ${String(devices.filter((d) => d.online).length)} online. Rooms mirror Home Assistant areas and can be renamed.`,
                `${String(devices.length)} appareil(s), ${String(devices.filter((d) => d.online).length)} en ligne. Les pièces reprennent les zones Home Assistant et peuvent être renommées.`,
              )}
            </p>
          </div>
          <HomeAssistantStatusChip status={status} />
        </div>

        <div style={{ ...row, marginTop: "1rem" }}>
          <button
            type="button"
            className={`button compact ${roomFilter === "all" ? "primary" : "secondary"}`}
            onClick={() => setRoomFilter("all")}
          >
            {tr("All", "Toutes")}
          </button>
          {rooms.map((room) => (
            <button
              key={room.id}
              type="button"
              className={`button compact ${roomFilter === room.id ? "primary" : "secondary"}`}
              onClick={() => setRoomFilter(room.id)}
            >
              {room.name}
            </button>
          ))}
          {unassigned.length > 0 && (
            <button
              type="button"
              className={`button compact ${roomFilter === "unassigned" ? "primary" : "secondary"}`}
              onClick={() => setRoomFilter("unassigned")}
            >
              {tr("No room", "Sans pièce")}
            </button>
          )}
          <form
            style={{ ...row, marginLeft: "auto" }}
            onSubmit={(e) => {
              e.preventDefault();
              if (newRoom.trim() === "") return;
              void roomAction(() => api.createHomeRoom(newRoom.trim())).then(() => setNewRoom(""));
            }}
          >
            <input
              className="input"
              style={{ width: 160 }}
              placeholder={tr("New room", "Nouvelle pièce")}
              value={newRoom}
              onChange={(e) => setNewRoom(e.target.value)}
            />
            <button
              type="submit"
              className="button compact secondary"
              title={tr("Add room", "Ajouter une pièce")}
            >
              <IconPlus size={14} />
            </button>
          </form>
        </div>

        {selectedRoom && (
          <div style={{ ...row, marginTop: "0.75rem" }}>
            <form
              style={row}
              onSubmit={(e) => {
                e.preventDefault();
                const name = renameTo.trim();
                if (name === "" || name === selectedRoom.name) return;
                void roomAction(() => api.updateHomeRoom(selectedRoom.id, { name })).then(() =>
                  setRenameTo(""),
                );
              }}
            >
              <input
                className="input"
                style={{ width: 160 }}
                aria-label={tr("Rename room", "Renommer la pièce")}
                placeholder={selectedRoom.name}
                value={renameTo}
                onChange={(e) => setRenameTo(e.target.value)}
              />
              <button type="submit" className="button compact secondary">
                {tr("Rename", "Renommer")}
              </button>
            </form>
            {selectedRoom.haAreaId === null ? (
              <button
                type="button"
                className="button compact secondary"
                onClick={() => {
                  if (window.confirm(tr("Delete this room?", "Supprimer cette pièce ?"))) {
                    setRoomFilter("all");
                    void roomAction(() => api.deleteHomeRoom(selectedRoom.id));
                  }
                }}
              >
                <IconTrash size={14} />
                <span>{tr("Delete", "Supprimer")}</span>
              </button>
            ) : (
              <span className="muted" style={{ fontSize: "0.8rem" }}>
                {tr("Mirrors a Home Assistant area", "Reprend une zone Home Assistant")}
              </span>
            )}
          </div>
        )}
      </section>

      {home.loading && devices.length === 0 ? null : devices.length === 0 ? (
        <section className="card" style={{ marginTop: "1rem" }}>
          <Empty>
            {tr(
              "No device yet. Connect Home Assistant, pair an ESP32 satellite or configure the Fire TV.",
              "Aucun appareil pour l'instant. Connectez Home Assistant, appairez un satellite ESP32 ou configurez la Fire TV.",
            )}
          </Empty>
        </section>
      ) : (
        visibleRooms.map((group) => (
          <section key={group.id} className="card" style={{ marginTop: "1rem" }}>
            <div style={{ ...row, justifyContent: "space-between", marginBottom: "0.75rem" }}>
              <h4 style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <IconHome size={16} /> {group.name}
              </h4>
              <span className="badge">
                {group.devices.filter((d) => d.online).length}/{group.devices.length}{" "}
                {tr("online", "en ligne")}
              </span>
            </div>
            {group.devices.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                {tr("No device in this room.", "Aucun appareil dans cette pièce.")}
              </p>
            ) : (
              <div style={grid(280)}>
                {group.devices.map((device) => (
                  <DeviceCard
                    key={device.id}
                    device={device}
                    rooms={rooms}
                    busy={busy === device.id}
                    onAction={(action) => void act(device, action)}
                    onPatch={(patch) => void patchDevice(device, patch)}
                  />
                ))}
              </div>
            )}
          </section>
        ))
      )}
    </>
  );
}

function DeviceCard({
  device,
  rooms,
  busy,
  onAction,
  onPatch,
}: {
  device: HomeDeviceView;
  rooms: HomeRoomView[];
  busy: boolean;
  onAction: (action: HomeAction) => void;
  onPatch: (patch: Parameters<DashboardApi["updateHomeDevice"]>[1]) => void;
}) {
  const { tr } = useI18n();
  const caps = new Set(device.capabilities);
  const s = device.state;
  const [brightness, setBrightness] = useState(s.brightness ?? 0);
  const [speech, setSpeech] = useState("");
  const [target, setTarget] = useState(String(s.targetTemperature ?? 20));
  useEffect(() => setBrightness(s.brightness ?? 0), [s.brightness]);

  const disabled = busy || (!device.online && device.source !== "fire_tv");
  return (
    <div
      style={{
        background: "var(--nx-surface-raised)",
        border: `1px solid ${device.sensitive ? "var(--nx-warn)" : "var(--nx-line)"}`,
        borderRadius: "var(--nx-radius-md)",
        padding: "0.85rem",
        display: "grid",
        gap: "0.6rem",
        opacity: device.online || device.source === "fire_tv" ? 1 : 0.65,
      }}
    >
      <div style={{ ...row, justifyContent: "space-between", flexWrap: "nowrap" }}>
        <div style={{ ...row, flexWrap: "nowrap", minWidth: 0 }}>
          <DeviceIcon device={device} />
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {device.name}
            </div>
            <div className="muted" style={{ fontSize: "0.75rem" }}>
              {device.source === "home_assistant" ? device.entityIds[0] : device.domain} · {s.raw}
            </div>
          </div>
        </div>
        {caps.has("onoff") && device.source !== "fire_tv" && (
          <button
            type="button"
            role="switch"
            aria-checked={s.on === true}
            className={`button compact ${s.on ? "primary" : "secondary"}`}
            disabled={disabled}
            onClick={() => onAction({ action: s.on ? "turn_off" : "turn_on" })}
            title={s.on ? tr("Turn off", "Éteindre") : tr("Turn on", "Allumer")}
          >
            <IconPower size={14} />
            <span>{s.on ? "ON" : "OFF"}</span>
          </button>
        )}
      </div>

      <div style={row}>
        <span style={chip(device.online ? "ok" : "danger")}>
          {device.online ? tr("online", "en ligne") : tr("offline", "hors ligne")}
        </span>
        {device.sensitive && (
          <span style={chip("warn")}>
            <IconShield size={12} /> {tr("confirmation required", "confirmation requise")}
          </span>
        )}
        {caps.has("power_metering") && s.powerW !== undefined && (
          <span style={chip("muted")}>
            <IconBolt size={12} /> {s.powerW.toFixed(s.powerW < 10 ? 1 : 0)} W
          </span>
        )}
        {s.energyKWh !== undefined && (
          <span style={chip("muted")}>{s.energyKWh.toFixed(2)} kWh</span>
        )}
        {s.temperature !== undefined && <span style={chip("muted")}>{s.temperature} °C</span>}
      </div>

      {caps.has("brightness") && (
        <label style={{ ...row, flexWrap: "nowrap" }}>
          <span className="muted" style={{ fontSize: "0.8rem", minWidth: 70 }}>
            {tr("Brightness", "Luminosité")}
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={brightness}
            disabled={disabled}
            style={{ flex: 1, accentColor: "var(--nx-accent)" }}
            onChange={(e) => setBrightness(Number(e.target.value))}
            onPointerUp={() => onAction({ action: "set_brightness", brightness })}
            onKeyUp={() => onAction({ action: "set_brightness", brightness })}
          />
          <span style={{ minWidth: 36, textAlign: "right", fontSize: "0.8rem" }}>
            {brightness}%
          </span>
        </label>
      )}

      {caps.has("color") && (
        <label style={row}>
          <span className="muted" style={{ fontSize: "0.8rem", minWidth: 70 }}>
            {tr("Colour", "Couleur")}
          </span>
          <input
            type="color"
            value={s.color ?? "#ffffff"}
            disabled={disabled}
            onChange={(e) => onAction({ action: "set_color", color: e.target.value })}
            style={{
              width: 44,
              height: 28,
              border: "1px solid var(--nx-line)",
              borderRadius: "var(--nx-radius-sm)",
              background: "transparent",
            }}
          />
        </label>
      )}

      {caps.has("media") && device.source !== "fire_tv" && (
        <div style={row}>
          <button
            type="button"
            className="button compact secondary"
            disabled={disabled}
            onClick={() => onAction({ action: "media", command: "play_pause" })}
          >
            <IconPlay size={14} />
          </button>
          <button
            type="button"
            className="button compact secondary"
            disabled={disabled}
            onClick={() => onAction({ action: "media", command: "volume_down" })}
          >
            <IconVolume size={14} /> -
          </button>
          <button
            type="button"
            className="button compact secondary"
            disabled={disabled}
            onClick={() => onAction({ action: "media", command: "volume_up" })}
          >
            <IconVolume size={14} /> +
          </button>
          <button
            type="button"
            className="button compact secondary"
            disabled={disabled}
            onClick={() =>
              onAction({ action: "media", command: s.media?.muted ? "unmute" : "mute" })
            }
          >
            <IconVolumeX size={14} />
          </button>
          {s.media?.title && (
            <span className="muted" style={{ fontSize: "0.8rem" }}>
              {s.media.title}
            </span>
          )}
        </div>
      )}

      {device.source === "fire_tv" && (
        <div style={row}>
          <button
            type="button"
            className="button compact secondary"
            disabled={busy}
            onClick={() => onAction({ action: "turn_on" })}
          >
            <IconPower size={14} /> {tr("Wake", "Réveiller")}
          </button>
          <button
            type="button"
            className="button compact secondary"
            disabled={busy}
            onClick={() => onAction({ action: "media", command: "play_pause" })}
          >
            <IconPlay size={14} />
          </button>
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            {tr("Full remote in the TV tab.", "Télécommande complète dans l'onglet TV.")}
          </span>
        </div>
      )}

      {caps.has("lock") && (
        <div style={row}>
          <button
            type="button"
            className="button compact secondary"
            disabled={disabled}
            onClick={() => onAction({ action: "lock" })}
          >
            <IconLock size={14} /> {tr("Lock", "Verrouiller")}
          </button>
          <button
            type="button"
            className="button compact secondary"
            disabled={disabled}
            onClick={() => onAction({ action: "unlock" })}
          >
            {tr("Unlock", "Déverrouiller")}
          </button>
        </div>
      )}

      {caps.has("climate") && (
        <form
          style={row}
          onSubmit={(e) => {
            e.preventDefault();
            onAction({ action: "set_temperature", temperature: Number(target) });
          }}
        >
          <input
            className="input"
            type="number"
            min={5}
            max={35}
            step={0.5}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            style={{ width: 80 }}
          />
          <button type="submit" className="button compact secondary" disabled={disabled}>
            <IconThermometer size={14} /> {tr("Set", "Régler")}
          </button>
        </form>
      )}

      {caps.has("cover") && (
        <div style={row}>
          {(["open", "stop", "close"] as const).map((a) => (
            <button
              key={a}
              type="button"
              className="button compact secondary"
              disabled={disabled}
              onClick={() => onAction({ action: a })}
            >
              {a === "open"
                ? tr("Open", "Ouvrir")
                : a === "close"
                  ? tr("Close", "Fermer")
                  : tr("Stop", "Stop")}
            </button>
          ))}
        </div>
      )}

      {caps.has("mic") && (
        <div style={row}>
          <button
            type="button"
            className="button compact secondary"
            disabled={disabled}
            onClick={() => onAction({ action: "mic_mute", muted: s.micMuted !== true })}
          >
            {s.micMuted ? <IconMicOff size={14} /> : <IconMic size={14} />}
            <span>
              {s.micMuted
                ? tr("Unmute mic", "Réactiver le micro")
                : tr("Mute mic", "Couper le micro")}
            </span>
          </button>
          {caps.has("speaker") && (
            <span style={chip(s.speakerConnected ? "ok" : "muted")}>
              <IconVolume size={12} />{" "}
              {s.speakerConnected
                ? tr("speaker linked", "haut-parleur relié")
                : tr("speaker idle", "haut-parleur inactif")}
            </span>
          )}
        </div>
      )}

      {caps.has("speaker") && (
        <form
          style={row}
          onSubmit={(e) => {
            e.preventDefault();
            if (speech.trim() === "") return;
            onAction({ action: "speak", text: speech.trim() });
            setSpeech("");
          }}
        >
          <input
            className="input"
            style={{ flex: 1, minWidth: 120 }}
            placeholder={tr("Say something", "Faire dire")}
            value={speech}
            onChange={(e) => setSpeech(e.target.value)}
          />
          <button
            type="submit"
            className="button compact secondary"
            disabled={disabled || !s.speakerConnected}
          >
            <IconVolume size={14} />
          </button>
        </form>
      )}

      {device.source !== "nexus_worker" && (
        <div style={{ ...row, borderTop: "1px solid var(--nx-line)", paddingTop: "0.5rem" }}>
          <select
            className="input"
            aria-label={tr("Room", "Pièce")}
            value={device.roomId ?? ""}
            onChange={(e) => onPatch({ roomId: e.target.value === "" ? null : e.target.value })}
            style={{ flex: 1, minWidth: 110 }}
          >
            <option value="">{tr("No room", "Sans pièce")}</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <label
            style={{ ...row, fontSize: "0.8rem" }}
            title={tr("Require confirmation before acting", "Exiger une confirmation avant d'agir")}
          >
            <input
              type="checkbox"
              checked={device.sensitive}
              onChange={(e) =>
                onPatch({
                  // Unchecking a class-sensitive device is an explicit override; re-checking reverts to "user".
                  sensitive: e.target.checked,
                })
              }
            />
            {tr("Sensitive", "Sensible")}
          </label>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenes & routines
// ─────────────────────────────────────────────────────────────────────────────

const ACTIONS_BY_CAPABILITY: {
  action: HomeAction["action"];
  cap: string;
  en: string;
  fr: string;
}[] = [
  { action: "turn_on", cap: "onoff", en: "Turn on", fr: "Allumer" },
  { action: "turn_off", cap: "onoff", en: "Turn off", fr: "Éteindre" },
  { action: "toggle", cap: "onoff", en: "Toggle", fr: "Basculer" },
  { action: "set_brightness", cap: "brightness", en: "Brightness", fr: "Luminosité" },
  { action: "set_color", cap: "color", en: "Colour", fr: "Couleur" },
  { action: "media", cap: "media", en: "Media", fr: "Média" },
  { action: "lock", cap: "lock", en: "Lock", fr: "Verrouiller" },
  { action: "unlock", cap: "lock", en: "Unlock", fr: "Déverrouiller" },
  { action: "set_temperature", cap: "climate", en: "Temperature", fr: "Température" },
  { action: "open", cap: "cover", en: "Open", fr: "Ouvrir" },
  { action: "close", cap: "cover", en: "Close", fr: "Fermer" },
  { action: "mic_mute", cap: "mic", en: "Mute mic", fr: "Couper le micro" },
  { action: "speak", cap: "speaker", en: "Speak", fr: "Parler" },
];

function defaultAction(name: HomeAction["action"]): HomeAction {
  switch (name) {
    case "set_brightness":
      return { action: "set_brightness", brightness: 50 };
    case "set_color":
      return { action: "set_color", color: "#ffffff" };
    case "media":
      return { action: "media", command: "play_pause" };
    case "set_temperature":
      return { action: "set_temperature", temperature: 20 };
    case "mic_mute":
      return { action: "mic_mute", muted: true };
    case "speak":
      return { action: "speak", text: "" };
    case "remote":
      return { action: "remote", key: "home" };
    case "alarm_arm":
      return { action: "alarm_arm", mode: "away" };
    default:
      return { action: name };
  }
}

function ActionEditor({
  devices,
  value,
  onChange,
  onRemove,
}: {
  devices: HomeDeviceView[];
  value: { deviceId: string; action: HomeAction };
  onChange: (value: { deviceId: string; action: HomeAction }) => void;
  onRemove: () => void;
}) {
  const { tr } = useI18n();
  const device = devices.find((d) => d.id === value.deviceId);
  const options = ACTIONS_BY_CAPABILITY.filter((a) =>
    device?.capabilities.includes(a.cap as never),
  );
  const a = value.action;
  return (
    <div style={{ ...row, flexWrap: "wrap" }}>
      <select
        className="input"
        value={value.deviceId}
        style={{ minWidth: 180, flex: 1 }}
        onChange={(e) => {
          const next = devices.find((d) => d.id === e.target.value);
          const first = ACTIONS_BY_CAPABILITY.find((x) =>
            next?.capabilities.includes(x.cap as never),
          );
          onChange({ deviceId: e.target.value, action: defaultAction(first?.action ?? "turn_on") });
        }}
      >
        <option value="">{tr("Device", "Appareil")}</option>
        {devices
          .filter((d) => d.capabilities.length > 0)
          .map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
      </select>
      <select
        className="input"
        value={a.action}
        onChange={(e) =>
          onChange({ ...value, action: defaultAction(e.target.value as HomeAction["action"]) })
        }
      >
        {options.map((o) => (
          <option key={o.action} value={o.action}>
            {tr(o.en, o.fr)}
          </option>
        ))}
      </select>
      {a.action === "set_brightness" && (
        <input
          className="input"
          type="number"
          min={0}
          max={100}
          value={a.brightness}
          style={{ width: 80 }}
          onChange={(e) =>
            onChange({ ...value, action: { ...a, brightness: Number(e.target.value) } })
          }
        />
      )}
      {a.action === "set_color" && (
        <input
          type="color"
          value={a.color}
          onChange={(e) => onChange({ ...value, action: { ...a, color: e.target.value } })}
        />
      )}
      {a.action === "set_temperature" && (
        <input
          className="input"
          type="number"
          min={5}
          max={35}
          step={0.5}
          value={a.temperature}
          style={{ width: 80 }}
          onChange={(e) =>
            onChange({ ...value, action: { ...a, temperature: Number(e.target.value) } })
          }
        />
      )}
      {a.action === "media" && (
        <select
          className="input"
          value={a.command}
          onChange={(e) =>
            onChange({
              ...value,
              action: { action: "media", command: e.target.value as typeof a.command },
            })
          }
        >
          {(
            [
              "play",
              "pause",
              "play_pause",
              "stop",
              "next",
              "previous",
              "volume_up",
              "volume_down",
              "mute",
              "unmute",
            ] as const
          ).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}
      {a.action === "mic_mute" && (
        <select
          className="input"
          value={a.muted ? "1" : "0"}
          onChange={(e) =>
            onChange({ ...value, action: { action: "mic_mute", muted: e.target.value === "1" } })
          }
        >
          <option value="1">{tr("muted", "coupé")}</option>
          <option value="0">{tr("active", "actif")}</option>
        </select>
      )}
      {a.action === "speak" && (
        <input
          className="input"
          value={a.text}
          placeholder={tr("Text", "Texte")}
          onChange={(e) =>
            onChange({ ...value, action: { action: "speak", text: e.target.value } })
          }
        />
      )}
      <button
        type="button"
        className="button compact secondary"
        onClick={onRemove}
        title={tr("Remove", "Retirer")}
      >
        <IconTrash size={14} />
      </button>
    </div>
  );
}

const CRON_PRESETS: { cron: string; en: string; fr: string }[] = [
  { cron: "0 7 * * 1-5", en: "Weekdays 07:00", fr: "Semaine 07:00" },
  { cron: "30 22 * * *", en: "Every day 22:30", fr: "Tous les jours 22:30" },
  { cron: "0 19 * * 0,6", en: "Weekend 19:00", fr: "Week-end 19:00" },
];

function emptyRoutine(): HomeRoutineInput {
  return {
    name: "",
    enabled: true,
    trigger: { type: "time", cron: "0 7 * * 1-5" },
    conditions: [],
    actions: [],
  };
}

export function HomeAutomationsPanel({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const devices = useSection(() => api.homeDevices().then((h) => h.devices));
  const scenes = useSection(() => api.homeScenes());
  const routines = useSection(() => api.homeRoutines());
  const logs = useLive(() => api.homeLogs(30), 5_000);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [sceneDraft, setSceneDraft] = useState<(HomeSceneInput & { id?: string }) | null>(null);
  const [routineDraft, setRoutineDraft] = useState<(HomeRoutineInput & { id?: string }) | null>(
    null,
  );
  const deviceList = devices.data ?? [];
  const nameOf = useMemo(() => new Map(deviceList.map((d) => [d.id, d.name])), [deviceList]);

  const run = async (work: () => Promise<string>) => {
    setNotice(null);
    try {
      setNotice({ tone: "ok", text: await work() });
      scenes.reload();
      routines.reload();
      logs.reload();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const saveScene = () =>
    run(async () => {
      if (sceneDraft === null) return "";
      const input: HomeSceneInput = {
        name: sceneDraft.name,
        actions: sceneDraft.actions.filter((a) => a.deviceId !== ""),
      };
      if (sceneDraft.id) await api.updateHomeScene(sceneDraft.id, input);
      else await api.createHomeScene(input);
      setSceneDraft(null);
      return tr("Scene saved.", "Scène enregistrée.");
    });

  const saveRoutine = () =>
    run(async () => {
      if (routineDraft === null) return "";
      const { id, ...input } = routineDraft;
      const cleaned: HomeRoutineInput = {
        ...input,
        actions: input.actions.filter((a) =>
          a.type === "scene" ? a.sceneId !== "" : a.deviceId !== "",
        ),
      };
      if (id) await api.updateHomeRoutine(id, cleaned);
      else await api.createHomeRoutine(cleaned);
      setRoutineDraft(null);
      return tr("Routine saved.", "Routine enregistrée.");
    });

  const toRoutineInput = (r: HomeRoutineView): HomeRoutineInput & { id: string } => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    trigger: r.trigger,
    conditions: r.conditions,
    actions: r.actions,
  });

  const timeWindow = routineDraft?.conditions.find((c) => c.type === "time_between");

  return (
    <>
      {notice && (
        <p
          className={`banner ${notice.tone === "error" ? "error" : ""}`}
          style={{ marginTop: "1rem" }}
        >
          {notice.text}
        </p>
      )}

      {/* Scenes */}
      <section className="card" style={{ marginTop: "1rem" }} aria-labelledby="scenes-title">
        <div className="pairing-heading">
          <div>
            <span className="eyebrow">{tr("SCENES", "SCÈNES")}</span>
            <h3 id="scenes-title" style={{ margin: "0.25rem 0" }}>
              {tr("Scenes", "Scènes")}
            </h3>
            <p className="muted" style={{ margin: 0 }}>
              {tr(
                "A named set of device actions, run by NEXUS.",
                "Un ensemble nommé d'actions, exécuté par NEXUS.",
              )}
            </p>
          </div>
          <button
            type="button"
            className="button primary"
            onClick={() => setSceneDraft({ name: "", actions: [] })}
          >
            <IconPlus size={16} />
            <span>{tr("New scene", "Nouvelle scène")}</span>
          </button>
        </div>

        {sceneDraft && (
          <div
            style={{
              marginTop: "1rem",
              padding: "1rem",
              border: "1px dashed var(--nx-accent)",
              borderRadius: "var(--nx-radius-md)",
              display: "grid",
              gap: "0.6rem",
            }}
          >
            <input
              className="input"
              placeholder={tr("Scene name", "Nom de la scène")}
              value={sceneDraft.name}
              onChange={(e) => setSceneDraft({ ...sceneDraft, name: e.target.value })}
            />
            {sceneDraft.actions.map((item, index) => (
              <ActionEditor
                key={index}
                devices={deviceList}
                value={item}
                onChange={(next) =>
                  setSceneDraft({
                    ...sceneDraft,
                    actions: sceneDraft.actions.map((x, i) => (i === index ? next : x)),
                  })
                }
                onRemove={() =>
                  setSceneDraft({
                    ...sceneDraft,
                    actions: sceneDraft.actions.filter((_, i) => i !== index),
                  })
                }
              />
            ))}
            <div style={row}>
              <button
                type="button"
                className="button compact secondary"
                onClick={() =>
                  setSceneDraft({
                    ...sceneDraft,
                    actions: [
                      ...sceneDraft.actions,
                      { deviceId: "", action: { action: "turn_on" } },
                    ],
                  })
                }
              >
                <IconPlus size={14} /> {tr("Add action", "Ajouter une action")}
              </button>
              <button
                type="button"
                className="button compact primary"
                disabled={
                  sceneDraft.name.trim() === "" ||
                  sceneDraft.actions.every((a) => a.deviceId === "")
                }
                onClick={() => void saveScene()}
              >
                <IconCheck size={14} /> {tr("Save", "Enregistrer")}
              </button>
              <button
                type="button"
                className="button compact secondary"
                onClick={() => setSceneDraft(null)}
              >
                {tr("Cancel", "Annuler")}
              </button>
            </div>
          </div>
        )}

        <div style={{ ...grid(260), marginTop: "1rem" }}>
          {(scenes.data ?? []).map((scene: HomeSceneView) => (
            <div
              key={scene.id}
              style={{
                border: "1px solid var(--nx-line)",
                borderRadius: "var(--nx-radius-md)",
                padding: "0.75rem",
                background: "var(--nx-canvas-sunken)",
              }}
            >
              <strong>{scene.name}</strong>
              <ul
                className="muted"
                style={{ margin: "0.4rem 0", paddingLeft: "1.1rem", fontSize: "0.8rem" }}
              >
                {scene.actions.map((a, i) => (
                  <li key={i}>
                    {nameOf.get(a.deviceId) ?? a.deviceId}: {a.action.action}
                  </li>
                ))}
              </ul>
              <div style={row}>
                <button
                  type="button"
                  className="button compact primary"
                  onClick={() =>
                    void run(async () => outcomeText(await api.runHomeScene(scene.id), tr))
                  }
                >
                  <IconPlay size={14} /> {tr("Run", "Lancer")}
                </button>
                <button
                  type="button"
                  className="button compact secondary"
                  onClick={() =>
                    setSceneDraft({ id: scene.id, name: scene.name, actions: scene.actions })
                  }
                >
                  {tr("Edit", "Modifier")}
                </button>
                <button
                  type="button"
                  className="button compact secondary"
                  onClick={() => {
                    if (window.confirm(tr("Delete this scene?", "Supprimer cette scène ?")))
                      void run(
                        async () => (
                          await api.deleteHomeScene(scene.id),
                          tr("Scene deleted.", "Scène supprimée.")
                        ),
                      );
                  }}
                >
                  <IconTrash size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
        {(scenes.data ?? []).length === 0 && !sceneDraft && (
          <p className="muted">{tr("No scene yet.", "Aucune scène pour l'instant.")}</p>
        )}
      </section>

      {/* Routines */}
      <section className="card" style={{ marginTop: "1rem" }} aria-labelledby="routines-title">
        <div className="pairing-heading">
          <div>
            <span className="eyebrow">{tr("ROUTINES", "ROUTINES")}</span>
            <h3 id="routines-title" style={{ margin: "0.25rem 0" }}>
              {tr("Routines", "Routines")}
            </h3>
            <p className="muted" style={{ margin: 0 }}>
              {tr(
                "Trigger, conditions, actions. Sensitive actions still ask for confirmation.",
                "Déclencheur, conditions, actions. Les actions sensibles demandent toujours confirmation.",
              )}
            </p>
          </div>
          <button
            type="button"
            className="button primary"
            onClick={() => setRoutineDraft(emptyRoutine())}
          >
            <IconPlus size={16} />
            <span>{tr("New routine", "Nouvelle routine")}</span>
          </button>
        </div>

        {routineDraft && (
          <div
            style={{
              marginTop: "1rem",
              padding: "1rem",
              border: "1px dashed var(--nx-accent)",
              borderRadius: "var(--nx-radius-md)",
              display: "grid",
              gap: "0.75rem",
            }}
          >
            <input
              className="input"
              placeholder={tr("Routine name", "Nom de la routine")}
              value={routineDraft.name}
              onChange={(e) => setRoutineDraft({ ...routineDraft, name: e.target.value })}
            />
            <div style={row}>
              <strong style={{ fontSize: "0.85rem" }}>{tr("When", "Quand")}</strong>
              <select
                className="input"
                value={routineDraft.trigger.type}
                onChange={(e) => {
                  const type = e.target.value;
                  setRoutineDraft({
                    ...routineDraft,
                    trigger:
                      type === "time"
                        ? { type: "time", cron: "0 7 * * 1-5" }
                        : type === "device_state"
                          ? { type: "device_state", deviceId: "", to: "on" }
                          : { type: "presence", event: "arrive" },
                  });
                }}
              >
                <option value="time">{tr("At a time (cron)", "À heure fixe (cron)")}</option>
                <option value="device_state">
                  {tr("When a device changes", "Quand un appareil change")}
                </option>
                <option value="presence">
                  {tr("Presence (coming soon)", "Présence (bientôt)")}
                </option>
              </select>
              {routineDraft.trigger.type === "time" && (
                <>
                  <input
                    className="input"
                    style={{ width: 150, fontFamily: "monospace" }}
                    value={routineDraft.trigger.cron}
                    onChange={(e) =>
                      setRoutineDraft({
                        ...routineDraft,
                        trigger: { type: "time", cron: e.target.value },
                      })
                    }
                  />
                  {CRON_PRESETS.map((p) => (
                    <button
                      key={p.cron}
                      type="button"
                      className="button compact secondary"
                      onClick={() =>
                        setRoutineDraft({
                          ...routineDraft,
                          trigger: { type: "time", cron: p.cron },
                        })
                      }
                    >
                      {tr(p.en, p.fr)}
                    </button>
                  ))}
                </>
              )}
              {routineDraft.trigger.type === "device_state" && (
                <>
                  <select
                    className="input"
                    value={routineDraft.trigger.deviceId}
                    onChange={(e) =>
                      setRoutineDraft({
                        ...routineDraft,
                        trigger: {
                          type: "device_state",
                          deviceId: e.target.value,
                          to:
                            routineDraft.trigger.type === "device_state"
                              ? (routineDraft.trigger.to ?? "on")
                              : "on",
                        },
                      })
                    }
                  >
                    <option value="">{tr("Device", "Appareil")}</option>
                    {deviceList
                      .filter((d) => d.source === "home_assistant")
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                  </select>
                  <span className="muted">{tr("becomes", "devient")}</span>
                  <input
                    className="input"
                    style={{ width: 110 }}
                    value={routineDraft.trigger.to ?? ""}
                    placeholder="on / off / playing"
                    onChange={(e) => {
                      const trigger = routineDraft.trigger;
                      if (trigger.type !== "device_state") return;
                      setRoutineDraft({
                        ...routineDraft,
                        trigger: {
                          type: "device_state",
                          deviceId: trigger.deviceId,
                          ...(e.target.value === "" ? {} : { to: e.target.value }),
                        },
                      });
                    }}
                  />
                </>
              )}
              {routineDraft.trigger.type === "presence" && (
                <span className="muted" style={{ fontSize: "0.8rem" }}>
                  {tr(
                    "Stored but not evaluated until a presence source is connected.",
                    "Enregistré mais non évalué tant qu'aucune source de présence n'est connectée.",
                  )}
                </span>
              )}
            </div>

            <div style={row}>
              <strong style={{ fontSize: "0.85rem" }}>
                {tr("Only between", "Seulement entre")}
              </strong>
              <input
                className="input"
                type="time"
                value={timeWindow?.type === "time_between" ? timeWindow.after : ""}
                onChange={(e) => {
                  const others = routineDraft.conditions.filter((c) => c.type !== "time_between");
                  const before = timeWindow?.type === "time_between" ? timeWindow.before : "23:59";
                  setRoutineDraft({
                    ...routineDraft,
                    conditions:
                      e.target.value === ""
                        ? others
                        : [...others, { type: "time_between", after: e.target.value, before }],
                  });
                }}
              />
              <span className="muted">{tr("and", "et")}</span>
              <input
                className="input"
                type="time"
                value={timeWindow?.type === "time_between" ? timeWindow.before : ""}
                disabled={timeWindow === undefined}
                onChange={(e) => {
                  if (timeWindow?.type !== "time_between") return;
                  const others = routineDraft.conditions.filter((c) => c.type !== "time_between");
                  setRoutineDraft({
                    ...routineDraft,
                    conditions: [...others, { ...timeWindow, before: e.target.value }],
                  });
                }}
              />
            </div>

            <strong style={{ fontSize: "0.85rem" }}>{tr("Then", "Alors")}</strong>
            {routineDraft.actions.map((item, index) =>
              item.type === "device" ? (
                <ActionEditor
                  key={index}
                  devices={deviceList}
                  value={item}
                  onChange={(next) =>
                    setRoutineDraft({
                      ...routineDraft,
                      actions: routineDraft.actions.map((x, i) =>
                        i === index ? { type: "device", ...next } : x,
                      ),
                    })
                  }
                  onRemove={() =>
                    setRoutineDraft({
                      ...routineDraft,
                      actions: routineDraft.actions.filter((_, i) => i !== index),
                    })
                  }
                />
              ) : (
                <div key={index} style={row}>
                  <select
                    className="input"
                    value={item.sceneId}
                    onChange={(e) =>
                      setRoutineDraft({
                        ...routineDraft,
                        actions: routineDraft.actions.map((x, i) =>
                          i === index ? { type: "scene", sceneId: e.target.value } : x,
                        ),
                      })
                    }
                  >
                    <option value="">{tr("Scene", "Scène")}</option>
                    {(scenes.data ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="button compact secondary"
                    onClick={() =>
                      setRoutineDraft({
                        ...routineDraft,
                        actions: routineDraft.actions.filter((_, i) => i !== index),
                      })
                    }
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
              ),
            )}
            <div style={row}>
              <button
                type="button"
                className="button compact secondary"
                onClick={() =>
                  setRoutineDraft({
                    ...routineDraft,
                    actions: [
                      ...routineDraft.actions,
                      { type: "device", deviceId: "", action: { action: "turn_on" } },
                    ],
                  })
                }
              >
                <IconPlus size={14} /> {tr("Device action", "Action appareil")}
              </button>
              <button
                type="button"
                className="button compact secondary"
                onClick={() =>
                  setRoutineDraft({
                    ...routineDraft,
                    actions: [...routineDraft.actions, { type: "scene", sceneId: "" }],
                  })
                }
              >
                <IconPlus size={14} /> {tr("Run a scene", "Lancer une scène")}
              </button>
              <button
                type="button"
                className="button compact primary"
                disabled={routineDraft.name.trim() === "" || routineDraft.actions.length === 0}
                onClick={() => void saveRoutine()}
              >
                <IconCheck size={14} /> {tr("Save", "Enregistrer")}
              </button>
              <button
                type="button"
                className="button compact secondary"
                onClick={() => setRoutineDraft(null)}
              >
                {tr("Cancel", "Annuler")}
              </button>
            </div>
          </div>
        )}

        <div style={{ display: "grid", gap: "0.5rem", marginTop: "1rem" }}>
          {(routines.data ?? []).map((routine) => (
            <div
              key={routine.id}
              style={{
                ...row,
                justifyContent: "space-between",
                border: "1px solid var(--nx-line)",
                borderRadius: "var(--nx-radius-md)",
                padding: "0.6rem 0.8rem",
                background: "var(--nx-canvas-sunken)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <strong>{routine.name}</strong>{" "}
                <span style={chip(routine.enabled ? "ok" : "muted")}>
                  {routine.enabled ? tr("enabled", "active") : tr("disabled", "désactivée")}
                </span>
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  <IconClock size={12} />{" "}
                  {routine.trigger.type === "time"
                    ? `cron ${routine.trigger.cron}`
                    : routine.trigger.type === "device_state"
                      ? `${nameOf.get(routine.trigger.deviceId) ?? routine.trigger.deviceId} → ${routine.trigger.to ?? "*"}`
                      : tr("presence (not evaluated yet)", "présence (pas encore évaluée)")}
                  {" · "}
                  {routine.actions.length} {tr("action(s)", "action(s)")}
                  {routine.lastRunAt &&
                    ` · ${tr("last run", "dernière exécution")} ${new Date(routine.lastRunAt).toLocaleString()}`}
                </div>
              </div>
              <div style={row}>
                <button
                  type="button"
                  className="button compact secondary"
                  onClick={() =>
                    void run(async () => {
                      const { id, ...input } = toRoutineInput(routine);
                      await api.updateHomeRoutine(id, { ...input, enabled: !routine.enabled });
                      return routine.enabled
                        ? tr("Routine disabled.", "Routine désactivée.")
                        : tr("Routine enabled.", "Routine activée.");
                    })
                  }
                >
                  {routine.enabled ? tr("Disable", "Désactiver") : tr("Enable", "Activer")}
                </button>
                <button
                  type="button"
                  className="button compact primary"
                  onClick={() =>
                    void run(
                      async () =>
                        `${routine.name}: ${(await api.runHomeRoutine(routine.id)).status}`,
                    )
                  }
                >
                  <IconPlay size={14} />
                </button>
                <button
                  type="button"
                  className="button compact secondary"
                  onClick={() => setRoutineDraft(toRoutineInput(routine))}
                >
                  {tr("Edit", "Modifier")}
                </button>
                <button
                  type="button"
                  className="button compact secondary"
                  onClick={() => {
                    if (window.confirm(tr("Delete this routine?", "Supprimer cette routine ?")))
                      void run(
                        async () => (
                          await api.deleteHomeRoutine(routine.id),
                          tr("Routine deleted.", "Routine supprimée.")
                        ),
                      );
                  }}
                >
                  <IconTrash size={14} />
                </button>
              </div>
            </div>
          ))}
          {(routines.data ?? []).length === 0 && !routineDraft && (
            <p className="muted" style={{ margin: 0 }}>
              {tr("No routine yet.", "Aucune routine pour l'instant.")}
            </p>
          )}
        </div>
      </section>

      {/* Execution log */}
      <section className="card" style={{ marginTop: "1rem" }} aria-labelledby="home-log-title">
        <span className="eyebrow">{tr("HISTORY", "HISTORIQUE")}</span>
        <h3 id="home-log-title" style={{ margin: "0.25rem 0 0.75rem" }}>
          {tr("Execution log", "Journal d'exécution")}
        </h3>
        {(logs.data ?? []).length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {tr("Nothing executed yet.", "Rien d'exécuté pour l'instant.")}
          </p>
        ) : (
          <div style={{ display: "grid", gap: "0.3rem", fontSize: "0.85rem" }}>
            {(logs.data ?? []).map((entry) => (
              <div
                key={entry.id}
                style={{
                  ...row,
                  borderBottom: "1px solid var(--nx-line)",
                  paddingBottom: "0.3rem",
                }}
              >
                <span className="muted" style={{ minWidth: 140 }}>
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
                <span
                  style={chip(
                    entry.status === "succeeded"
                      ? "ok"
                      : entry.status === "failed" || entry.status === "rejected"
                        ? "danger"
                        : "warn",
                  )}
                >
                  {entry.status}
                </span>
                <span className="badge">{entry.kind}</span>
                <span>{entry.name}</span>
                <span className="muted">({entry.origin})</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Voice satellites
// ─────────────────────────────────────────────────────────────────────────────

export function VoiceSatellitesPanel({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const voice = useLive(() => api.homeVoice(), 4_000);
  const [notice, setNotice] = useState<string | null>(null);
  const [speech, setSpeech] = useState<Record<string, string>>({});
  const data = voice.data;

  const act = async (deviceId: string, action: HomeAction) => {
    setNotice(null);
    try {
      setNotice(outcomeText(await api.runHomeDeviceAction(`sat:${deviceId}`, action), tr));
      voice.reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="card" style={{ marginTop: "1rem" }} aria-labelledby="voice-title">
      <div className="pairing-heading">
        <div>
          <span className="eyebrow">{tr("VOICE PIPELINE", "CHAÎNE VOCALE")}</span>
          <h3 id="voice-title" style={{ margin: "0.25rem 0" }}>
            {tr("Voice satellites", "Satellites vocaux")}
          </h3>
          <p className="muted" style={{ margin: 0 }}>
            {tr(
              "Wake word on the ESP32, speech-to-text (whisper.cpp), NEXUS intent, text-to-speech (Piper) streamed back to the same satellite. Protocol: docs/integration/esp32-voice-satellite-protocol.md.",
              "Mot d'éveil sur l'ESP32, transcription (whisper.cpp), intention NEXUS, synthèse (Piper) renvoyée au même satellite. Protocole : docs/integration/esp32-voice-satellite-protocol.md.",
            )}
          </p>
        </div>
        {data && (
          <div style={row}>
            <span style={chip(data.engines.stt ? "ok" : "danger")}>
              STT {data.engines.stt ? tr("ready", "prêt") : tr("not configured", "non configuré")}
            </span>
            <span style={chip(data.engines.tts ? "ok" : "danger")}>
              TTS {data.engines.tts ? tr("ready", "prêt") : tr("not configured", "non configuré")}
            </span>
          </div>
        )}
      </div>
      {voice.error && <p className="banner error">{voice.error}</p>}
      {notice && <p className="banner">{notice}</p>}
      {data && (
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          WebSocket <code>{data.protocol.path}</code> · v{data.protocol.version} ·{" "}
          {data.protocol.mic}
        </p>
      )}
      {data?.satellites.length === 0 ? (
        <Empty>
          {tr(
            "No satellite paired to your account yet. Pair one from the Satellites tab.",
            "Aucun satellite appairé à votre compte. Appairez-en un depuis l'onglet Satellites.",
          )}
        </Empty>
      ) : (
        <div style={{ ...grid(280), marginTop: "0.75rem" }}>
          {(data?.satellites ?? []).map((sat) => (
            <div
              key={sat.deviceId}
              style={{
                border: "1px solid var(--nx-line)",
                borderRadius: "var(--nx-radius-md)",
                padding: "0.85rem",
                background: "var(--nx-surface-raised)",
                display: "grid",
                gap: "0.5rem",
              }}
            >
              <div style={{ ...row, justifyContent: "space-between" }}>
                <strong style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <IconSatellite size={16} /> {sat.name}
                </strong>
                <span style={chip(sat.connected ? "ok" : sat.online ? "warn" : "danger")}>
                  {sat.connected
                    ? tr("voice linked", "voix reliée")
                    : sat.online
                      ? tr("online, no voice link", "en ligne, sans voix")
                      : tr("offline", "hors ligne")}
                </span>
              </div>
              <div style={row}>
                <span style={chip(sat.mic ? "ok" : "muted")}>
                  <IconMic size={12} /> {tr("mic", "micro")}
                </span>
                <span style={chip(sat.speaker ? "ok" : "muted")}>
                  <IconVolume size={12} />{" "}
                  {sat.speaker
                    ? `${tr("speaker", "haut-parleur")} ${String(sat.speakerSampleRate ?? "")} Hz`
                    : tr("no speaker", "pas de haut-parleur")}
                </span>
                <span style={chip("muted")}>{sat.state}</span>
              </div>
              <div className="muted" style={{ fontSize: "0.8rem" }}>
                {sat.firmware ? `firmware ${sat.firmware} · ` : ""}
                {sat.turns} {tr("turn(s)", "échange(s)")}
                {sat.lastTurnAt
                  ? ` · ${tr("last", "dernier")} ${new Date(sat.lastTurnAt).toLocaleTimeString()}`
                  : ""}
              </div>
              <div style={row}>
                <button
                  type="button"
                  className="button compact secondary"
                  onClick={() => void act(sat.deviceId, { action: "mic_mute", muted: true })}
                >
                  <IconMicOff size={14} /> {tr("Mute", "Couper")}
                </button>
                <button
                  type="button"
                  className="button compact secondary"
                  onClick={() => void act(sat.deviceId, { action: "mic_mute", muted: false })}
                >
                  <IconMic size={14} /> {tr("Unmute", "Réactiver")}
                </button>
              </div>
              {sat.speaker && (
                <form
                  style={row}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = (speech[sat.deviceId] ?? "").trim();
                    if (text === "") return;
                    void act(sat.deviceId, { action: "speak", text });
                    setSpeech({ ...speech, [sat.deviceId]: "" });
                  }}
                >
                  <input
                    className="input"
                    style={{ flex: 1, minWidth: 120 }}
                    placeholder={tr("Speaker test", "Test du haut-parleur")}
                    value={speech[sat.deviceId] ?? ""}
                    onChange={(e) => setSpeech({ ...speech, [sat.deviceId]: e.target.value })}
                  />
                  <button
                    type="submit"
                    className="button compact secondary"
                    disabled={!sat.connected || !data?.engines.tts}
                  >
                    <IconVolume size={14} />
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
