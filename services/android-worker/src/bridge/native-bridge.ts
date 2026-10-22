import type {
  AndroidApp,
  AndroidAppController,
  AndroidBatteryState,
  AndroidDeviceInspector,
  AndroidNotificationController,
  AndroidPlatform,
  AndroidScreenshotProvider,
  AndroidUiController,
  ScrollDirection,
  Screenshot,
  UiNode,
  UiSelector,
} from "../ports.js";
import type { CredentialSigner } from "@nexus/worker-core";

/**
 * Adapter to Kotlin native module.
 */

/**
 * Native module as exposed by React Native.
 */
export interface NexusNative {
  // Applications
  listApps(): Promise<AndroidApp[]>;
  openApp(packageName: string): Promise<{ launched: boolean; reason?: string }>;
  isInstalled(packageName: string): Promise<boolean>;

  // Accessibility
  isAccessibilityEnabled(): Promise<boolean>;
  findNode(selectorJson: string): Promise<UiNode | null>;
  click(selectorJson: string): Promise<{ clicked: boolean }>;
  inputText(selectorJson: string, text: string): Promise<{ entered: boolean; characters: number }>;
  scroll(direction: string, amount: number): Promise<{ scrolled: boolean }>;

  // Screenshots
  isScreenshotAvailable(): Promise<boolean>;
  takeScreenshot(maxDimension: number): Promise<Screenshot>;

  // Notifications — emit only
  canPostNotifications(): Promise<boolean>;
  postNotification(
    title: string,
    body: string,
    channelId: string,
  ): Promise<{ posted: boolean; notificationId: number }>;

  // Device
  batteryState(): Promise<AndroidBatteryState>;
  sdkVersion(): Promise<number>;

  /**
   * Signs a nonce with Android KeyStore key.
   */
  signChallenge(keyAlias: string, nonce: string): Promise<string>;

  /**
   * Public key of device, in PEM format.
   */
  devicePublicKeyPem(keyAlias: string): Promise<string>;

  /**
   * Cryptographic random bytes, base64 encoded.
   */
  secureRandomBase64(count: number): string;
}

/** Public provisioning configuration persisted after consuming ticket. */
export interface NexusProvisioningNative {
  loadProvisioning(): Promise<{ apiUrl: string; deviceId: string } | null>;
  saveProvisioning(apiUrl: string, deviceId: string): Promise<void>;
}

/**
 * Aborts a native operation.
 */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal, capability: string): Promise<T> {
  if (!signal.aborted && signal.onabort === null) {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(new AbortError(capability));
          },
          { once: true },
        );
      }),
    ]);
  }

  if (signal.aborted) return Promise.reject(new AbortError(capability));
  return promise;
}

class AbortError extends Error {
  constructor(capability: string) {
    super(`${capability} cancelled`);
    this.name = "AbortError";
  }
}

class NativeAppController implements AndroidAppController {
  readonly #native: NexusNative;

  constructor(native: NexusNative) {
    this.#native = native;
  }

  listApps(): Promise<AndroidApp[]> {
    return this.#native.listApps();
  }

  openApp(packageName: string): Promise<{ launched: boolean; reason?: string }> {
    return this.#native.openApp(packageName);
  }

  isInstalled(packageName: string): Promise<boolean> {
    return this.#native.isInstalled(packageName);
  }
}

class NativeUiController implements AndroidUiController {
  readonly #native: NexusNative;

  constructor(native: NexusNative) {
    this.#native = native;
  }

  isAccessibilityEnabled(): Promise<boolean> {
    return this.#native.isAccessibilityEnabled();
  }

  async findNode(selector: UiSelector): Promise<UiNode | undefined> {
    const node = await this.#native.findNode(JSON.stringify(selector));
    return node ?? undefined;
  }

  click(selector: UiSelector, signal: AbortSignal): Promise<{ clicked: boolean }> {
    return withAbort(this.#native.click(JSON.stringify(selector)), signal, "android.ui.click");
  }

  inputText(
    selector: UiSelector,
    text: string,
    signal: AbortSignal,
  ): Promise<{ entered: boolean; characters: number }> {
    return withAbort(
      this.#native.inputText(JSON.stringify(selector), text),
      signal,
      "android.ui.input",
    );
  }

  scroll(
    direction: ScrollDirection,
    amount: number,
    signal: AbortSignal,
  ): Promise<{ scrolled: boolean }> {
    return withAbort(this.#native.scroll(direction, amount), signal, "android.ui.scroll");
  }
}

class NativeScreenshotProvider implements AndroidScreenshotProvider {
  readonly #native: NexusNative;

  constructor(native: NexusNative) {
    this.#native = native;
  }

  isAvailable(): Promise<boolean> {
    return this.#native.isScreenshotAvailable();
  }

  capture(maxDimension: number, signal: AbortSignal): Promise<Screenshot> {
    return withAbort(this.#native.takeScreenshot(maxDimension), signal, "android.ui.screenshot");
  }
}

class NativeNotificationController implements AndroidNotificationController {
  readonly #native: NexusNative;

  constructor(native: NexusNative) {
    this.#native = native;
  }

  canPostNotifications(): Promise<boolean> {
    return this.#native.canPostNotifications();
  }

  notify(input: {
    title: string;
    body: string;
    channelId: string;
  }): Promise<{ posted: boolean; notificationId: number }> {
    return this.#native.postNotification(input.title, input.body, input.channelId);
  }
}

class NativeDeviceInspector implements AndroidDeviceInspector {
  readonly #native: NexusNative;

  constructor(native: NexusNative) {
    this.#native = native;
  }

  batteryState(): Promise<AndroidBatteryState> {
    return this.#native.batteryState();
  }

  sdkVersion(): Promise<number> {
    return this.#native.sdkVersion();
  }
}

/**
 * Signer backed by Android KeyStore.
 */
export class KeystoreCredentialSigner implements CredentialSigner {
  readonly #native: NexusNative;
  readonly #keyAlias: string;

  constructor(native: NexusNative, keyAlias: string) {
    this.#native = native;
    this.#keyAlias = keyAlias;
  }

  sign(nonce: string): Promise<string> {
    return this.#native.signChallenge(this.#keyAlias, nonce);
  }
}

/** Builds the four Android ports from the native module. */
export function createAndroidPlatform(native: NexusNative): AndroidPlatform {
  return {
    apps: new NativeAppController(native),
    ui: new NativeUiController(native),
    screenshots: new NativeScreenshotProvider(native),
    notifications: new NativeNotificationController(native),
    device: new NativeDeviceInspector(native),
  };
}
