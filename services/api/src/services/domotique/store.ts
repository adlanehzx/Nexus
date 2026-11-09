import type { PrismaClient } from "@nexus/database";
import {
  routineActionSchema,
  routineConditionSchema,
  routineTriggerSchema,
  sceneActionSchema,
  type HomeDeviceSetting,
  type HomeExecutionLogEntry,
  type HomeRoom,
  type HomeRoutine,
  type HomeScene,
} from "@nexus/devices";
import { uuidv7 } from "@nexus/shared";
import { z } from "zod";

/**
 * Domotique persistence. Everything is owner-scoped: a NEXUS user configures
 * their Home Assistant and owns their rooms, scenes and routines.
 */

export interface HomeAssistantLinkRecord {
  readonly ownerId: string;
  readonly baseUrl: string;
  /** `vault://nexus/<name>`, or `memory://` when no vault is configured. Never the token. */
  readonly tokenRef: string | null;
  readonly enabled: boolean;
  readonly sensitiveClasses: readonly string[];
  readonly updatedAt: string;
}

/** An Android / Fire TV reached over ADB (`host:port`). */
export interface AdbDeviceRecord {
  readonly serial: string;
  readonly name: string;
}

export interface DomotiqueStore {
  listLinks(): Promise<HomeAssistantLinkRecord[]>;
  getLink(ownerId: string): Promise<HomeAssistantLinkRecord | undefined>;
  saveLink(record: HomeAssistantLinkRecord): Promise<void>;
  deleteLink(ownerId: string): Promise<void>;

  listRooms(ownerId: string): Promise<HomeRoom[]>;
  saveRoom(ownerId: string, room: HomeRoom): Promise<void>;
  deleteRoom(ownerId: string, roomId: string): Promise<void>;

  listSettings(ownerId: string): Promise<HomeDeviceSetting[]>;
  saveSetting(ownerId: string, setting: HomeDeviceSetting): Promise<void>;

  listScenes(ownerId: string): Promise<HomeScene[]>;
  saveScene(scene: HomeScene): Promise<void>;
  deleteScene(ownerId: string, sceneId: string): Promise<void>;

  listRoutines(ownerId: string): Promise<HomeRoutine[]>;
  listAllRoutines(): Promise<HomeRoutine[]>;
  saveRoutine(routine: HomeRoutine): Promise<void>;
  deleteRoutine(ownerId: string, routineId: string): Promise<void>;

  listAdbDevices(ownerId: string): Promise<AdbDeviceRecord[]>;
  saveAdbDevice(ownerId: string, device: AdbDeviceRecord): Promise<void>;
  deleteAdbDevice(ownerId: string, serial: string): Promise<void>;

  appendLog(entry: HomeExecutionLogEntry): Promise<void>;
  listLogs(ownerId: string, limit: number): Promise<HomeExecutionLogEntry[]>;
}

const byOrder = (a: HomeRoom, b: HomeRoom) =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

export class InMemoryDomotiqueStore implements DomotiqueStore {
  readonly #links = new Map<string, HomeAssistantLinkRecord>();
  readonly #rooms = new Map<string, Map<string, HomeRoom>>();
  readonly #settings = new Map<string, Map<string, HomeDeviceSetting>>();
  readonly #scenes = new Map<string, HomeScene>();
  readonly #routines = new Map<string, HomeRoutine>();
  readonly #logs: HomeExecutionLogEntry[] = [];
  readonly #adb = new Map<string, Map<string, AdbDeviceRecord>>();

  listAdbDevices(ownerId: string) {
    return Promise.resolve([...(this.#adb.get(ownerId)?.values() ?? [])]);
  }
  saveAdbDevice(ownerId: string, device: AdbDeviceRecord) {
    const devices = this.#adb.get(ownerId) ?? new Map<string, AdbDeviceRecord>();
    devices.set(device.serial, device);
    this.#adb.set(ownerId, devices);
    return Promise.resolve();
  }
  deleteAdbDevice(ownerId: string, serial: string) {
    this.#adb.get(ownerId)?.delete(serial);
    return Promise.resolve();
  }

  listLinks() {
    return Promise.resolve([...this.#links.values()]);
  }
  getLink(ownerId: string) {
    return Promise.resolve(this.#links.get(ownerId));
  }
  saveLink(record: HomeAssistantLinkRecord) {
    this.#links.set(record.ownerId, record);
    return Promise.resolve();
  }
  deleteLink(ownerId: string) {
    this.#links.delete(ownerId);
    return Promise.resolve();
  }
  listRooms(ownerId: string) {
    return Promise.resolve([...(this.#rooms.get(ownerId)?.values() ?? [])].sort(byOrder));
  }
  saveRoom(ownerId: string, room: HomeRoom) {
    const rooms = this.#rooms.get(ownerId) ?? new Map<string, HomeRoom>();
    rooms.set(room.id, room);
    this.#rooms.set(ownerId, rooms);
    return Promise.resolve();
  }
  deleteRoom(ownerId: string, roomId: string) {
    this.#rooms.get(ownerId)?.delete(roomId);
    return Promise.resolve();
  }
  listSettings(ownerId: string) {
    return Promise.resolve([...(this.#settings.get(ownerId)?.values() ?? [])]);
  }
  saveSetting(ownerId: string, setting: HomeDeviceSetting) {
    const settings = this.#settings.get(ownerId) ?? new Map<string, HomeDeviceSetting>();
    settings.set(setting.deviceId, setting);
    this.#settings.set(ownerId, settings);
    return Promise.resolve();
  }
  listScenes(ownerId: string) {
    return Promise.resolve([...this.#scenes.values()].filter((s) => s.ownerId === ownerId));
  }
  saveScene(scene: HomeScene) {
    this.#scenes.set(scene.id, scene);
    return Promise.resolve();
  }
  deleteScene(ownerId: string, sceneId: string) {
    if (this.#scenes.get(sceneId)?.ownerId === ownerId) this.#scenes.delete(sceneId);
    return Promise.resolve();
  }
  listRoutines(ownerId: string) {
    return Promise.resolve([...this.#routines.values()].filter((r) => r.ownerId === ownerId));
  }
  listAllRoutines() {
    return Promise.resolve([...this.#routines.values()]);
  }
  saveRoutine(routine: HomeRoutine) {
    this.#routines.set(routine.id, routine);
    return Promise.resolve();
  }
  deleteRoutine(ownerId: string, routineId: string) {
    if (this.#routines.get(routineId)?.ownerId === ownerId) this.#routines.delete(routineId);
    return Promise.resolve();
  }
  appendLog(entry: HomeExecutionLogEntry) {
    this.#logs.unshift(entry);
    if (this.#logs.length > 2_000) this.#logs.length = 2_000;
    return Promise.resolve();
  }
  listLogs(ownerId: string, limit: number) {
    return Promise.resolve(this.#logs.filter((l) => l.ownerId === ownerId).slice(0, limit));
  }
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export class PrismaDomotiqueStore implements DomotiqueStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async listLinks() {
    return (await this.#prisma.homeAssistantLink.findMany()).map((row) => this.#link(row));
  }

  async getLink(ownerId: string) {
    const row = await this.#prisma.homeAssistantLink.findUnique({ where: { ownerId } });
    return row === null ? undefined : this.#link(row);
  }

  async saveLink(record: HomeAssistantLinkRecord) {
    const data = {
      baseUrl: record.baseUrl,
      tokenRef: record.tokenRef,
      enabled: record.enabled,
      sensitiveClasses: [...record.sensitiveClasses],
    };
    await this.#prisma.homeAssistantLink.upsert({
      where: { ownerId: record.ownerId },
      create: { id: uuidv7(), ownerId: record.ownerId, ...data },
      update: data,
    });
  }

  async deleteLink(ownerId: string) {
    await this.#prisma.homeAssistantLink.deleteMany({ where: { ownerId } });
  }

  async listRooms(ownerId: string) {
    const rows = await this.#prisma.homeRoom.findMany({
      where: { ownerId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      haAreaId: r.haAreaId,
      sortOrder: r.sortOrder,
    }));
  }

  async saveRoom(ownerId: string, room: HomeRoom) {
    const data = { name: room.name, haAreaId: room.haAreaId, sortOrder: room.sortOrder };
    await this.#prisma.homeRoom.upsert({
      where: { id: room.id },
      create: { id: room.id, ownerId, ...data },
      update: data,
    });
  }

  async deleteRoom(ownerId: string, roomId: string) {
    await this.#prisma.homeRoom.deleteMany({ where: { id: roomId, ownerId } });
  }

  async listSettings(ownerId: string) {
    const rows = await this.#prisma.homeDeviceSetting.findMany({ where: { ownerId } });
    return rows.map((r) => ({
      deviceId: r.deviceId,
      roomId: r.roomId,
      sensitive: r.sensitive,
      alias: r.alias,
      hidden: r.hidden,
    }));
  }

  async saveSetting(ownerId: string, setting: HomeDeviceSetting) {
    const data = {
      roomId: setting.roomId ?? null,
      sensitive: setting.sensitive ?? null,
      alias: setting.alias ?? null,
      hidden: setting.hidden ?? false,
    };
    await this.#prisma.homeDeviceSetting.upsert({
      where: { ownerId_deviceId: { ownerId, deviceId: setting.deviceId } },
      create: { ownerId, deviceId: setting.deviceId, ...data },
      update: data,
    });
  }

  async listScenes(ownerId: string) {
    const rows = await this.#prisma.homeScene.findMany({
      where: { ownerId },
      orderBy: { name: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      ownerId: r.ownerId,
      name: r.name,
      actions: z.array(sceneActionSchema).parse(r.actions),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async saveScene(scene: HomeScene) {
    const data = { name: scene.name, actions: scene.actions as never };
    await this.#prisma.homeScene.upsert({
      where: { id: scene.id },
      create: { id: scene.id, ownerId: scene.ownerId, ...data },
      update: data,
    });
  }

  async deleteScene(ownerId: string, sceneId: string) {
    await this.#prisma.homeScene.deleteMany({ where: { id: sceneId, ownerId } });
  }

  async listRoutines(ownerId: string) {
    const rows = await this.#prisma.homeRoutine.findMany({
      where: { ownerId },
      orderBy: { name: "asc" },
    });
    return rows.map((r) => this.#routine(r));
  }

  async listAllRoutines() {
    return (await this.#prisma.homeRoutine.findMany({ where: { enabled: true } })).map((r) =>
      this.#routine(r),
    );
  }

  async saveRoutine(routine: HomeRoutine) {
    const data = {
      name: routine.name,
      enabled: routine.enabled,
      trigger: routine.trigger as never,
      conditions: routine.conditions as never,
      actions: routine.actions as never,
      lastRunAt: routine.lastRunAt === null ? null : new Date(routine.lastRunAt),
    };
    await this.#prisma.homeRoutine.upsert({
      where: { id: routine.id },
      create: { id: routine.id, ownerId: routine.ownerId, ...data },
      update: data,
    });
  }

  async deleteRoutine(ownerId: string, routineId: string) {
    await this.#prisma.homeRoutine.deleteMany({ where: { id: routineId, ownerId } });
  }

  async listAdbDevices(ownerId: string) {
    const rows = await this.#prisma.homeAdbDevice.findMany({
      where: { ownerId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => ({ serial: r.serial, name: r.name }));
  }

  async saveAdbDevice(ownerId: string, device: AdbDeviceRecord) {
    await this.#prisma.homeAdbDevice.upsert({
      where: { ownerId_serial: { ownerId, serial: device.serial } },
      create: { ownerId, serial: device.serial, name: device.name },
      update: { name: device.name },
    });
  }

  async deleteAdbDevice(ownerId: string, serial: string) {
    await this.#prisma.homeAdbDevice.deleteMany({ where: { ownerId, serial } });
  }

  async appendLog(entry: HomeExecutionLogEntry) {
    await this.#prisma.homeExecutionLog.create({
      data: {
        id: entry.id,
        ownerId: entry.ownerId,
        kind: entry.kind,
        refId: entry.refId,
        name: entry.name,
        status: entry.status,
        origin: entry.origin,
        detail: entry.detail as never,
        createdAt: new Date(entry.createdAt),
      },
    });
  }

  async listLogs(ownerId: string, limit: number) {
    const rows = await this.#prisma.homeExecutionLog.findMany({
      where: { ownerId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      ownerId: r.ownerId,
      kind: r.kind as HomeExecutionLogEntry["kind"],
      refId: r.refId,
      name: r.name,
      status: r.status as HomeExecutionLogEntry["status"],
      origin: r.origin,
      detail: (r.detail ?? {}) as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  #link(row: {
    ownerId: string;
    baseUrl: string;
    tokenRef: string | null;
    enabled: boolean;
    sensitiveClasses: string[];
    updatedAt: Date;
  }): HomeAssistantLinkRecord {
    return {
      ownerId: row.ownerId,
      baseUrl: row.baseUrl,
      tokenRef: row.tokenRef,
      enabled: row.enabled,
      sensitiveClasses: row.sensitiveClasses,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  #routine(r: {
    id: string;
    ownerId: string;
    name: string;
    enabled: boolean;
    trigger: unknown;
    conditions: unknown;
    actions: unknown;
    lastRunAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): HomeRoutine {
    return {
      id: r.id,
      ownerId: r.ownerId,
      name: r.name,
      enabled: r.enabled,
      trigger: routineTriggerSchema.parse(r.trigger),
      conditions: z.array(routineConditionSchema).parse(r.conditions),
      actions: z.array(routineActionSchema).parse(r.actions),
      lastRunAt: iso(r.lastRunAt),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
