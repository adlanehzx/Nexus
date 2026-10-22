/**
 * Ports to Android system.
 *
 * Everything the worker can do on the phone goes through these four interfaces,
 * implemented in Kotlin.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Applications
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Installed application visible to the worker.
 */
export interface AndroidApp {
  packageName: string;
  label: string;
  /** True if system provides a launcher activity for this package. */
  launchable: boolean;
}

export interface AndroidAppController {
  /** Launchable applications visible to the worker. */
  listApps(): Promise<AndroidApp[]>;
  /**
   * Requests opening an application.
   */
  openApp(packageName: string): Promise<{ launched: boolean; reason?: string }>;
  /** Is package installed and visible? */
  isInstalled(packageName: string): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Graphical Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * UI element designation.
 */
export type UiSelector =
  | { kind: "viewId"; value: string }
  | { kind: "text"; value: string }
  | { kind: "contentDescription"; value: string }
  | { kind: "coordinates"; x: number; y: number };

export interface UiNode {
  viewId: string | null;
  text: string | null;
  contentDescription: string | null;
  className: string | null;
  clickable: boolean;
  editable: boolean;
  scrollable: boolean;
  bounds: { left: number; top: number; right: number; bottom: number };
}

export type ScrollDirection = "up" | "down" | "left" | "right";

/**
 * UI automation.
 *
 * Relies entirely on an accessibility service.
 */
export interface AndroidUiController {
  /** Is accessibility service currently enabled by user? */
  isAccessibilityEnabled(): Promise<boolean>;
  /**
   * Resolves a selector to a UI node.
   *
   * `undefined` if nothing matches.
   */
  findNode(selector: UiSelector): Promise<UiNode | undefined>;
  click(selector: UiSelector, signal: AbortSignal): Promise<{ clicked: boolean }>;
  /**
   * Inputs text into a field.
   */
  inputText(
    selector: UiSelector,
    text: string,
    signal: AbortSignal,
  ): Promise<{ entered: boolean; characters: number }>;
  scroll(
    direction: ScrollDirection,
    amount: number,
    signal: AbortSignal,
  ): Promise<{ scrolled: boolean }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Screenshots
// ─────────────────────────────────────────────────────────────────────────────

export interface Screenshot {
  /** Base64-encoded image. Never written to disk, never logged. */
  base64: string;
  format: "png" | "jpeg";
  width: number;
  height: number;
  bytes: number;
}

/**
 * Screenshot provider.
 */
export interface AndroidScreenshotProvider {
  isAvailable(): Promise<boolean>;
  /**
   * Captures screen once.
   */
  capture(maxDimension: number, signal: AbortSignal): Promise<Screenshot>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Emitting notifications only.
 */
export interface AndroidNotificationController {
  canPostNotifications(): Promise<boolean>;
  notify(input: {
    title: string;
    body: string;
    channelId: string;
  }): Promise<{ posted: boolean; notificationId: number }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Device State
// ─────────────────────────────────────────────────────────────────────────────

export interface AndroidBatteryState {
  /** Level from 0 to 100. */
  percent: number;
  charging: boolean;
  /** System is in power save mode. */
  powerSaveMode: boolean;
}

export interface AndroidDeviceInspector {
  batteryState(): Promise<AndroidBatteryState>;
  /** System SDK API level. */
  sdkVersion(): Promise<number>;
}

/** All ports as received during assembly. */
export interface AndroidPlatform {
  apps: AndroidAppController;
  ui: AndroidUiController;
  screenshots: AndroidScreenshotProvider;
  notifications: AndroidNotificationController;
  device: AndroidDeviceInspector;
}
