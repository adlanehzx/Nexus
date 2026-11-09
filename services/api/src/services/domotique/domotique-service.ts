import { createHash, randomBytes } from "node:crypto";
import {
  DEFAULT_SENSITIVE_CLASSES,
  HomeActionNotSupportedError,
  HomeAssistantAuthError,
  HomeAssistantBridge,
  HomeAssistantClient,
  HomeAssistantSetupError,
  HomeAssistantStateCache,
  acceptDiscoveredIntegration,
  listDiscoveredIntegrations,
  loginHomeAssistant,
  onboardHomeAssistant,
  probeHomeAssistant,
  type DiscoveredIntegration,
  type HomeAssistantProbe,
  type HomeAssistantSetupOptions,
  actionIsSensitive,
  assertActionSupported,
  buildHomeDevices,
  conditionsHold,
  describeHomeAction,
  domainOf,
  dueTimeRoutines,
  expandRoutineActions,
  homeActionSchema,
  missingRoomsForAreas,
  normalizeHomeAssistantUrl,
  sensitiveTargets,
  stateTriggeredRoutines,
  toHomeAssistantServiceCall,
  zonedParts,
  CONTROLLABLE_DOMAINS,
  type FireTvSourceView,
  type HaStateChangedEvent,
  type HomeAction,
  type HomeAssistantConnectionStatus,
  type HomeDevice,
  type HomeDeviceSetting,
  type HomeExecutionLogEntry,
  type HomeExecutionStatus,
  type HomeRoom,
  type HomeRoutine,
  type HomeScene,
  type HomeToolsHost,
  type RoutineInput,
  type SatelliteSourceView,
  type SceneInput,
  type WorkerSourceView,
} from "@nexus/devices";
import { AppError, ConflictError, NotFoundError, ValidationError, uuidv7 } from "@nexus/shared";
import type { ConfirmationService } from "@nexus/tools";
import type { ConfirmationBroker } from "../confirmation-broker.js";
import type { SecretVault } from "../runtime-configuration.js";
import { ACTION_KEYS, type FireTvAction } from "../fire-tv.js";
import type { AdbDeviceRecord, DomotiqueStore, HomeAssistantLinkRecord } from "./store.js";

/**
 * Domotique orchestration: NEXUS is the brain, Home Assistant the hands.
 *
 * - One live Home Assistant connection per owner (URL + long-lived token
 *   configured from the dashboard, token held by the secret vault).
 * - A unified device registry merging HA entities, ESP32 satellites, the
 *   Fire TV and NEXUS workers, with rooms (HA areas mapped, editable).
 * - Device actions validated per capability; sensitive devices go through
 *   the existing confirmation broker, never straight to the device.
 * - Scenes and routines executed here, with a persisted execution log.
 *
 * No fake data: if HA is not configured or unreachable, there simply are no
 * HA devices, and the status says why.
 */

export interface SatelliteDirectory {
  list(): {
    deviceId: string;
    name: string;
    online: boolean;
    lastSeenAt: string;
    health: Record<string, unknown>;
    capabilities: Record<string, unknown>[];
  }[];
  isOwnedBy(deviceId: string, userId: string): boolean;
  ownerOf(deviceId: string): string | undefined;
  enqueue(deviceId: string, command: "audio.privacy", params: Record<string, unknown>): unknown;
}

export interface SatelliteVoiceDirectory {
  connectedIds(): string[];
  status(deviceId: string): { connected: boolean; speaker: boolean } | undefined;
  say(deviceId: string, text: string): Promise<boolean>;
}

export interface WorkerDirectory {
  listDevices(userId: string): Promise<
    readonly {
      id: string;
      name: string;
      type: string;
      status: string;
      lastSeenAt: Date | null;
      health: unknown;
    }[]
  >;
}

/** ADB bridge: returns a controller for any `host:port` serial. */
export interface AdbControl {
  controlFor(serial: string): { control(action: FireTvAction): Promise<unknown> };
  /** Install-wide TV from `FIRE_TV_ADB_SERIAL`, visible to every account. Optional. */
  readonly sharedSerial?: string | undefined;
}

/** Satellites enrolled from the network (see `SatelliteEnrollmentService`). */
export interface EnrolledSatelliteDirectory {
  owned(userId: string): Promise<
    readonly {
      deviceId: string;
      name: string;
      firmware: string | null;
      capabilities: readonly { name: string }[];
      approvedAt: string | null;
    }[]
  >;
}

/** Finds `_home-assistant._tcp` instances on the LAN. */
export type HomeAssistantBrowser = () => Promise<
  readonly {
    host: string | null;
    port: number | null;
    addresses: string[];
    txt: Record<string, string>;
  }[]
>;

const ADB_SERIAL = /^[a-zA-Z0-9._:-]{1,128}$/;

export type HomeAssistantClientFactory = (input: {
  baseUrl: string;
  token: string;
}) => HomeAssistantClient;

export interface DomotiqueServiceOptions {
  readonly store: DomotiqueStore;
  readonly confirmations: ConfirmationService;
  readonly broker: ConfirmationBroker;
  readonly vault?: SecretVault | undefined;
  readonly clientFactory?: HomeAssistantClientFactory;
  /**
   * Timezone of routine schedules when Home Assistant does not provide one.
   * Default: the host timezone.
   */
  readonly timezoneFor?: (ownerId: string) => Promise<string>;
  /** LAN discovery of Home Assistant (mDNS). Omitted = only well-known URLs are probed. */
  readonly browseHomeAssistant?: HomeAssistantBrowser;
  /** Extra URLs probed during discovery (e.g. the bundled container). */
  readonly homeAssistantCandidates?: readonly string[];
  /** Options passed to the HA setup helpers (tests inject fetch / sockets). */
  readonly setupOptions?: HomeAssistantSetupOptions;
  readonly now?: () => Date;
  readonly log?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  /** Scheduler cadence; 0 disables the timer (tests call `tick`). */
  readonly tickMs?: number;
}

export interface HomeActionOutcome {
  readonly status: HomeExecutionStatus;
  readonly message: string;
  readonly deviceId: string;
  readonly confirmationId?: string;
}

export interface HomeAssistantStatusView {
  readonly configured: boolean;
  readonly baseUrl: string | null;
  readonly enabled: boolean;
  readonly token: { readonly stored: boolean; readonly persistence: "vault" | "memory" | null };
  readonly connection: Omit<HomeAssistantConnectionStatus, "state"> & {
    readonly state: HomeAssistantConnectionStatus["state"] | "not_configured" | "token_missing";
  };
  readonly syncedAt: string | null;
  readonly entityCount: number;
  readonly areaCount: number;
  readonly sensitiveClasses: readonly string[];
}

interface Runtime {
  link: HomeAssistantLinkRecord;
  client: HomeAssistantClient | undefined;
  bridge: HomeAssistantBridge | undefined;
  cache: HomeAssistantStateCache;
  tokenMissing: boolean;
  /** IANA timezone reported by Home Assistant. */
  timeZone: string | null;
  dispose: (() => void)[];
}

type Origin = "user" | "agent" | "voice" | "scene" | "routine";

const EMPTY_CONNECTION = {
  haVersion: null,
  connectedAt: null,
  lastError: null,
  attempt: 0,
  nextRetryAt: null,
};

export class DomotiqueService {
  readonly #o: DomotiqueServiceOptions;
  readonly #now: () => Date;
  readonly #runtimes = new Map<string, Runtime>();
  readonly #memoryTokens = new Map<string, string>();
  readonly #deviceCache = new Map<string, readonly HomeDevice[]>();
  readonly #sceneCache = new Map<string, readonly HomeScene[]>();
  #satellites: SatelliteDirectory | undefined;
  #voice: SatelliteVoiceDirectory | undefined;
  #workers: WorkerDirectory | undefined;
  #adb: AdbControl | undefined;
  readonly #adbReachable = new Map<string, boolean>();
  #enrolled: EnrolledSatelliteDirectory | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastTickMinute: string | null = null;
  #started = false;

  constructor(options: DomotiqueServiceOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
  }

  // ── Sources ─────────────────────────────────────────────────────────────

  attachSatellites(directory: SatelliteDirectory): void {
    this.#satellites = directory;
  }

  attachVoice(directory: SatelliteVoiceDirectory): void {
    this.#voice = directory;
  }

  attachWorkers(directory: WorkerDirectory): void {
    this.#workers = directory;
  }

  attachAdb(control: AdbControl | undefined): void {
    this.#adb = control;
  }

  attachEnrollment(directory: EnrolledSatelliteDirectory): void {
    this.#enrolled = directory;
  }

  /** Owner of a paired satellite (network enrolment or SATELLITE_OWNERS_JSON). */
  satelliteOwner(deviceId: string): string | undefined {
    return this.#satellites?.ownerOf(deviceId);
  }

  // ── Android / Fire TV over ADB ──────────────────────────────────────────

  async listTvs(ownerId: string): Promise<(AdbDeviceRecord & { shared: boolean })[]> {
    const own = (await this.#o.store.listAdbDevices(ownerId)).map((d) => ({ ...d, shared: false }));
    const shared = this.#adb?.sharedSerial;
    if (shared !== undefined && !own.some((d) => d.serial === shared)) {
      own.push({ serial: shared, name: "TV", shared: true });
    }
    return own;
  }

  async addTv(ownerId: string, input: { serial: string; name: string }): Promise<AdbDeviceRecord> {
    const serial = input.serial.trim();
    if (!ADB_SERIAL.test(serial)) {
      throw new ValidationError({
        message: "invalid adb serial",
        userMessage: "Enter the TV address as host:port, for example 10.0.0.42:5555.",
      });
    }
    const record = { serial, name: input.name.trim() === "" ? "TV" : input.name.trim() };
    await this.#o.store.saveAdbDevice(ownerId, record);
    return record;
  }

  async removeTv(ownerId: string, serial: string): Promise<void> {
    await this.#o.store.deleteAdbDevice(ownerId, serial);
  }

  /**
   * Sends a remote key to one of the owner's TVs. Only TVs the owner added
   * (or the install-wide one) can be targeted: the API is not an open ADB relay.
   */
  async tvRemote(
    ownerId: string,
    action: FireTvAction,
    serial?: string,
  ): Promise<{ serial: string }> {
    const tvs = await this.listTvs(ownerId);
    const target = serial === undefined ? tvs[0] : tvs.find((t) => t.serial === serial);
    if (target === undefined) {
      throw new NotFoundError({
        message: "no tv configured",
        userMessage: "No TV is configured yet. Add one in Domotique, TV tab.",
      });
    }
    if (this.#adb === undefined) throw new Error("ADB bridge is not available.");
    try {
      await this.#adb.controlFor(target.serial).control(action);
      this.#adbReachable.set(target.serial, true);
    } catch (error) {
      this.#adbReachable.set(target.serial, false);
      throw error;
    }
    return { serial: target.serial };
  }

  // ── Home Assistant discovery and hands-free setup ───────────────────────

  /**
   * Looks for Home Assistant on the LAN (mDNS) and at well-known addresses
   * (bundled container, `homeassistant.local`). Never invents an instance.
   */
  async discoverHomeAssistant(): Promise<HomeAssistantProbe[]> {
    const candidates = new Set<string>(
      this.#o.homeAssistantCandidates ?? [
        "http://127.0.0.1:8123",
        "http://homeassistant.local:8123",
        "http://homeassistant:8123",
      ],
    );
    try {
      for (const service of (await this.#o.browseHomeAssistant?.()) ?? []) {
        const advertised = service.txt.internal_url ?? service.txt.base_url;
        if (advertised !== undefined && /^https?:\/\//.test(advertised)) candidates.add(advertised);
        const port = service.port ?? 8123;
        for (const address of service.addresses)
          candidates.add(`http://${address}:${String(port)}`);
      }
    } catch (error) {
      this.#o.log?.warn({ err: error }, "Home Assistant mDNS discovery failed");
    }
    const probes = await Promise.all(
      [...candidates].map((url) =>
        probeHomeAssistant(url, { timeoutMs: 2_500, ...this.#o.setupOptions }),
      ),
    );
    // One entry per instance: the same HA is often reachable under several names.
    const found = probes.filter((p) => p.isHomeAssistant);
    return found.length <= 1 ? found : dedupeProbes(found);
  }

  /**
   * One-click setup. A fresh HA is onboarded by NEXUS (owner account created
   * with the given or generated credentials, returned once so the person can
   * open HA's own UI). An already-owned HA needs `login` instead.
   */
  async autoSetupHomeAssistant(
    ownerId: string,
    input: {
      baseUrl: string;
      ownerName: string;
      username?: string;
      password?: string;
      language?: string;
    },
  ): Promise<{
    status: HomeAssistantStatusView;
    credentials: { username: string; password: string } | null;
  }> {
    const probe = await probeHomeAssistant(input.baseUrl, this.#o.setupOptions);
    if (!probe.isHomeAssistant) {
      throw new ValidationError({
        message: "not home assistant",
        userMessage: "No Home Assistant answers at this address.",
      });
    }
    if (probe.onboarded !== false) {
      throw new ConflictError({
        message: "home assistant already onboarded",
        userMessage:
          "This Home Assistant already has an owner: sign in with its username and password.",
      });
    }
    const username =
      (input.username ?? "nexus")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "") || "nexus";
    const generated = input.password === undefined;
    const password = input.password ?? randomBytes(18).toString("base64url");
    const { token } = await onboardHomeAssistant(
      probe.url,
      {
        name: input.ownerName,
        username,
        password,
        ...(input.language === undefined ? {} : { language: input.language }),
      },
      this.#o.setupOptions,
    ).catch((error: unknown) => {
      throw this.#setupError(error);
    });
    const status = await this.configure(ownerId, { baseUrl: probe.url, token });
    return { status, credentials: generated ? { username, password } : null };
  }

  /** Signs in to an existing HA; the credentials are used once and never stored. */
  async loginHomeAssistant(
    ownerId: string,
    input: { baseUrl: string; username: string; password: string },
  ): Promise<HomeAssistantStatusView> {
    const { token } = await loginHomeAssistant(
      input.baseUrl,
      { username: input.username, password: input.password },
      this.#o.setupOptions,
    ).catch((error: unknown) => {
      throw this.#setupError(error);
    });
    return this.configure(ownerId, { baseUrl: input.baseUrl, token });
  }

  async discoveredIntegrations(ownerId: string): Promise<DiscoveredIntegration[]> {
    const client = this.#connectedClient(ownerId);
    return client === undefined ? [] : listDiscoveredIntegrations(client);
  }

  async acceptIntegration(
    ownerId: string,
    flowId: string,
  ): Promise<{ status: "added" | "needs_input" | "aborted"; detail: string }> {
    const client = this.#connectedClient(ownerId);
    if (client === undefined) {
      throw new ValidationError({
        message: "ha not connected",
        userMessage: "Home Assistant is not connected.",
      });
    }
    const result = await acceptDiscoveredIntegration(client, flowId);
    if (result.status === "added") await this.#sync(ownerId).catch(() => undefined);
    return result;
  }

  #connectedClient(ownerId: string): HomeAssistantClient | undefined {
    const client = this.#runtimes.get(ownerId)?.client;
    return client?.status.state === "connected" ? client : undefined;
  }

  #setupError(error: unknown): Error {
    if (error instanceof HomeAssistantSetupError) {
      return error.reason === "invalid_auth"
        ? new HomeAssistantAuthError()
        : new ValidationError({ message: error.message, userMessage: error.message });
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /** Routine timezone: Home Assistant's, else the configured one, else the host's. */
  async timezone(ownerId: string): Promise<string> {
    return (
      this.#runtimes.get(ownerId)?.timeZone ??
      (await this.#o.timezoneFor?.(ownerId)) ??
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Connects every configured Home Assistant and starts the routine scheduler. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const links = await this.#o.store.listLinks();
    for (const link of links) {
      if (link.enabled) await this.#connect(link);
    }
    const tickMs = this.#o.tickMs ?? 15_000;
    if (tickMs > 0) {
      this.#timer = setInterval(() => {
        void this.tick().catch((error: unknown) => {
          this.#o.log?.warn({ err: error }, "domotique scheduler tick failed");
        });
      }, tickMs);
      this.#timer.unref();
    }
  }

  stop(): void {
    this.#started = false;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    for (const ownerId of [...this.#runtimes.keys()]) this.#teardown(ownerId);
  }

  // ── Home Assistant configuration ────────────────────────────────────────

  async status(ownerId: string): Promise<HomeAssistantStatusView> {
    const link = await this.#o.store.getLink(ownerId);
    if (link === undefined) {
      return {
        configured: false,
        baseUrl: null,
        enabled: false,
        token: { stored: false, persistence: null },
        connection: { state: "not_configured", ...EMPTY_CONNECTION },
        syncedAt: null,
        entityCount: 0,
        areaCount: 0,
        sensitiveClasses: DEFAULT_SENSITIVE_CLASSES,
      };
    }
    const runtime = this.#runtimes.get(ownerId);
    const snapshot = runtime?.cache.snapshot();
    const persistence =
      link.tokenRef === null ? null : link.tokenRef.startsWith("vault://") ? "vault" : "memory";
    const tokenStored =
      link.tokenRef !== null && (persistence === "vault" || this.#memoryTokens.has(ownerId));
    const connection: HomeAssistantStatusView["connection"] = !tokenStored
      ? { state: "token_missing", ...EMPTY_CONNECTION }
      : runtime?.client === undefined
        ? runtime?.tokenMissing === true
          ? { state: "token_missing", ...EMPTY_CONNECTION }
          : { state: "disconnected", ...EMPTY_CONNECTION }
        : runtime.client.status;
    return {
      configured: true,
      baseUrl: link.baseUrl,
      enabled: link.enabled,
      token: { stored: tokenStored, persistence },
      connection,
      syncedAt: runtime?.cache.syncedAt ?? null,
      entityCount: snapshot?.states.length ?? 0,
      areaCount: snapshot?.areas.length ?? 0,
      sensitiveClasses: link.sensitiveClasses,
    };
  }

  /**
   * Saves URL / token / policy, then (re)connects. A token is verified over
   * REST before being stored: a rejected token is refused with a clear error
   * and never persisted. An unreachable HA is accepted (it may be booting).
   */
  async configure(
    ownerId: string,
    input: {
      baseUrl: string;
      token?: string | undefined;
      enabled?: boolean | undefined;
      sensitiveClasses?: readonly string[] | undefined;
    },
  ): Promise<HomeAssistantStatusView> {
    let baseUrl: string;
    try {
      baseUrl = normalizeHomeAssistantUrl(input.baseUrl);
    } catch (error) {
      throw new ValidationError({
        message: "invalid Home Assistant URL",
        userMessage: error instanceof Error ? error.message : "Invalid Home Assistant URL.",
      });
    }
    const existing = await this.#o.store.getLink(ownerId);
    let tokenRef = existing?.tokenRef ?? null;
    const token = input.token?.trim();
    if (token !== undefined && token.length > 0) {
      const probe = this.#factory({ baseUrl, token });
      try {
        await probe.checkConnection();
      } catch (error) {
        if (error instanceof HomeAssistantAuthError) throw error;
        // Unreachable: keep the configuration, the status will say so.
      } finally {
        probe.close();
      }
      tokenRef = await this.#storeToken(ownerId, token);
    }
    const record: HomeAssistantLinkRecord = {
      ownerId,
      baseUrl,
      tokenRef,
      enabled: input.enabled ?? existing?.enabled ?? true,
      sensitiveClasses: [
        ...new Set(
          input.sensitiveClasses ?? existing?.sensitiveClasses ?? DEFAULT_SENSITIVE_CLASSES,
        ),
      ],
      updatedAt: this.#now().toISOString(),
    };
    await this.#o.store.saveLink(record);
    this.#o.log?.info(
      { ownerId, baseUrl, tokenUpdated: token !== undefined },
      "Home Assistant link saved",
    );
    this.#teardown(ownerId);
    if (record.enabled) await this.#connect(record);
    return this.status(ownerId);
  }

  /** Removes the link and deletes the token from the vault. */
  async unlink(ownerId: string): Promise<void> {
    const link = await this.#o.store.getLink(ownerId);
    this.#teardown(ownerId);
    if (link?.tokenRef?.startsWith("vault://") === true && this.#o.vault !== undefined) {
      await this.#o.vault.delete(this.#secretName(ownerId)).catch(() => undefined);
    }
    this.#memoryTokens.delete(ownerId);
    await this.#o.store.deleteLink(ownerId);
    this.#deviceCache.delete(ownerId);
  }

  /** Probes URL and stored token over REST without changing anything. */
  async testConnection(ownerId: string): Promise<{
    ok: boolean;
    version: string | null;
    locationName: string | null;
    error: string | null;
  }> {
    const link = await this.#o.store.getLink(ownerId);
    if (link === undefined)
      return { ok: false, version: null, locationName: null, error: "Not configured." };
    const token = await this.#readToken(link);
    if (token === undefined) {
      return { ok: false, version: null, locationName: null, error: "No access token stored." };
    }
    const probe = this.#factory({ baseUrl: link.baseUrl, token });
    try {
      const info = await probe.checkConnection();
      return { ok: true, ...info, error: null };
    } catch (error) {
      return {
        ok: false,
        version: null,
        locationName: null,
        error: error instanceof AppError ? error.userMessage : "Home Assistant unreachable.",
      };
    } finally {
      probe.close();
    }
  }

  /** Forces a full registry resync over the live connection. */
  async resync(ownerId: string): Promise<void> {
    await this.#sync(ownerId);
  }

  // ── Registry ────────────────────────────────────────────────────────────

  async listRooms(ownerId: string): Promise<HomeRoom[]> {
    return this.#o.store.listRooms(ownerId);
  }

  async createRoom(ownerId: string, name: string): Promise<HomeRoom> {
    const rooms = await this.#o.store.listRooms(ownerId);
    const room: HomeRoom = {
      id: uuidv7(),
      name: name.trim(),
      haAreaId: null,
      sortOrder: rooms.reduce((max, r) => Math.max(max, r.sortOrder + 1), 0),
    };
    await this.#o.store.saveRoom(ownerId, room);
    return room;
  }

  async updateRoom(
    ownerId: string,
    roomId: string,
    patch: { name?: string | undefined; sortOrder?: number | undefined },
  ): Promise<HomeRoom> {
    const room = (await this.#o.store.listRooms(ownerId)).find((r) => r.id === roomId);
    if (room === undefined)
      throw new NotFoundError({ message: `room ${roomId}`, userMessage: "Room not found." });
    const updated: HomeRoom = {
      ...room,
      ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
      ...(patch.sortOrder === undefined ? {} : { sortOrder: patch.sortOrder }),
    };
    await this.#o.store.saveRoom(ownerId, updated);
    return updated;
  }

  /** Rooms mirroring an HA area can be renamed but not deleted (the next sync would recreate them). */
  async deleteRoom(ownerId: string, roomId: string): Promise<void> {
    const room = (await this.#o.store.listRooms(ownerId)).find((r) => r.id === roomId);
    if (room === undefined)
      throw new NotFoundError({ message: `room ${roomId}`, userMessage: "Room not found." });
    if (room.haAreaId !== null) {
      throw new ValidationError({
        message: "room mirrors a Home Assistant area",
        userMessage:
          "This room mirrors a Home Assistant area: rename it, or delete the area in Home Assistant.",
      });
    }
    for (const setting of await this.#o.store.listSettings(ownerId)) {
      if (setting.roomId === roomId)
        await this.#o.store.saveSetting(ownerId, { ...setting, roomId: null });
    }
    await this.#o.store.deleteRoom(ownerId, roomId);
  }

  async updateDevice(
    ownerId: string,
    deviceId: string,
    patch: {
      roomId?: string | null | undefined;
      sensitive?: boolean | null | undefined;
      alias?: string | null | undefined;
      hidden?: boolean | undefined;
    },
  ): Promise<HomeDeviceSetting> {
    const known = (await this.#rawDevices(ownerId)).some((d) => d.id === deviceId);
    if (!known)
      throw new NotFoundError({ message: `device ${deviceId}`, userMessage: "Device not found." });
    if (patch.roomId !== undefined && patch.roomId !== null) {
      const rooms = await this.#o.store.listRooms(ownerId);
      if (!rooms.some((r) => r.id === patch.roomId)) {
        throw new ValidationError({ message: "unknown room", userMessage: "Unknown room." });
      }
    }
    const current = (await this.#o.store.listSettings(ownerId)).find(
      (s) => s.deviceId === deviceId,
    );
    const next: HomeDeviceSetting = {
      deviceId,
      roomId: patch.roomId !== undefined ? patch.roomId : (current?.roomId ?? null),
      sensitive: patch.sensitive !== undefined ? patch.sensitive : (current?.sensitive ?? null),
      alias: patch.alias !== undefined ? patch.alias : (current?.alias ?? null),
      hidden: patch.hidden ?? current?.hidden ?? false,
    };
    await this.#o.store.saveSetting(ownerId, next);
    return next;
  }

  /** Unified device list for one owner. Never invents a device. */
  async listDevices(
    ownerId: string,
    options: { includeHidden?: boolean } = {},
  ): Promise<HomeDevice[]> {
    const [rooms, settings, link] = await Promise.all([
      this.#o.store.listRooms(ownerId),
      this.#o.store.listSettings(ownerId),
      this.#o.store.getLink(ownerId),
    ]);
    const runtime = this.#runtimes.get(ownerId);
    const devices = buildHomeDevices({
      ha: runtime?.cache.syncedAt == null ? undefined : runtime.cache.snapshot(),
      satellites: await this.#satelliteViews(ownerId),
      fireTvs: await this.#tvViews(ownerId),
      workers: await this.#workerViews(ownerId),
      rooms,
      settings:
        options.includeHidden === true ? settings.map((s) => ({ ...s, hidden: false })) : settings,
      sensitiveClasses: link?.sensitiveClasses ?? DEFAULT_SENSITIVE_CLASSES,
    });
    this.#deviceCache.set(ownerId, devices);
    return devices;
  }

  cachedDevices(ownerId: string): readonly HomeDevice[] {
    return this.#deviceCache.get(ownerId) ?? [];
  }

  async #rawDevices(ownerId: string): Promise<HomeDevice[]> {
    return this.listDevices(ownerId, { includeHidden: true });
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  async executeAction(input: {
    ownerId: string;
    deviceId: string;
    action: HomeAction;
    origin: Origin;
    confirmed: boolean;
    log?: boolean;
  }): Promise<HomeActionOutcome> {
    const action = homeActionSchema.parse(input.action);
    const device = (await this.listDevices(input.ownerId)).find((d) => d.id === input.deviceId);
    if (device === undefined) {
      throw new NotFoundError({
        message: `device ${input.deviceId}`,
        userMessage: "Device not found.",
      });
    }
    assertActionSupported(device, action);
    const description = describeHomeAction(device, action);

    if (!input.confirmed && actionIsSensitive(device, action)) {
      const confirmationId = await this.#requestConfirmation({
        ownerId: input.ownerId,
        description,
        payload: { deviceId: device.id, action },
        tool: "home.device_control",
        onApproved: async () => {
          await this.executeAction({ ...input, action, confirmed: true, log: true });
        },
        onDeclined: async (decision) => {
          await this.#log(
            input.ownerId,
            "action",
            device.id,
            description,
            "rejected",
            input.origin,
            {
              decision,
            },
          );
        },
      });
      const outcome: HomeActionOutcome = {
        status: "pending_confirmation",
        message: `Confirmation required: ${description}`,
        deviceId: device.id,
        confirmationId,
      };
      if (input.log !== false) {
        await this.#log(
          input.ownerId,
          "action",
          device.id,
          description,
          outcome.status,
          input.origin,
          {
            action,
            confirmationId,
          },
        );
      }
      return outcome;
    }

    let outcome: HomeActionOutcome;
    try {
      const message = await this.#perform(input.ownerId, device, action, input.origin);
      outcome = { status: "succeeded", message, deviceId: device.id };
    } catch (error) {
      if (error instanceof HomeActionNotSupportedError) throw error;
      outcome = {
        status: "failed",
        message:
          error instanceof AppError
            ? error.userMessage
            : error instanceof Error
              ? error.message
              : "failed",
        deviceId: device.id,
      };
    }
    if (input.log !== false) {
      await this.#log(
        input.ownerId,
        "action",
        device.id,
        description,
        outcome.status,
        input.origin,
        {
          action,
          ...(outcome.status === "failed" ? { error: outcome.message } : {}),
        },
      );
    }
    return outcome;
  }

  async #perform(
    ownerId: string,
    device: HomeDevice,
    action: HomeAction,
    origin: Origin,
  ): Promise<string> {
    switch (device.source) {
      case "home_assistant": {
        const runtime = this.#runtimes.get(ownerId);
        if (runtime?.bridge === undefined || runtime.client?.status.state !== "connected") {
          throw new Error("Home Assistant is not connected.");
        }
        if (!device.online) throw new Error(`${device.name} is unavailable in Home Assistant.`);
        const call = toHomeAssistantServiceCall(device, action);
        const result = await runtime.bridge.executeWriteAction(
          call,
          ["homeassistant.write"],
          `${origin}:${ownerId}`,
        );
        return result.newState === undefined
          ? `${call.domain}.${call.service} sent`
          : `${device.name}: ${result.newState}`;
      }
      case "fire_tv": {
        const key = fireTvKeyFor(device, action);
        const { serial } = await this.tvRemote(ownerId, key, device.id.slice("firetv:".length));
        return `${device.name} (${serial}): ${key}`;
      }
      case "satellite": {
        const id = device.id.slice("sat:".length);
        if (action.action === "mic_mute") {
          if (this.#satellites === undefined) throw new Error("Satellite gateway unavailable.");
          this.#satellites.enqueue(id, "audio.privacy", { muted: action.muted });
          return `${device.name}: microphone ${action.muted ? "mute" : "unmute"} queued`;
        }
        if (action.action === "speak") {
          const spoken = (await this.#voice?.say(id, action.text)) ?? false;
          if (!spoken) throw new Error(`${device.name} has no connected speaker.`);
          return `${device.name}: speaking`;
        }
        throw new HomeActionNotSupportedError(device.name, action.action, "not a satellite action");
      }
      case "nexus_worker":
        throw new HomeActionNotSupportedError(
          device.name,
          action.action,
          "computers are not home devices",
        );
    }
  }

  async #requestConfirmation(input: {
    ownerId: string;
    description: string;
    payload: unknown;
    tool: string;
    onApproved: () => Promise<void>;
    onDeclined: (decision: "rejected" | "expired") => Promise<void>;
  }): Promise<string> {
    const request = await this.#o.confirmations.request({
      runId: `home-${uuidv7()}`,
      userId: input.ownerId,
      tool: input.tool,
      toolCallId: uuidv7(),
      action: input.tool,
      description: input.description,
      riskLevel: "HIGH",
      payload: input.payload,
    });
    void this.#o.broker
      .request({
        confirmationId: request.id,
        taskId: request.runId,
        stepId: request.toolCallId,
        capability: "homeassistant.write",
        action: input.tool,
        description: input.description,
        riskLevel: "HIGH",
        originClientDeviceId: "domotique",
        userId: input.ownerId,
        expiresAt: request.expiresAt,
      })
      .then(async (decision) => {
        if (decision === "approved") await input.onApproved();
        else await input.onDeclined(decision);
      })
      .catch((error: unknown) => {
        this.#o.log?.warn({ err: error }, "confirmed home action failed");
      });
    return request.id;
  }

  // ── Scenes ──────────────────────────────────────────────────────────────

  async listScenes(ownerId: string): Promise<HomeScene[]> {
    const scenes = await this.#o.store.listScenes(ownerId);
    this.#sceneCache.set(ownerId, scenes);
    return scenes;
  }

  async saveScene(ownerId: string, input: SceneInput, sceneId?: string): Promise<HomeScene> {
    const now = this.#now().toISOString();
    const existing =
      sceneId === undefined
        ? undefined
        : (await this.#o.store.listScenes(ownerId)).find((s) => s.id === sceneId);
    if (sceneId !== undefined && existing === undefined) {
      throw new NotFoundError({ message: `scene ${sceneId}`, userMessage: "Scene not found." });
    }
    const scene: HomeScene = {
      id: existing?.id ?? uuidv7(),
      ownerId,
      name: input.name,
      actions: input.actions,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.#o.store.saveScene(scene);
    await this.listScenes(ownerId);
    return scene;
  }

  async deleteScene(ownerId: string, sceneId: string): Promise<void> {
    await this.#o.store.deleteScene(ownerId, sceneId);
    await this.listScenes(ownerId);
  }

  async runScene(input: {
    ownerId: string;
    sceneId: string;
    origin: Origin;
    confirmed: boolean;
  }): Promise<{
    status: HomeExecutionStatus;
    message: string;
    confirmationId?: string;
    results: HomeActionOutcome[];
  }> {
    const scene = (await this.listScenes(input.ownerId)).find((s) => s.id === input.sceneId);
    if (scene === undefined) {
      throw new NotFoundError({
        message: `scene ${input.sceneId}`,
        userMessage: "Scene not found.",
      });
    }
    const devices = await this.listDevices(input.ownerId);
    const sensitive = sensitiveTargets(scene.actions, devices);
    if (!input.confirmed && sensitive.length > 0) {
      const description = `Run scene "${scene.name}" (sensitive: ${sensitive
        .map((id) => devices.find((d) => d.id === id)?.name ?? id)
        .join(", ")})`;
      const confirmationId = await this.#requestConfirmation({
        ownerId: input.ownerId,
        description,
        payload: { sceneId: scene.id, actions: scene.actions },
        tool: "home.scene_run",
        onApproved: async () => {
          await this.runScene({ ...input, confirmed: true });
        },
        onDeclined: async (decision) => {
          await this.#log(input.ownerId, "scene", scene.id, scene.name, "rejected", input.origin, {
            decision,
          });
        },
      });
      await this.#log(
        input.ownerId,
        "scene",
        scene.id,
        scene.name,
        "pending_confirmation",
        input.origin,
        {
          confirmationId,
        },
      );
      return { status: "pending_confirmation", message: description, confirmationId, results: [] };
    }
    const results = await this.#runActions(input.ownerId, scene.actions, "scene", true);
    const status = aggregate(results);
    await this.#log(input.ownerId, "scene", scene.id, scene.name, status, input.origin, {
      results: results.map((r) => ({ deviceId: r.deviceId, status: r.status, message: r.message })),
    });
    return { status, message: `Scene "${scene.name}": ${status}`, results };
  }

  async #runActions(
    ownerId: string,
    actions: readonly { deviceId: string; action: HomeAction }[],
    origin: Origin,
    confirmed: boolean,
  ): Promise<HomeActionOutcome[]> {
    const results: HomeActionOutcome[] = [];
    for (const item of actions) {
      try {
        results.push(
          await this.executeAction({
            ownerId,
            deviceId: item.deviceId,
            action: item.action,
            origin,
            confirmed,
            log: false,
          }),
        );
      } catch (error) {
        results.push({
          status: "failed",
          deviceId: item.deviceId,
          message: error instanceof AppError ? error.userMessage : String(error),
        });
      }
    }
    return results;
  }

  // ── Routines ────────────────────────────────────────────────────────────

  async listRoutines(ownerId: string): Promise<HomeRoutine[]> {
    return this.#o.store.listRoutines(ownerId);
  }

  async saveRoutine(
    ownerId: string,
    input: RoutineInput,
    routineId?: string,
  ): Promise<HomeRoutine> {
    const now = this.#now().toISOString();
    const existing =
      routineId === undefined
        ? undefined
        : (await this.#o.store.listRoutines(ownerId)).find((r) => r.id === routineId);
    if (routineId !== undefined && existing === undefined) {
      throw new NotFoundError({
        message: `routine ${routineId}`,
        userMessage: "Routine not found.",
      });
    }
    const routine: HomeRoutine = {
      id: existing?.id ?? uuidv7(),
      ownerId,
      name: input.name,
      enabled: input.enabled,
      trigger: input.trigger,
      conditions: input.conditions,
      actions: input.actions,
      lastRunAt: existing?.lastRunAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.#o.store.saveRoutine(routine);
    return routine;
  }

  async deleteRoutine(ownerId: string, routineId: string): Promise<void> {
    await this.#o.store.deleteRoutine(ownerId, routineId);
  }

  /**
   * Runs a routine. Automatic triggers evaluate conditions; a manual run
   * from the dashboard skips them. Sensitive actions inside a routine each
   * require confirmation: silence never implies consent.
   */
  async runRoutine(
    ownerId: string,
    routineId: string,
    reason: "manual" | "schedule" | "device_state",
  ): Promise<{ status: HomeExecutionStatus; results: HomeActionOutcome[] }> {
    const routine = (await this.#o.store.listRoutines(ownerId)).find((r) => r.id === routineId);
    if (routine === undefined) {
      throw new NotFoundError({
        message: `routine ${routineId}`,
        userMessage: "Routine not found.",
      });
    }
    if (reason !== "manual") {
      const tz = await this.timezone(ownerId);
      const devices = await this.listDevices(ownerId);
      const states = new Map(devices.map((d) => [d.id, d.state.raw]));
      if (
        !conditionsHold(routine.conditions, zonedParts(this.#now(), tz), (id) => states.get(id))
      ) {
        await this.#log(ownerId, "routine", routine.id, routine.name, "skipped", reason, {
          reason: "conditions not met",
        });
        return { status: "skipped", results: [] };
      }
    }
    const scenes = await this.#o.store.listScenes(ownerId);
    const actions = expandRoutineActions(routine.actions, scenes);
    const results = await this.#runActions(ownerId, actions, "routine", false);
    const status = aggregate(results);
    await this.#o.store.saveRoutine({ ...routine, lastRunAt: this.#now().toISOString() });
    await this.#log(ownerId, "routine", routine.id, routine.name, status, reason, {
      results: results.map((r) => ({
        deviceId: r.deviceId,
        status: r.status,
        message: r.message,
        ...(r.confirmationId === undefined ? {} : { confirmationId: r.confirmationId }),
      })),
    });
    return { status, results };
  }

  /** Scheduler step: fires `time` routines once per wall-clock minute. */
  async tick(at: Date = this.#now()): Promise<number> {
    const minuteKey = at.toISOString().slice(0, 16);
    if (this.#lastTickMinute === minuteKey) return 0;
    this.#lastTickMinute = minuteKey;
    const routines = await this.#o.store.listAllRoutines();
    const byOwner = new Map<string, HomeRoutine[]>();
    for (const routine of routines) {
      const list = byOwner.get(routine.ownerId) ?? [];
      list.push(routine);
      byOwner.set(routine.ownerId, list);
    }
    let fired = 0;
    for (const [ownerId, list] of byOwner) {
      const tz = await this.timezone(ownerId);
      for (const routine of dueTimeRoutines(list, zonedParts(at, tz))) {
        if (routine.lastRunAt?.slice(0, 16) === minuteKey) continue;
        fired += 1;
        await this.runRoutine(ownerId, routine.id, "schedule").catch((error: unknown) => {
          this.#o.log?.warn({ err: error, routineId: routine.id }, "routine failed");
        });
      }
    }
    return fired;
  }

  async listLogs(ownerId: string, limit = 100): Promise<HomeExecutionLogEntry[]> {
    return this.#o.store.listLogs(ownerId, Math.min(500, Math.max(1, limit)));
  }

  // ── Agent tools host ────────────────────────────────────────────────────

  toolsHost(): HomeToolsHost {
    return {
      listDevices: (userId) => this.listDevices(userId),
      listRooms: (userId) => this.listRooms(userId),
      cachedDevices: (userId) => this.cachedDevices(userId),
      executeAction: async (input) => {
        const { userId, ...rest } = input;
        const outcome = await this.executeAction({ ...rest, ownerId: userId });
        return { status: outcome.status, message: outcome.message };
      },
      listScenes: (userId) => this.listScenes(userId),
      cachedScenes: (userId) => this.#sceneCache.get(userId) ?? [],
      runScene: async (input) => {
        const { userId, ...rest } = input;
        const outcome = await this.runScene({ ...rest, ownerId: userId });
        return { status: outcome.status, message: outcome.message };
      },
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  #factory(input: { baseUrl: string; token: string }): HomeAssistantClient {
    return this.#o.clientFactory?.(input) ?? new HomeAssistantClient(input);
  }

  #secretName(ownerId: string): string {
    return `home-assistant-${createHash("sha256").update(ownerId).digest("hex").slice(0, 16)}`;
  }

  async #storeToken(ownerId: string, token: string): Promise<string> {
    if (this.#o.vault !== undefined) {
      const name = this.#secretName(ownerId);
      await this.#o.vault.set(name, token);
      return `vault://nexus/${name}`;
    }
    this.#memoryTokens.set(ownerId, token);
    return "memory://home-assistant";
  }

  async #readToken(link: HomeAssistantLinkRecord): Promise<string | undefined> {
    if (link.tokenRef === null) return undefined;
    if (link.tokenRef.startsWith("vault://")) {
      return this.#o.vault === undefined
        ? undefined
        : this.#o.vault.get(link.tokenRef).catch(() => undefined);
    }
    return this.#memoryTokens.get(link.ownerId);
  }

  async #connect(link: HomeAssistantLinkRecord): Promise<void> {
    const runtime: Runtime = {
      link,
      client: undefined,
      bridge: undefined,
      cache: new HomeAssistantStateCache(),
      tokenMissing: false,
      timeZone: null,
      dispose: [],
    };
    this.#runtimes.set(link.ownerId, runtime);
    const token = await this.#readToken(link);
    if (token === undefined) {
      runtime.tokenMissing = true;
      return;
    }
    const client = this.#factory({ baseUrl: link.baseUrl, token });
    runtime.client = client;
    runtime.bridge = new HomeAssistantBridge(client);
    runtime.dispose.push(
      client.onReady(() => {
        void this.#sync(link.ownerId).catch((error: unknown) => {
          this.#o.log?.warn({ err: error }, "Home Assistant sync failed");
        });
      }),
      client.onStateChanged((event) => {
        void this.#onStateChanged(link.ownerId, event).catch((error: unknown) => {
          this.#o.log?.warn({ err: error }, "Home Assistant event handling failed");
        });
      }),
      client.onStatus((status) => {
        if (status.state === "auth_failed" || status.state === "unreachable") {
          this.#o.log?.warn(
            {
              ownerId: link.ownerId,
              state: status.state,
              attempt: status.attempt,
              error: status.lastError,
            },
            "Home Assistant connection problem",
          );
        }
      }),
    );
    client.connect().catch(() => {
      // Status carries the reason; reconnection continues unless auth failed.
    });
  }

  #teardown(ownerId: string): void {
    const runtime = this.#runtimes.get(ownerId);
    if (runtime === undefined) return;
    for (const dispose of runtime.dispose) dispose();
    runtime.client?.close();
    runtime.cache.clear();
    this.#runtimes.delete(ownerId);
  }

  async #sync(ownerId: string): Promise<void> {
    const runtime = this.#runtimes.get(ownerId);
    if (runtime?.client === undefined) throw new Error("Home Assistant is not connected.");
    const snapshot = await runtime.client.fetchSnapshot();
    runtime.cache.replace(snapshot, this.#now());
    runtime.timeZone =
      (await runtime.client.checkConnection().catch(() => null))?.timeZone ?? runtime.timeZone;
    const rooms = await this.#o.store.listRooms(ownerId);
    let order = rooms.reduce((max, r) => Math.max(max, r.sortOrder + 1), 0);
    for (const area of missingRoomsForAreas(snapshot.areas, rooms)) {
      await this.#o.store.saveRoom(ownerId, {
        id: uuidv7(),
        name: area.name,
        haAreaId: area.area_id,
        sortOrder: order++,
      });
    }
    await this.listDevices(ownerId);
  }

  async #onStateChanged(ownerId: string, event: HaStateChangedEvent): Promise<void> {
    const runtime = this.#runtimes.get(ownerId);
    if (runtime === undefined) return;
    const previous = runtime.cache.state(event.entityId)?.state ?? event.oldState?.state ?? null;
    runtime.cache.apply(event.entityId, event.newState);
    if (!(CONTROLLABLE_DOMAINS as readonly string[]).includes(domainOf(event.entityId))) return;
    const next = event.newState?.state ?? null;
    if (previous === next) return;
    const routines = stateTriggeredRoutines(await this.#o.store.listRoutines(ownerId), {
      deviceId: `ha:${event.entityId}`,
      from: previous,
      to: next,
    });
    for (const routine of routines) {
      await this.runRoutine(ownerId, routine.id, "device_state");
    }
  }

  async #satelliteViews(ownerId: string): Promise<SatelliteSourceView[]> {
    const directory = this.#satellites;
    if (directory === undefined) return [];
    const enrolled = new Map(
      ((await this.#enrolled?.owned(ownerId)) ?? []).map((e) => [e.deviceId, e]),
    );
    const views: SatelliteSourceView[] = directory
      .list()
      .filter((s) => directory.isOwnedBy(s.deviceId, ownerId))
      .map((s) => {
        const voice = this.#voice?.status(s.deviceId);
        return {
          deviceId: s.deviceId,
          // The name chosen at approval wins over the firmware's default.
          name: enrolled.get(s.deviceId)?.name ?? s.name,
          // A live voice socket proves presence as well as a heartbeat does.
          online: s.online || voice?.connected === true,
          lastSeenAt: s.lastSeenAt,
          health: s.health,
          capabilities: s.capabilities
            .map((c) => ({ name: typeof c.name === "string" ? c.name : "" }))
            .filter((c) => c.name !== ""),
          voice,
        };
      });
    const known = new Set(views.map((v) => v.deviceId));
    for (const deviceId of this.#voice?.connectedIds() ?? []) {
      if (known.has(deviceId) || !directory.isOwnedBy(deviceId, ownerId)) continue;
      const voice = this.#voice?.status(deviceId);
      views.push({
        deviceId,
        name: enrolled.get(deviceId)?.name ?? deviceId,
        online: true,
        lastSeenAt: null,
        health: {},
        capabilities: [
          { name: "audio.microphone" },
          ...(enrolled.get(deviceId)?.capabilities ?? []),
        ],
        voice,
      });
      known.add(deviceId);
    }
    // Enrolled but silent: listed as offline rather than hidden.
    for (const satellite of enrolled.values()) {
      if (known.has(satellite.deviceId)) continue;
      views.push({
        deviceId: satellite.deviceId,
        name: satellite.name,
        online: false,
        lastSeenAt: null,
        health: {},
        capabilities: satellite.capabilities,
        voice: undefined,
      });
    }
    return views;
  }

  async #tvViews(ownerId: string): Promise<FireTvSourceView[]> {
    if (this.#adb === undefined) return [];
    return (await this.listTvs(ownerId)).map((tv) => ({
      serial: tv.serial,
      name: tv.name,
      reachable: this.#adbReachable.get(tv.serial) ?? null,
    }));
  }

  async #workerViews(ownerId: string): Promise<WorkerSourceView[]> {
    if (this.#workers === undefined) return [];
    const devices = await this.#workers.listDevices(ownerId);
    return devices.map((d) => {
      const health = (typeof d.health === "object" && d.health !== null ? d.health : {}) as Record<
        string,
        unknown
      >;
      return {
        id: d.id,
        name: d.name,
        type: d.type,
        online: d.status === "ONLINE",
        lastSeenAt: d.lastSeenAt === null ? null : d.lastSeenAt.toISOString(),
        room: typeof health.room === "string" ? health.room : null,
      };
    });
  }

  async #log(
    ownerId: string,
    kind: HomeExecutionLogEntry["kind"],
    refId: string | null,
    name: string,
    status: HomeExecutionStatus,
    origin: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.#o.store.appendLog({
        id: uuidv7(),
        ownerId,
        kind,
        refId,
        name,
        status,
        origin,
        detail,
        createdAt: this.#now().toISOString(),
      });
    } catch (error) {
      this.#o.log?.warn({ err: error }, "home execution log write failed");
    }
  }
}

function dedupeProbes(probes: HomeAssistantProbe[]): HomeAssistantProbe[] {
  // Prefer LAN-reachable names over loopback so other devices can use them too.
  const score = (url: string) =>
    /127\.0\.0\.1|localhost/.test(url) ? 2 : /\.local\b/.test(url) ? 0 : 1;
  return [...probes].sort((a, b) => score(a.url) - score(b.url));
}

function aggregate(results: readonly HomeActionOutcome[]): HomeExecutionStatus {
  if (results.length === 0) return "skipped";
  if (results.every((r) => r.status === "succeeded")) return "succeeded";
  if (results.every((r) => r.status === "failed")) return "failed";
  if (
    results.some((r) => r.status === "pending_confirmation") &&
    results.every((r) => r.status !== "failed")
  ) {
    return "pending_confirmation";
  }
  return "partial";
}

function fireTvKeyFor(device: HomeDevice, action: HomeAction): FireTvAction {
  const allowed = (key: string): key is FireTvAction => Object.hasOwn(ACTION_KEYS, key);
  switch (action.action) {
    case "remote":
      if (allowed(action.key)) return action.key;
      throw new HomeActionNotSupportedError(device.name, "remote", `unknown key ${action.key}`);
    case "turn_on":
      return "wake";
    case "turn_off":
      return "sleep";
    case "media":
      if (
        action.command === "play" ||
        action.command === "pause" ||
        action.command === "play_pause"
      ) {
        return "play_pause";
      }
      if (action.command === "volume_up" || action.command === "volume_down") return action.command;
      if (action.command === "mute" || action.command === "unmute") return "mute";
      break;
    default:
      break;
  }
  throw new HomeActionNotSupportedError(
    device.name,
    action.action,
    "not available on the Fire TV remote",
  );
}
