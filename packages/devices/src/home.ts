import { z } from "zod";
import { AppError } from "@nexus/shared";
import type { HomeAssistantServiceCall } from "./homeassistant.js";
import type {
  HaArea,
  HaDeviceEntry,
  HaEntityEntry,
  HaStateObject,
  HomeAssistantSnapshot,
} from "./homeassistant-client.js";

/**
 * Unified home model.
 *
 * NEXUS is the brain, Home Assistant the hands. Every physical thing NEXUS
 * can act on — an HA light, a Wi-Fi plug, the Fire TV behind ADB, an ESP32
 * voice satellite — is presented through one shape: a `HomeDevice` with a
 * room, a capability list, an online flag and a normalized state.
 *
 * Nothing here is invented. A device exists because a source reported it;
 * a room exists because HA has an area or the user created it.
 */

export const HOME_CAPABILITIES = [
  "onoff",
  "brightness",
  "color",
  "power_metering",
  "media",
  "remote",
  "mic",
  "speaker",
  "lock",
  "alarm",
  "climate",
  "cover",
] as const;
export type HomeCapability = (typeof HOME_CAPABILITIES)[number];

export type HomeDeviceSource = "home_assistant" | "satellite" | "fire_tv" | "nexus_worker";

export interface HomeDeviceState {
  /** Raw source state (`on`, `off`, `playing`, `locked`, `online`...). */
  readonly raw: string;
  readonly on: boolean | null;
  /** 0-100. */
  readonly brightness?: number;
  /** `#rrggbb`. */
  readonly color?: string;
  readonly powerW?: number;
  readonly energyKWh?: number;
  readonly media?: {
    readonly title?: string;
    readonly volume?: number;
    readonly muted?: boolean;
    readonly source?: string;
  };
  readonly temperature?: number;
  readonly targetTemperature?: number;
  readonly locked?: boolean;
  readonly alarm?: string;
  readonly micMuted?: boolean;
  readonly speakerConnected?: boolean;
}

export interface HomeDevice {
  /** Stable unified id: `ha:<entity_id>`, `sat:<id>`, `firetv:<serial>`, `nexus:<id>`. */
  readonly id: string;
  readonly source: HomeDeviceSource;
  readonly name: string;
  /** HA domain or synthetic kind (`satellite`, `fire_tv`, `worker`). */
  readonly domain: string;
  readonly deviceClass: string | null;
  readonly roomId: string | null;
  readonly areaId: string | null;
  readonly capabilities: readonly HomeCapability[];
  readonly online: boolean;
  readonly sensitive: boolean;
  readonly sensitiveReason: "class" | "user" | null;
  readonly state: HomeDeviceState;
  /** HA entities backing this device (primary first). */
  readonly entityIds: readonly string[];
  readonly lastChanged: string | null;
  readonly manufacturer: string | null;
  readonly model: string | null;
}

export interface HomeRoom {
  readonly id: string;
  readonly name: string;
  readonly haAreaId: string | null;
  readonly sortOrder: number;
}

export interface HomeDeviceSetting {
  readonly deviceId: string;
  /** `undefined`/`null` = follow the source (HA area, satellite health.room). */
  readonly roomId?: string | null;
  /** `null` = default policy (sensitive classes). */
  readonly sensitive?: boolean | null;
  readonly alias?: string | null;
  readonly hidden?: boolean;
}

/** Device classes that always require human confirmation, unless the user says otherwise. */
export const DEFAULT_SENSITIVE_CLASSES: readonly string[] = [
  "lock",
  "alarm_control_panel",
  "climate",
  "water_heater",
];

/** HA domains NEXUS presents as devices. Sensors attach to them as metering. */
export const CONTROLLABLE_DOMAINS = [
  "light",
  "switch",
  "fan",
  "media_player",
  "lock",
  "climate",
  "water_heater",
  "alarm_control_panel",
  "cover",
] as const;

const COLOR_MODES = new Set(["hs", "xy", "rgb", "rgbw", "rgbww"]);

// ─────────────────────────────────────────────────────────────────────────────
// Home Assistant → HomeDevice
// ─────────────────────────────────────────────────────────────────────────────

export function domainOf(entityId: string): string {
  return entityId.slice(0, entityId.indexOf("."));
}

export function capabilitiesForEntity(state: HaStateObject): HomeCapability[] {
  const domain = domainOf(state.entity_id);
  const attrs = state.attributes;
  const caps = new Set<HomeCapability>();
  switch (domain) {
    case "light": {
      caps.add("onoff");
      const modes = Array.isArray(attrs.supported_color_modes)
        ? (attrs.supported_color_modes as unknown[]).map(String)
        : [];
      const features = typeof attrs.supported_features === "number" ? attrs.supported_features : 0;
      if (modes.some((m) => m !== "onoff") || (features & 1) === 1) caps.add("brightness");
      if (modes.some((m) => COLOR_MODES.has(m)) || (features & 16) === 16) caps.add("color");
      break;
    }
    case "switch":
    case "fan":
      caps.add("onoff");
      break;
    case "media_player":
      caps.add("onoff");
      caps.add("media");
      break;
    case "lock":
      caps.add("lock");
      break;
    case "climate":
    case "water_heater":
      caps.add("onoff");
      caps.add("climate");
      break;
    case "alarm_control_panel":
      caps.add("alarm");
      break;
    case "cover":
      caps.add("cover");
      break;
    default:
      break;
  }
  return [...caps];
}

function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function rgbToHex(rgb: unknown): string | undefined {
  if (!Array.isArray(rgb) || rgb.length < 3) return undefined;
  const parts = rgb.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(Number(v)))));
  if (parts.some((v) => !Number.isFinite(v))) return undefined;
  return `#${parts.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function stateForEntity(state: HaStateObject): HomeDeviceState {
  const domain = domainOf(state.entity_id);
  const a = state.attributes;
  const raw = state.state;
  const base: {
    raw: string;
    on: boolean | null;
    brightness?: number;
    color?: string;
    media?: NonNullable<HomeDeviceState["media"]>;
    temperature?: number;
    targetTemperature?: number;
    locked?: boolean;
    alarm?: string;
  } = {
    raw,
    on:
      raw === "unavailable" || raw === "unknown"
        ? null
        : domain === "media_player"
          ? raw !== "off" && raw !== "standby"
          : domain === "climate"
            ? raw !== "off"
            : raw === "on",
  };
  if (domain === "light") {
    const b = num(a.brightness);
    if (b !== undefined) base.brightness = Math.round((b / 255) * 100);
    else if (raw === "off") base.brightness = 0;
    const color = rgbToHex(a.rgb_color);
    if (color !== undefined) base.color = color;
  }
  if (domain === "media_player") {
    const media: { title?: string; volume?: number; muted?: boolean; source?: string } = {};
    if (typeof a.media_title === "string") media.title = a.media_title;
    const vol = num(a.volume_level);
    if (vol !== undefined) media.volume = Math.round(vol * 100);
    if (typeof a.is_volume_muted === "boolean") media.muted = a.is_volume_muted;
    if (typeof a.source === "string") media.source = a.source;
    base.media = media;
  }
  if (domain === "climate" || domain === "water_heater") {
    const current = num(a.current_temperature);
    const target = num(a.temperature);
    if (current !== undefined) base.temperature = current;
    if (target !== undefined) base.targetTemperature = target;
  }
  if (domain === "lock") base.locked = raw === "locked";
  if (domain === "alarm_control_panel") base.alarm = raw;
  return base;
}

function isPowerSensor(state: HaStateObject): "power" | "energy" | undefined {
  if (domainOf(state.entity_id) !== "sensor") return undefined;
  const cls = state.attributes.device_class;
  const unit = state.attributes.unit_of_measurement;
  if (cls === "power" || unit === "W" || unit === "kW") return "power";
  if (cls === "energy" || unit === "kWh" || unit === "Wh") return "energy";
  return undefined;
}

function sensorValue(state: HaStateObject, kind: "power" | "energy"): number | undefined {
  const value = num(state.state);
  if (value === undefined) return undefined;
  const unit = state.attributes.unit_of_measurement;
  if (kind === "power" && unit === "kW") return value * 1000;
  if (kind === "energy" && unit === "Wh") return value / 1000;
  return value;
}

/**
 * Builds devices from an HA snapshot. One device per controllable entity;
 * power/energy sensors on the same HA device attach to it as metering.
 * Disabled or hidden registry entries, and entities with an entity_category
 * (config/diagnostic), are skipped.
 */
export function buildHomeAssistantDevices(
  snapshot: Pick<HomeAssistantSnapshot, "states" | "devices" | "entities">,
): HomeDevice[] {
  const entityEntries = new Map<string, HaEntityEntry>(
    snapshot.entities.map((e) => [e.entity_id, e]),
  );
  const deviceEntries = new Map<string, HaDeviceEntry>(snapshot.devices.map((d) => [d.id, d]));
  const meteringByDevice = new Map<string, HaStateObject[]>();
  for (const state of snapshot.states) {
    if (isPowerSensor(state) === undefined) continue;
    const deviceId = entityEntries.get(state.entity_id)?.device_id;
    if (deviceId == null) continue;
    const list = meteringByDevice.get(deviceId) ?? [];
    list.push(state);
    meteringByDevice.set(deviceId, list);
  }

  const result: HomeDevice[] = [];
  for (const state of snapshot.states) {
    const domain = domainOf(state.entity_id);
    if (!(CONTROLLABLE_DOMAINS as readonly string[]).includes(domain)) continue;
    const entry = entityEntries.get(state.entity_id);
    if (entry?.disabled_by != null || entry?.hidden_by != null) continue;
    if (entry?.entity_category != null) continue;
    const haDevice = entry?.device_id == null ? undefined : deviceEntries.get(entry.device_id);
    const caps = capabilitiesForEntity(state);
    let deviceState = stateForEntity(state);
    const entityIds = [state.entity_id];
    const metering = haDevice === undefined ? [] : (meteringByDevice.get(haDevice.id) ?? []);
    for (const sensor of metering) {
      const kind = isPowerSensor(sensor);
      if (kind === undefined) continue;
      const value = sensorValue(sensor, kind);
      if (value === undefined) continue;
      deviceState =
        kind === "power" ? { ...deviceState, powerW: value } : { ...deviceState, energyKWh: value };
      entityIds.push(sensor.entity_id);
      if (!caps.includes("power_metering")) caps.push("power_metering");
    }
    const friendly =
      typeof state.attributes.friendly_name === "string"
        ? state.attributes.friendly_name
        : (entry?.name ?? entry?.original_name ?? state.entity_id);
    result.push({
      id: `ha:${state.entity_id}`,
      source: "home_assistant",
      name: friendly,
      domain,
      deviceClass:
        typeof state.attributes.device_class === "string" ? state.attributes.device_class : null,
      roomId: null,
      areaId: entry?.area_id ?? haDevice?.area_id ?? null,
      capabilities: caps,
      online: state.state !== "unavailable",
      sensitive: false,
      sensitiveReason: null,
      state: deviceState,
      entityIds,
      lastChanged: state.last_changed ?? null,
      manufacturer: haDevice?.manufacturer ?? null,
      model: haDevice?.model ?? null,
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry: merges sources, applies rooms and policy
// ─────────────────────────────────────────────────────────────────────────────

export interface SatelliteSourceView {
  readonly deviceId: string;
  readonly name: string;
  readonly online: boolean;
  readonly lastSeenAt: string | null;
  readonly health: Readonly<Record<string, unknown>>;
  readonly capabilities: readonly { readonly name: string }[];
  /** Live voice socket state, when the satellite has one. */
  readonly voice?: { readonly connected: boolean; readonly speaker: boolean } | undefined;
}

export interface FireTvSourceView {
  readonly serial: string;
  readonly name: string;
  /** `null` when reachability was never probed. */
  readonly reachable: boolean | null;
}

export interface WorkerSourceView {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly online: boolean;
  readonly lastSeenAt: string | null;
  readonly room: string | null;
}

export interface HomeRegistryInput {
  readonly ha?: Pick<HomeAssistantSnapshot, "states" | "devices" | "entities"> | undefined;
  readonly satellites?: readonly SatelliteSourceView[];
  readonly fireTv?: FireTvSourceView | undefined;
  readonly workers?: readonly WorkerSourceView[];
  readonly rooms: readonly HomeRoom[];
  readonly settings: readonly HomeDeviceSetting[];
  readonly sensitiveClasses?: readonly string[];
}

const SAT_MIC = new Set(["audio.microphone", "microphone", "mic", "audio.mic", "audio.capture"]);
const SAT_SPEAKER = new Set(["audio.speaker", "speaker", "audio.playback", "audio.output"]);

function satelliteMicMuted(health: Readonly<Record<string, unknown>>): boolean | undefined {
  const mic = health.microphone;
  if (typeof mic === "boolean") return !mic;
  if (typeof mic === "object" && mic !== null) {
    const m = mic as Record<string, unknown>;
    if (typeof m.muted === "boolean") return m.muted;
    if (m.status === "muted") return true;
    if (m.status === "active" || m.status === "idle") return false;
  }
  if (typeof health.micMuted === "boolean") return health.micMuted;
  if (typeof health.privacy === "boolean") return health.privacy;
  return undefined;
}

function roomByName(rooms: readonly HomeRoom[], name: unknown): string | null {
  if (typeof name !== "string" || name.trim() === "") return null;
  const wanted = normalizeText(name);
  return rooms.find((r) => normalizeText(r.name) === wanted)?.id ?? null;
}

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Pure merge of every source into the unified device list. */
export function buildHomeDevices(input: HomeRegistryInput): HomeDevice[] {
  const settings = new Map(input.settings.map((s) => [s.deviceId, s]));
  const roomIds = new Set(input.rooms.map((r) => r.id));
  const roomForArea = new Map(
    input.rooms.filter((r) => r.haAreaId !== null).map((r) => [r.haAreaId!, r.id]),
  );
  const sensitiveClasses = new Set(input.sensitiveClasses ?? DEFAULT_SENSITIVE_CLASSES);
  const devices: HomeDevice[] = [];

  if (input.ha !== undefined) devices.push(...buildHomeAssistantDevices(input.ha));

  for (const sat of input.satellites ?? []) {
    const names = new Set(sat.capabilities.map((c) => c.name));
    const caps: HomeCapability[] = [];
    if ([...names].some((n) => SAT_MIC.has(n)) || sat.health.microphone !== undefined) {
      caps.push("mic");
    }
    if ([...names].some((n) => SAT_SPEAKER.has(n)) || sat.voice?.speaker === true) {
      caps.push("speaker");
    }
    const micMuted = satelliteMicMuted(sat.health);
    devices.push({
      id: `sat:${sat.deviceId}`,
      source: "satellite",
      name: sat.name,
      domain: "satellite",
      deviceClass: "voice_satellite",
      roomId: roomByName(input.rooms, sat.health.room),
      areaId: null,
      capabilities: caps,
      online: sat.online,
      sensitive: false,
      sensitiveReason: null,
      state: {
        raw: sat.online ? "online" : "offline",
        on: sat.online,
        ...(micMuted === undefined ? {} : { micMuted }),
        speakerConnected: sat.voice?.connected === true && sat.voice.speaker,
      },
      entityIds: [],
      lastChanged: sat.lastSeenAt,
      manufacturer: "Espressif",
      model: typeof sat.health.board === "string" ? sat.health.board : "ESP32",
    });
  }

  if (input.fireTv !== undefined) {
    const tv = input.fireTv;
    devices.push({
      id: `firetv:${tv.serial}`,
      source: "fire_tv",
      name: tv.name,
      domain: "fire_tv",
      deviceClass: "tv",
      roomId: null,
      areaId: null,
      capabilities: ["remote", "onoff", "media"],
      online: tv.reachable === true,
      sensitive: false,
      sensitiveReason: null,
      state: {
        raw: tv.reachable === null ? "unknown" : tv.reachable ? "reachable" : "unreachable",
        on: null,
      },
      entityIds: [],
      lastChanged: null,
      manufacturer: "Amazon",
      model: "Fire TV",
    });
  }

  for (const worker of input.workers ?? []) {
    devices.push({
      id: `nexus:${worker.id}`,
      source: "nexus_worker",
      name: worker.name,
      domain: "worker",
      deviceClass: worker.type.toLowerCase(),
      roomId: roomByName(input.rooms, worker.room),
      areaId: null,
      capabilities: [],
      online: worker.online,
      sensitive: false,
      sensitiveReason: null,
      state: { raw: worker.online ? "online" : "offline", on: worker.online },
      entityIds: [],
      lastChanged: worker.lastSeenAt,
      manufacturer: null,
      model: null,
    });
  }

  return devices
    .map((device) => {
      const setting = settings.get(device.id);
      const classSensitive = sensitiveClasses.has(device.domain);
      const explicit = setting?.sensitive;
      const sensitive = explicit === true || (explicit !== false && classSensitive);
      const sensitiveReason: HomeDevice["sensitiveReason"] = !sensitive
        ? null
        : explicit === true
          ? "user"
          : "class";
      let roomId = device.roomId;
      if (setting?.roomId !== undefined && setting.roomId !== null && roomIds.has(setting.roomId)) {
        roomId = setting.roomId;
      } else if (roomId === null && device.areaId !== null) {
        roomId = roomForArea.get(device.areaId) ?? null;
      }
      return {
        ...device,
        name: setting?.alias ?? device.name,
        roomId,
        sensitive,
        sensitiveReason,
        hidden: setting?.hidden === true,
      };
    })
    .filter((d) => !d.hidden)
    .map(({ hidden: _hidden, ...device }) => device);
}

/** Rooms to create so every HA area has a NEXUS room. */
export function missingRoomsForAreas(
  areas: readonly HaArea[],
  rooms: readonly HomeRoom[],
): HaArea[] {
  const mapped = new Set(rooms.map((r) => r.haAreaId).filter((id): id is string => id !== null));
  return areas.filter((a) => !mapped.has(a.area_id));
}

/**
 * Live HA entity state, kept current by `state_changed` events. The API
 * holds one per connected Home Assistant.
 */
export class HomeAssistantStateCache {
  #states = new Map<string, HaStateObject>();
  #areas: HaArea[] = [];
  #devices: HaDeviceEntry[] = [];
  #entities: HaEntityEntry[] = [];
  #syncedAt: string | null = null;

  replace(snapshot: HomeAssistantSnapshot, at: Date = new Date()): void {
    this.#states = new Map(snapshot.states.map((s) => [s.entity_id, s]));
    this.#areas = [...snapshot.areas];
    this.#devices = [...snapshot.devices];
    this.#entities = [...snapshot.entities];
    this.#syncedAt = at.toISOString();
  }

  /** Returns true when the entity is known (tracked), false otherwise. */
  apply(entityId: string, newState: HaStateObject | null): boolean {
    if (newState === null) return this.#states.delete(entityId);
    this.#states.set(entityId, newState);
    return true;
  }

  clear(): void {
    this.#states.clear();
    this.#areas = [];
    this.#devices = [];
    this.#entities = [];
    this.#syncedAt = null;
  }

  get syncedAt(): string | null {
    return this.#syncedAt;
  }

  get areas(): readonly HaArea[] {
    return this.#areas;
  }

  state(entityId: string): HaStateObject | undefined {
    return this.#states.get(entityId);
  }

  snapshot(): HomeAssistantSnapshot {
    return {
      states: [...this.#states.values()],
      areas: this.#areas,
      devices: this.#devices,
      entities: this.#entities,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "expected #rrggbb")
  .transform((v) => v.toLowerCase());
const percent = z.number().int().min(0).max(100);

export const MEDIA_COMMANDS = [
  "play",
  "pause",
  "play_pause",
  "stop",
  "next",
  "previous",
  "volume_up",
  "volume_down",
  "volume_set",
  "mute",
  "unmute",
] as const;

export const homeActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("turn_on"),
    brightness: percent.optional(),
    color: hexColor.optional(),
    transition: z.number().min(0).max(300).optional(),
  }),
  z.object({ action: z.literal("turn_off") }),
  z.object({ action: z.literal("toggle") }),
  z.object({ action: z.literal("set_brightness"), brightness: percent }),
  z.object({ action: z.literal("set_color"), color: hexColor }),
  z.object({
    action: z.literal("media"),
    command: z.enum(MEDIA_COMMANDS),
    volume: percent.optional(),
  }),
  z.object({ action: z.literal("remote"), key: z.string().min(1).max(32) }),
  z.object({ action: z.literal("lock") }),
  z.object({ action: z.literal("unlock") }),
  z.object({ action: z.literal("set_temperature"), temperature: z.number().min(5).max(35) }),
  z.object({ action: z.literal("alarm_arm"), mode: z.enum(["home", "away", "night"]) }),
  z.object({ action: z.literal("alarm_disarm"), code: z.string().max(32).optional() }),
  z.object({ action: z.literal("open") }),
  z.object({ action: z.literal("close") }),
  z.object({ action: z.literal("stop") }),
  z.object({ action: z.literal("mic_mute"), muted: z.boolean() }),
  z.object({ action: z.literal("speak"), text: z.string().min(1).max(500) }),
]);
export type HomeAction = z.infer<typeof homeActionSchema>;
export type HomeActionName = HomeAction["action"];

/** Capability each action requires. */
export const ACTION_CAPABILITY: Record<HomeActionName, HomeCapability> = {
  turn_on: "onoff",
  turn_off: "onoff",
  toggle: "onoff",
  set_brightness: "brightness",
  set_color: "color",
  media: "media",
  remote: "remote",
  lock: "lock",
  unlock: "lock",
  set_temperature: "climate",
  alarm_arm: "alarm",
  alarm_disarm: "alarm",
  open: "cover",
  close: "cover",
  stop: "cover",
  mic_mute: "mic",
  speak: "speaker",
};

/** Actions that are sensitive whatever the device policy says. */
export const ALWAYS_SENSITIVE_ACTIONS: ReadonlySet<HomeActionName> = new Set([
  "unlock",
  "alarm_disarm",
]);

export class HomeActionNotSupportedError extends AppError {
  readonly code = "HOME_ACTION_NOT_SUPPORTED";
  readonly httpStatus = 422;

  constructor(deviceName: string, action: string, reason: string) {
    super({
      message: `Action ${action} not supported by ${deviceName}: ${reason}`,
      userMessage: `"${deviceName}" cannot do "${action}" (${reason}).`,
      context: { action, reason },
    });
  }
}

/** Validates an action against a device's declared capabilities. Throws when unsupported. */
export function assertActionSupported(device: HomeDevice, action: HomeAction): void {
  const needed = ACTION_CAPABILITY[action.action];
  if (!device.capabilities.includes(needed)) {
    throw new HomeActionNotSupportedError(device.name, action.action, `requires ${needed}`);
  }
  if (action.action === "turn_on") {
    if (action.brightness !== undefined && !device.capabilities.includes("brightness")) {
      throw new HomeActionNotSupportedError(device.name, "turn_on", "no brightness control");
    }
    if (action.color !== undefined && !device.capabilities.includes("color")) {
      throw new HomeActionNotSupportedError(device.name, "turn_on", "no colour control");
    }
  }
  if (action.action === "media" && action.command === "volume_set" && action.volume === undefined) {
    throw new HomeActionNotSupportedError(device.name, "media", "volume_set needs a volume");
  }
}

export function actionIsSensitive(device: HomeDevice, action: HomeAction): boolean {
  return device.sensitive || ALWAYS_SENSITIVE_ACTIONS.has(action.action);
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Translates a validated action on an HA-backed device into an HA service call. */
export function toHomeAssistantServiceCall(
  device: HomeDevice,
  action: HomeAction,
): HomeAssistantServiceCall {
  if (device.source !== "home_assistant") {
    throw new HomeActionNotSupportedError(
      device.name,
      action.action,
      "not a Home Assistant device",
    );
  }
  const entityId = device.entityIds[0] ?? device.id.slice(3);
  const domain = device.domain;
  const call = (
    d: string,
    service: string,
    serviceData?: Record<string, unknown>,
  ): HomeAssistantServiceCall => ({
    domain: d,
    service,
    targetEntityId: entityId,
    ...(serviceData === undefined ? {} : { serviceData }),
  });
  switch (action.action) {
    case "turn_on": {
      if (domain !== "light") return call(domain, "turn_on");
      const data: Record<string, unknown> = {};
      if (action.brightness !== undefined) data.brightness_pct = action.brightness;
      if (action.color !== undefined) data.rgb_color = hexToRgb(action.color);
      if (action.transition !== undefined) data.transition = action.transition;
      return call("light", "turn_on", Object.keys(data).length === 0 ? undefined : data);
    }
    case "turn_off":
      return call(domain, "turn_off");
    case "toggle":
      return call(domain, "toggle");
    case "set_brightness":
      return action.brightness === 0
        ? call("light", "turn_off")
        : call("light", "turn_on", { brightness_pct: action.brightness });
    case "set_color":
      return call("light", "turn_on", { rgb_color: hexToRgb(action.color) });
    case "media":
      switch (action.command) {
        case "play":
          return call("media_player", "media_play");
        case "pause":
          return call("media_player", "media_pause");
        case "play_pause":
          return call("media_player", "media_play_pause");
        case "stop":
          return call("media_player", "media_stop");
        case "next":
          return call("media_player", "media_next_track");
        case "previous":
          return call("media_player", "media_previous_track");
        case "volume_up":
          return call("media_player", "volume_up");
        case "volume_down":
          return call("media_player", "volume_down");
        case "volume_set":
          return call("media_player", "volume_set", { volume_level: (action.volume ?? 0) / 100 });
        case "mute":
          return call("media_player", "volume_mute", { is_volume_muted: true });
        case "unmute":
          return call("media_player", "volume_mute", { is_volume_muted: false });
      }
      break;
    case "lock":
      return call("lock", "lock");
    case "unlock":
      return call("lock", "unlock");
    case "set_temperature":
      return call(domain, "set_temperature", { temperature: action.temperature });
    case "alarm_arm":
      return call("alarm_control_panel", `alarm_arm_${action.mode}`);
    case "alarm_disarm":
      return call(
        "alarm_control_panel",
        "alarm_disarm",
        action.code === undefined ? undefined : { code: action.code },
      );
    case "open":
      return call("cover", "open_cover");
    case "close":
      return call("cover", "close_cover");
    case "stop":
      return call("cover", "stop_cover");
    default:
      break;
  }
  throw new HomeActionNotSupportedError(device.name, action.action, "no Home Assistant mapping");
}

/** Short human description, used in confirmations and execution logs. */
export function describeHomeAction(device: HomeDevice, action: HomeAction): string {
  switch (action.action) {
    case "turn_on": {
      const extra = [
        action.brightness === undefined ? null : `${String(action.brightness)}%`,
        action.color ?? null,
      ].filter((v) => v !== null);
      return `Turn on ${device.name}${extra.length > 0 ? ` (${extra.join(", ")})` : ""}`;
    }
    case "turn_off":
      return `Turn off ${device.name}`;
    case "toggle":
      return `Toggle ${device.name}`;
    case "set_brightness":
      return `Set ${device.name} brightness to ${String(action.brightness)}%`;
    case "set_color":
      return `Set ${device.name} colour to ${action.color}`;
    case "media":
      return `${device.name}: ${action.command}${action.volume === undefined ? "" : ` ${String(action.volume)}%`}`;
    case "remote":
      return `${device.name} remote: ${action.key}`;
    case "lock":
      return `Lock ${device.name}`;
    case "unlock":
      return `Unlock ${device.name}`;
    case "set_temperature":
      return `Set ${device.name} to ${String(action.temperature)} C`;
    case "alarm_arm":
      return `Arm ${device.name} (${action.mode})`;
    case "alarm_disarm":
      return `Disarm ${device.name}`;
    case "open":
      return `Open ${device.name}`;
    case "close":
      return `Close ${device.name}`;
    case "stop":
      return `Stop ${device.name}`;
    case "mic_mute":
      return `${action.muted ? "Mute" : "Unmute"} microphone of ${device.name}`;
    case "speak":
      return `Speak on ${device.name}`;
  }
}

/**
 * Resolves a free-text device reference ("salon lampe", "light.salon", an
 * id) against the device list. Returns every candidate when ambiguous.
 */
export function resolveHomeDevice(
  devices: readonly HomeDevice[],
  rooms: readonly HomeRoom[],
  query: string,
): HomeDevice[] {
  const exact = devices.find(
    (d) => d.id === query || d.entityIds[0] === query || d.id === `ha:${query}`,
  );
  if (exact !== undefined) return [exact];
  const words = normalizeText(query)
    .split(" ")
    .filter((w) => w.length > 1);
  if (words.length === 0) return [];
  const roomNames = new Map(rooms.map((r) => [r.id, normalizeText(r.name)]));
  const scored = devices
    .map((device) => {
      const haystack = `${normalizeText(device.name)} ${device.roomId === null ? "" : (roomNames.get(device.roomId) ?? "")} ${normalizeText(device.domain)}`;
      const score = words.filter((w) => haystack.includes(w)).length;
      return { device, score };
    })
    .filter((s) => s.score > 0);
  if (scored.length === 0) return [];
  const best = Math.max(...scored.map((s) => s.score));
  return scored.filter((s) => s.score === best).map((s) => s.device);
}
