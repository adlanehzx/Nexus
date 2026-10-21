import type { DeviceCapability, DeviceType } from "./types.js";

/**
 * Capability catalog.
 *
 * Documents standard capability namespaces and seeds configuration UI;
 * it does not restrict what workers may dynamically declare. Workers register
 * whatever capabilities they possess, including capabilities unknown to the Core.
 */

export const CAPABILITIES = {
  // Workstation — Windows, macOS, Linux
  terminalExecute: "terminal.execute",
  filesystemRead: "filesystem.read",
  filesystemWrite: "filesystem.write",
  processStart: "process.start",
  processStop: "process.stop",
  processList: "process.list",
  dockerExecute: "docker.execute",
  gitExecute: "git.execute",
  browserOpen: "browser.open",
  browserNavigate: "browser.navigate",
  browserInteract: "browser.interact",

  // Android
  androidAppOpen: "android.app.open",
  androidUiClick: "android.ui.click",
  androidUiInput: "android.ui.input",
  androidUiScroll: "android.ui.scroll",
  androidUiScreenshot: "android.ui.screenshot",
  androidNotification: "android.notification",

  // Client display/audio capabilities
  notificationPush: "notification.push",
  voicePlayback: "voice.playback",
} as const;

export type KnownCapability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/**
 * Suggested capabilities presented during pairing by device type.
 */
export const SUGGESTED_CAPABILITIES: Record<DeviceType, readonly string[]> = {
  WINDOWS_PC: [
    CAPABILITIES.terminalExecute,
    CAPABILITIES.filesystemRead,
    CAPABILITIES.filesystemWrite,
    CAPABILITIES.processStart,
    CAPABILITIES.processStop,
    CAPABILITIES.processList,
    CAPABILITIES.dockerExecute,
    CAPABILITIES.gitExecute,
    CAPABILITIES.browserOpen,
  ],
  MAC: [
    CAPABILITIES.terminalExecute,
    CAPABILITIES.filesystemRead,
    CAPABILITIES.filesystemWrite,
    CAPABILITIES.gitExecute,
  ],
  LINUX: [
    CAPABILITIES.terminalExecute,
    CAPABILITIES.filesystemRead,
    CAPABILITIES.filesystemWrite,
    CAPABILITIES.dockerExecute,
    CAPABILITIES.gitExecute,
  ],
  ANDROID: [
    CAPABILITIES.androidAppOpen,
    CAPABILITIES.androidUiClick,
    CAPABILITIES.androidUiInput,
    CAPABILITIES.androidUiScroll,
    CAPABILITIES.androidUiScreenshot,
    CAPABILITIES.androidNotification,
  ],
  IPHONE: [CAPABILITIES.notificationPush, CAPABILITIES.voicePlayback],
  BROWSER_WORKER: [
    CAPABILITIES.browserNavigate,
    CAPABILITIES.browserInteract,
    CAPABILITIES.browserOpen,
  ],
};

/**
 * Resolves required permission corresponding to a capability.
 *
 * Identity by default: capability `terminal.execute` requires permission `terminal.execute`.
 */
export function permissionForCapability(capability: string): string {
  return capability;
}

/** Checks whether device advertises and enables the required capability. */
export function hasCapability(
  capabilities: readonly DeviceCapability[],
  required: string,
): boolean {
  return capabilities.some((c) => c.enabled && c.name === required);
}

/** Returns list of required capabilities not advertised or enabled by device. */
export function missingCapabilities(
  capabilities: readonly DeviceCapability[],
  required: readonly string[],
): string[] {
  return required.filter((name) => !hasCapability(capabilities, name));
}

/**
 * Merges declared capabilities.
 *
 * Worker advertisement is authoritative: unadvertised capabilities are dropped.
 */
export function mergeCapabilities(declared: readonly DeviceCapability[]): DeviceCapability[] {
  const byName = new Map<string, DeviceCapability>();
  for (const capability of declared) byName.set(capability.name, capability);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
