import type { SecureStorage } from "@nexus/client-core";
import { VolatileStorage, type DesktopShell, type ShellKind } from "./shell.js";

/**
 * Shell implementations and detection.
 *
 * In production: native Tauri window with Windows Credential Manager and native notifications.
 * In development: standard browser fallback with explicit volatile storage.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tauri
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bridge to native Rust shell.
 */
interface TauriBridge {
  invoke(command: TauriCommand, args?: Record<string, unknown>): Promise<unknown>;
}

type TauriCommand =
  | "secret_get"
  | "secret_set"
  | "secret_remove"
  | "notify"
  | "local_worker_device_id"
  | "machine_name"
  | "open_external";

/**
 * Native bridge exposed via window.__TAURI__.
 */
function tauriBridge(): TauriBridge | undefined {
  const scope = globalThis as unknown as { __TAURI__?: { core?: TauriBridge } };
  return scope.__TAURI__?.core;
}

/** Vault backed by Windows Credential Manager via native Tauri command. */
class KeyringStorage implements SecureStorage {
  readonly #bridge: TauriBridge;

  constructor(bridge: TauriBridge) {
    this.#bridge = bridge;
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.#bridge.invoke("secret_get", { key });
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await this.#bridge.invoke("secret_set", { key, value });
  }

  async remove(key: string): Promise<void> {
    await this.#bridge.invoke("secret_remove", { key });
  }
}

class TauriShell implements DesktopShell {
  readonly kind: ShellKind = "tauri";
  readonly storage: SecureStorage;
  readonly #bridge: TauriBridge;

  constructor(bridge: TauriBridge) {
    this.#bridge = bridge;
    this.storage = new KeyringStorage(bridge);
  }

  async notify(input: {
    title: string;
    body: string;
    severity: "info" | "warning" | "error";
  }): Promise<void> {
    await this.#bridge.invoke("notify", input);
  }

  async localWorkerDeviceId(): Promise<string | null> {
    const value = await this.#bridge.invoke("local_worker_device_id");
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  async machineName(): Promise<string> {
    const value = await this.#bridge.invoke("machine_name");
    return typeof value === "string" && value.length > 0 ? value : "Windows PC";
  }

  async openExternal(url: string): Promise<void> {
    await this.#bridge.invoke("open_external", { url });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Browser fallback shell for development.
 */
class WebShell implements DesktopShell {
  readonly kind: ShellKind = "web";
  readonly storage: SecureStorage = new VolatileStorage();

  async notify(input: { title: string; body: string }): Promise<void> {
    if (!("Notification" in globalThis)) return;
    if (Notification.permission === "denied") return;

    if (Notification.permission === "default") {
      const granted = await Notification.requestPermission();
      if (granted !== "granted") return;
    }

    new Notification(input.title, { body: input.body });
  }

  localWorkerDeviceId(): Promise<string | null> {
    return Promise.resolve(null);
  }

  machineName(): Promise<string> {
    return Promise.resolve("Windows PC");
  }

  openExternal(url: string): Promise<void> {
    globalThis.open(url, "_blank", "noopener,noreferrer");
    return Promise.resolve();
  }
}

/** Detects and instantiates the available desktop shell. */
export function detectShell(): DesktopShell {
  const bridge = tauriBridge();
  return bridge === undefined ? new WebShell() : new TauriShell(bridge);
}
