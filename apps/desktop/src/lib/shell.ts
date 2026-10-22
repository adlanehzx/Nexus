import type { SecureStorage } from "@nexus/client-core";

/**
 * Desktop shell contract.
 *
 * Defines the boundary between the renderer and the host OS.
 * The desktop client does not execute tasks locally; it requests capabilities
 * through the core like any client device.
 */
export interface DesktopShell {
  /** Shell kind in effect. */
  readonly kind: ShellKind;

  /**
   * Secure local vault.
   *
   * Backed by Windows Credential Manager under Tauri, or volatile in-memory storage in browser.
   */
  readonly storage: SecureStorage;

  /** System notification. */
  notify(input: {
    title: string;
    body: string;
    severity: "info" | "warning" | "error";
  }): Promise<void>;

  /**
   * Device ID of worker installed on this machine, if any.
   */
  localWorkerDeviceId(): Promise<string | null>;

  /** Machine name proposed during pairing. */
  machineName(): Promise<string>;

  /** Opens a URL in the default browser. */
  openExternal(url: string): Promise<void>;
}

export type ShellKind = "tauri" | "web";

/**
 * Volatile memory-only storage used when running outside native Tauri.
 */
export class VolatileStorage implements SecureStorage {
  readonly #values = new Map<string, string>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.#values.get(key));
  }

  set(key: string, value: string): Promise<void> {
    this.#values.set(key, value);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.#values.delete(key);
    return Promise.resolve();
  }
}
