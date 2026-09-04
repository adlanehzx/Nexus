import type { DeviceCapability, DeviceType } from "./types.js";

/**
 * Catalogue des capacités.
 *
 * Il **documente** ce qui existe et alimente l'interface de réglages ; il ne
 * **restreint** pas ce qu'un worker peut déclarer. Un worker enregistre les
 * capacités qu'il possède réellement, y compris des capacités que le cœur ne
 * connaît pas — c'est ce qui rend le système extensible sans redéploiement.
 *
 * La conséquence à retenir : `getDevicesByCapability("truc.machin")` fonctionne
 * pour une capacité absente de ce fichier. Le catalogue est une aide, pas une
 * porte.
 */

export const CAPABILITIES = {
  // Poste de travail — Windows, macOS, Linux
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

  // Client — capacités de restitution, pas d'exécution
  notificationPush: "notification.push",
  voicePlayback: "voice.playback",
} as const;

export type KnownCapability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/**
 * Capacités **suggérées** à l'appairage, par type d'appareil.
 *
 * Aucune n'est accordée d'office : un worker déclare ce qu'il sait faire, et
 * l'utilisateur autorise ce qu'il veut. Ces listes ne servent qu'à pré-remplir
 * l'écran d'appairage — supposer qu'un poste Windows sait tout faire serait
 * exactement l'hypothèse que ce système refuse.
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
 * Permission requise pour exercer une capacité.
 *
 * Identité par défaut : la capacité `terminal.execute` exige la permission
 * `terminal.execute`. Ce n'est pas une simplification paresseuse — c'est ce qui
 * permet à `PermissionService` de travailler sans traduction, et à
 * l'utilisateur de lire dans ses réglages exactement ce qu'il autorise.
 */
export function permissionForCapability(capability: string): string {
  return capability;
}

/** L'appareil déclare-t-il cette capacité, et est-elle active ? */
export function hasCapability(
  capabilities: readonly DeviceCapability[],
  required: string,
): boolean {
  return capabilities.some((c) => c.enabled && c.name === required);
}

/** Capacités requises absentes de l'appareil. */
export function missingCapabilities(
  capabilities: readonly DeviceCapability[],
  required: readonly string[],
): string[] {
  return required.filter((name) => !hasCapability(capabilities, name));
}

/**
 * Fusionne une déclaration de capacités.
 *
 * Le worker fait autorité : les capacités absentes de la nouvelle déclaration
 * disparaissent. Un worker qui perd Docker doit cesser d'être choisi pour des
 * tâches Docker, pas conserver une capacité fantôme.
 */
export function mergeCapabilities(declared: readonly DeviceCapability[]): DeviceCapability[] {
  const byName = new Map<string, DeviceCapability>();
  for (const capability of declared) byName.set(capability.name, capability);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
