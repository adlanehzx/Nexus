import * as SecureStore from "expo-secure-store";
import * as Speech from "expo-speech";
import type {
  HttpClient,
  HttpResponse,
  NetworkMonitor,
  SecureStorage,
  SocketState,
  SocketTransport,
  SpeechToTextProvider,
  TextToSpeechProvider,
  TranscriptionResult,
} from "@nexus/client-core";

/**
 * Five ports of `@nexus/client-core`, implemented for iOS.
 *
 * This file contains **no domain logic**: session lifecycle, reconnection,
 * state machines, and voice pipelines live in client core, which is fully unit tested.
 * Here we only bridge platform-specific APIs.
 *
 * This matches the architecture of the Windows and Android worker ports.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Keychain
// ─────────────────────────────────────────────────────────────────────────────

/**
 * iOS Keychain storage.
 *
 * `expo-secure-store` backs onto Keychain: encrypted by iOS, hardware-bound,
 * isolated from other applications.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` is deliberate. "This device only" excludes the
 * key from iCloud backups: a NEXUS token must not migrate to another device via restore.
 * "When unlocked" prevents reads while the screen is locked.
 *
 * **Never use `AsyncStorage`** for credentials: it stores plaintext in sandbox storage
 * which unencrypted backups export as-is.
 */
export class KeychainStorage implements SecureStorage {
  readonly #options: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };

  async get(key: string): Promise<string | undefined> {
    const value = await SecureStore.getItemAsync(key, this.#options);
    return value ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(key, value, this.#options);
  }

  async remove(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(key, this.#options);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Network
// ─────────────────────────────────────────────────────────────────────────────

export class FetchHttpClient implements HttpClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request(input: Parameters<HttpClient["request"]>[0]): Promise<HttpResponse> {
    const response = await fetch(`${this.#baseUrl}${input.path}`, {
      method: input.method,
      headers: {
        "content-type": "application/json",
        ...input.headers,
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    // Responses without JSON body (204 or infrastructure errors) must not fail
    // caller on parse exceptions.
    const body: unknown = await response.json().catch(() => null);

    return { status: response.status, body };
  }
}

/**
 * Native WebSocket transport.
 *
 * React Native provides `WebSocket`. The auth token is sent in the initial frame,
 * not in the URL, to prevent leaking credentials in proxy logs or connection histories.
 */
export class NativeSocket implements SocketTransport {
  #socket: WebSocket | undefined;
  #state: SocketState = "idle";
  #onMessage: ((data: string) => void) | undefined;
  #onClose: ((reason: string, code?: number) => void) | undefined;

  get state(): SocketState {
    return this.#state;
  }

  connect(url: string): Promise<void> {
    this.#state = "connecting";

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.#socket = socket;

      socket.onopen = () => {
        this.#state = "open";
        resolve();
      };

      socket.onerror = () => {
        // `onerror` then `onclose`: reject here and let `onclose` notify close without duplicate reporting.
        if (this.#state === "connecting") reject(new Error("connection failed"));
      };

      socket.onmessage = (event: { data: unknown }) => {
        if (typeof event.data === "string") this.#onMessage?.(event.data);
      };

      // The close code accompanies the reason: it informs client-core whether
      // the session was rejected or the connection dropped unexpectedly.
      socket.onclose = (event: { reason?: string; code?: number }) => {
        this.#state = "closed";
        this.#onClose?.(event.reason ?? "socket closed", event.code);
      };
    });
  }

  send(data: string): void {
    this.#socket?.send(data);
  }

  close(reason: string): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#socket?.close(1000, reason);
  }

  onMessage(handler: (data: string) => void): void {
    this.#onMessage = handler;
  }

  onClose(handler: (reason: string, code?: number) => void): void {
    this.#onClose = handler;
  }
}

/**
 * Network monitor.
 *
 * Intentionally minimal without `@react-native-community/netinfo`.
 * An extra native dependency for connectivity status already observed via
 * connection attempts is unnecessary overhead.
 */
export class OptimisticNetworkMonitor implements NetworkMonitor {
  #online = true;
  #handler: ((online: boolean) => void) | undefined;

  isOnline(): boolean {
    return this.#online;
  }

  onChange(handler: (online: boolean) => void): void {
    this.#handler = handler;
  }

  /** Called by network layer when connection succeeds or fails. */
  report(online: boolean): void {
    if (this.#online === online) return;
    this.#online = online;
    this.#handler?.(online);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Voice
// ─────────────────────────────────────────────────────────────────────────────

/**
 * iOS Text-to-Speech via `expo-speech`.
 *
 * `stop()` is called before each utterance to prevent overlapping audio.
 */
export class ExpoTextToSpeech implements TextToSpeechProvider {
  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async speak(text: string, options?: { locale?: string; rate?: number }): Promise<void> {
    await Speech.stop();

    return new Promise<void>((resolve, reject) => {
      Speech.speak(text, {
        language: options?.locale ?? "en-US",
        rate: options?.rate ?? 1,
        onDone: () => {
          resolve();
        },
        onStopped: () => {
          resolve();
        },
        onError: () => {
          reject(new Error("speech synthesis unavailable"));
        },
      });
    });
  }

  async stop(): Promise<void> {
    await Speech.stop();
  }

  isSpeaking(): Promise<boolean> {
    return Speech.isSpeakingAsync();
  }
}

/**
 * Speech recognition stub.
 *
 * **Not implemented.** `expo-speech` synthesizes text but does not transcribe.
 * Speech recognition on iOS requires `SFSpeechRecognizer` via a native module.
 *
 * This placeholder transparently reports unavailability rather than failing
 * silently: `isAvailable()` returns `false`, the pipeline raises `MicrophoneUnavailableError`,
 * and the UI disables the microphone button with explanatory feedback.
 */
export class UnavailableSpeechToText implements SpeechToTextProvider {
  isAvailable(): Promise<boolean> {
    return Promise.resolve(false);
  }

  requestPermission(): Promise<boolean> {
    return Promise.resolve(false);
  }

  start(): Promise<void> {
    return Promise.reject(new Error("speech recognition unavailable"));
  }

  stop(): Promise<TranscriptionResult> {
    return Promise.resolve({ text: "" });
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}
