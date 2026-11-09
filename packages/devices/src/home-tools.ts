import { z } from "zod";
import type { ToolDefinition } from "@nexus/tools";
import {
  actionIsSensitive,
  homeActionSchema,
  resolveHomeDevice,
  type HomeAction,
  type HomeDevice,
  type HomeRoom,
} from "./home.js";
import { sensitiveTargets, type HomeScene } from "./home-automation.js";

/**
 * Agent tools for the house.
 *
 * Same conventions as `createDeviceTools`: plain `ToolDefinition`s registered
 * in the `ToolRegistry`, so permissions (`homeassistant.read` /
 * `homeassistant.write`), the human-confirmation gate and the audit trail
 * apply uniformly.
 *
 * Confirmation is decided **per call**: turning on a lamp is LOW risk and
 * runs directly; the same tool aimed at a lock, an alarm panel, the heating
 * or a plug the user flagged as sensitive returns `requiresConfirmation =
 * true`, and the agent loop suspends until the user approves. Because the
 * agent loop already obtained that approval, `execute` passes
 * `confirmed: true` to the host.
 */

export interface HomeToolsHost {
  listDevices(userId: string): Promise<readonly HomeDevice[]>;
  listRooms(userId: string): Promise<readonly HomeRoom[]>;
  /** Synchronous view of the last known device list (the confirmation predicate is synchronous). */
  cachedDevices(userId: string): readonly HomeDevice[];
  executeAction(input: {
    userId: string;
    deviceId: string;
    action: HomeAction;
    origin: "agent";
    confirmed: boolean;
  }): Promise<{ status: string; message: string }>;
  listScenes(userId: string): Promise<readonly HomeScene[]>;
  cachedScenes(userId: string): readonly HomeScene[];
  runScene(input: {
    userId: string;
    sceneId: string;
    origin: "agent";
    confirmed: boolean;
  }): Promise<{ status: string; message: string }>;
}

const resultSchema = z.object({ status: z.string(), message: z.string() });

const deviceViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  room: z.string().nullable(),
  type: z.string(),
  online: z.boolean(),
  state: z.string(),
  capabilities: z.array(z.string()),
  sensitive: z.boolean(),
});

const listInput = z.object({ room: z.string().max(80).optional() });
const controlInput = z.object({
  device: z.string().min(1).max(200),
  command: homeActionSchema,
});
const sceneInput = z.object({ scene: z.string().min(1).max(120) });

type DeviceView = z.infer<typeof deviceViewSchema>;

function summarizeState(device: HomeDevice): string {
  const s = device.state;
  const parts = [s.raw];
  if (s.brightness !== undefined) parts.push(`${String(s.brightness)}%`);
  if (s.color !== undefined) parts.push(s.color);
  if (s.powerW !== undefined) parts.push(`${String(Math.round(s.powerW))} W`);
  if (s.temperature !== undefined) parts.push(`${String(s.temperature)} C`);
  return parts.join(", ");
}

/** Resolves a device query using the cached list. Exported for the voice intent path. */
export function pickDevice(
  devices: readonly HomeDevice[],
  rooms: readonly HomeRoom[],
  query: string,
): HomeDevice {
  const matches = resolveHomeDevice(devices, rooms, query);
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  if (matches.length === 0) throw new Error(`No device matches "${query}".`);
  throw new Error(
    `"${query}" is ambiguous: ${matches
      .slice(0, 6)
      .map((d) => `${d.name} (${d.id})`)
      .join(", ")}. Use the device id.`,
  );
}

function findScene(scenes: readonly HomeScene[], query: string): HomeScene | undefined {
  const q = query.trim().toLowerCase();
  return scenes.find((s) => s.id === query) ?? scenes.find((s) => s.name.toLowerCase() === q);
}

export function createHomeTools(host: HomeToolsHost): ToolDefinition<never, unknown>[] {
  const list: ToolDefinition<z.infer<typeof listInput>, { devices: DeviceView[] }> = {
    name: "home.devices_list",
    description:
      "Lists the devices of the house (lights, plugs, TV, media players, locks, heating, voice satellites) with their room, live state and capabilities. Call this before controlling a device you do not know the id of.",
    version: "1",
    inputSchema: listInput,
    outputSchema: z.object({ devices: z.array(deviceViewSchema) }),
    riskLevel: "SAFE",
    requiredPermissions: ["homeassistant.read"],
    requiresConfirmation: false,
    idempotent: true,
    timeoutMs: 10_000,
    summarize: (input) => `List home devices${input.room ? ` in ${input.room}` : ""}`,
    execute: async (input, context) => {
      const [devices, rooms] = await Promise.all([
        host.listDevices(context.userId),
        host.listRooms(context.userId),
      ]);
      const roomName = new Map(rooms.map((r) => [r.id, r.name]));
      const wanted = input.room?.trim().toLowerCase();
      return {
        devices: devices
          .filter(
            (d) =>
              wanted === undefined ||
              (d.roomId !== null && roomName.get(d.roomId)?.toLowerCase() === wanted),
          )
          .map((d) => ({
            id: d.id,
            name: d.name,
            room: d.roomId === null ? null : (roomName.get(d.roomId) ?? null),
            type: d.domain,
            online: d.online,
            state: summarizeState(d),
            capabilities: [...d.capabilities],
            sensitive: d.sensitive,
          })),
      };
    },
  };

  const control: ToolDefinition<z.infer<typeof controlInput>, z.infer<typeof resultSchema>> = {
    name: "home.device_control",
    description:
      'Controls one device of the house. `device` is a device id from home.devices_list (preferred) or a name such as "lampe salon". `command.action` is one of: turn_on (optional brightness 0-100, color "#rrggbb"), turn_off, toggle, set_brightness, set_color, media (command: play|pause|play_pause|stop|next|previous|volume_up|volume_down|volume_set|mute|unmute), remote (Fire TV key: wake|sleep|home|up|down|left|right|select|back|menu|play_pause|volume_up|volume_down|mute), lock, unlock, set_temperature, alarm_arm, alarm_disarm, open, close, stop, mic_mute, speak. Locks, alarms, heating and user-flagged devices require the user\'s confirmation.',
    version: "1",
    inputSchema: controlInput,
    outputSchema: resultSchema,
    riskLevel: "LOW",
    requiredPermissions: ["homeassistant.write"],
    requiresConfirmation: (input, context) => {
      const devices = host.cachedDevices(context.userId);
      const matches = resolveHomeDevice(devices, [], input.device);
      // Unknown or ambiguous target: ask rather than guess.
      if (matches.length !== 1 || matches[0] === undefined) return true;
      return actionIsSensitive(matches[0], input.command);
    },
    timeoutMs: 15_000,
    idempotent: false,
    summarize: (input) => `${input.command.action} on ${input.device}`,
    execute: async (input, context) => {
      const [devices, rooms] = await Promise.all([
        host.listDevices(context.userId),
        host.listRooms(context.userId),
      ]);
      const device = pickDevice(devices, rooms, input.device);
      return host.executeAction({
        userId: context.userId,
        deviceId: device.id,
        action: input.command,
        origin: "agent",
        confirmed: true,
      });
    },
  };

  const scenes: ToolDefinition<
    Record<string, never>,
    { scenes: { id: string; name: string; actions: number }[] }
  > = {
    name: "home.scenes_list",
    description: "Lists the scenes (named sets of device actions) the user defined.",
    version: "1",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      scenes: z.array(z.object({ id: z.string(), name: z.string(), actions: z.number() })),
    }),
    riskLevel: "SAFE",
    requiredPermissions: ["homeassistant.read"],
    requiresConfirmation: false,
    idempotent: true,
    timeoutMs: 10_000,
    execute: async (_input, context) => ({
      scenes: (await host.listScenes(context.userId)).map((s) => ({
        id: s.id,
        name: s.name,
        actions: s.actions.length,
      })),
    }),
  };

  const runScene: ToolDefinition<z.infer<typeof sceneInput>, z.infer<typeof resultSchema>> = {
    name: "home.scene_run",
    description:
      "Runs a scene by id or exact name. Scenes touching sensitive devices require the user's confirmation.",
    version: "1",
    inputSchema: sceneInput,
    outputSchema: resultSchema,
    riskLevel: "LOW",
    requiredPermissions: ["homeassistant.write"],
    requiresConfirmation: (input, context) => {
      const scene = findScene(host.cachedScenes(context.userId), input.scene);
      if (scene === undefined) return true;
      return sensitiveTargets(scene.actions, host.cachedDevices(context.userId)).length > 0;
    },
    timeoutMs: 60_000,
    idempotent: false,
    summarize: (input) => `Run scene ${input.scene}`,
    execute: async (input, context) => {
      const scene = findScene(await host.listScenes(context.userId), input.scene);
      if (scene === undefined) throw new Error(`No scene named "${input.scene}".`);
      return host.runScene({
        userId: context.userId,
        sceneId: scene.id,
        origin: "agent",
        confirmed: true,
      });
    },
  };

  return [list, control, scenes, runScene] as unknown as ToolDefinition<never, unknown>[];
}
