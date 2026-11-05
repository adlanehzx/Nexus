import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import * as SecureStore from "expo-secure-store";
import * as Speech from "expo-speech";
import {
  FetchHttpClient,
  type HttpClient,
  type HttpResponse,
  type NetworkMonitor,
  type SecureStorage,
  type SocketState,
  type SocketTransport,
  type SpeechToTextProvider,
  type TextToSpeechProvider,
  type TranscriptionResult,
} from "@nexus/client-core";

/**
 * Five ports of `@nexus/client-core`, implemented for iOS and Android.
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
 * Platform secret storage.
 *
 * `expo-secure-store` backs onto the iOS Keychain and the Android Keystore:
 * encrypted by the OS, hardware-bound where available, isolated from other apps.
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

/** Default deadline of a request that did not bring its own signal. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Bounded HTTP client.
 *
 * `fetch` on a phone that just lost coverage may hang for minutes. The shared
 * client handles encoding and error shapes; this adapter adds the deadline a
 * mobile screen needs to leave its loading state. A caller with a legitimately
 * long request — an agent run — passes its own signal and is left alone.
 */
export class TimeoutHttpClient implements HttpClient {
  readonly #inner: HttpClient;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.#inner = new FetchHttpClient(baseUrl);
    this.#timeoutMs = timeoutMs;
  }

  async request(input: Parameters<HttpClient["request"]>[0]): Promise<HttpResponse> {
    if (input.signal !== undefined) return this.#inner.request(input);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    try {
      return await this.#inner.request({ ...input, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
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
        if (this.#socket !== socket) return;
        this.#state = "open";
        resolve();
      };

      socket.onerror = () => {
        // `onerror` then `onclose`: reject here and let `onclose` notify close without duplicate reporting.
        if (this.#socket === socket && this.#state === "connecting") {
          reject(new Error("connection failed"));
        }
      };

      socket.onmessage = (event: { data: unknown }) => {
        if (this.#socket === socket && typeof event.data === "string") {
          this.#onMessage?.(event.data);
        }
      };

      // The close code accompanies the reason: it informs client-core whether
      // the session was rejected or the connection dropped unexpectedly.
      //
      // A replaced socket closes late, after its successor opened. Reporting
      // that close would tear the healthy connection down.
      socket.onclose = (event: { reason?: string; code?: number }) => {
        if (this.#socket !== socket) return;
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
 * Connectivity as reported by the OS.
 *
 * `isInternetReachable` is `null` until the OS has probed: unknown must not
 * read as offline, or the app would show a false outage at every launch.
 */
export function isOnline(
  state: Pick<NetInfoState, "isConnected" | "isInternetReachable">,
): boolean {
  return state.isConnected !== false && state.isInternetReachable !== false;
}

export class NativeNetworkMonitor implements NetworkMonitor {
  #online = true;
  #handler: ((online: boolean) => void) | undefined;
  readonly #unsubscribe: () => void;

  constructor() {
    this.#unsubscribe = NetInfo.addEventListener((state) => {
      const online = isOnline(state);
      if (online === this.#online) return;
      this.#online = online;
      this.#handler?.(online);
    });
  }

  isOnline(): boolean {
    return this.#online;
  }

  onChange(handler: (online: boolean) => void): void {
    this.#handler = handler;
  }

  dispose(): void {
    this.#unsubscribe();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Voice
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Text-to-Speech through the OS engine, via `expo-speech`.
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

/** The part of `expo-speech-recognition` this port relies on. */
export interface SpeechRecognitionModule {
  isRecognitionAvailable(): boolean;
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  start(options: { lang: string; interimResults: boolean; continuous: boolean }): void;
  stop(): void;
  abort(): void;
  addListener(
    event: "result" | "end" | "error",
    listener: (event: {
      isFinal?: boolean;
      results?: { transcript: string }[];
      error?: string;
      message?: string;
    }) => void,
  ): { remove: () => void };
}

/** How long a stopped recognizer may take to deliver its final words. */
const FINAL_RESULT_TIMEOUT_MS = 3_000;

/**
 * Dictation through the recognizer built into the phone.
 *
 * Audio stays with the OS engine; nothing is recorded or stored by NEXUS. The
 * module is injected because it is absent from Expo Go: a missing native module
 * reports "unavailable" instead of crashing at import.
 */
export class NativeSpeechToText implements SpeechToTextProvider {
  readonly #load: () => SpeechRecognitionModule | undefined;
  #subscriptions: { remove: () => void }[] = [];
  #finalText = "";
  #partialText = "";
  #failure: string | undefined;
  #onEnd: (() => void) | undefined;
  #listening = false;

  constructor(load: () => SpeechRecognitionModule | undefined = loadSpeechRecognition) {
    this.#load = load;
  }

  isAvailable(): Promise<boolean> {
    try {
      return Promise.resolve(this.#load()?.isRecognitionAvailable() === true);
    } catch {
      return Promise.resolve(false);
    }
  }

  async requestPermission(): Promise<boolean> {
    const module = this.#load();
    if (module === undefined) return false;
    try {
      return (await module.requestPermissionsAsync()).granted;
    } catch {
      return false;
    }
  }

  start(options?: { locale?: string; onPartial?: (text: string) => void }): Promise<void> {
    const module = this.#load();
    if (module === undefined) return Promise.reject(new Error("speech recognition unavailable"));

    this.#release();
    this.#finalText = "";
    this.#partialText = "";
    this.#failure = undefined;
    this.#listening = true;

    this.#subscriptions = [
      module.addListener("result", (event) => {
        const transcript = event.results?.[0]?.transcript ?? "";
        if (event.isFinal === true) {
          this.#finalText = `${this.#finalText} ${transcript}`.trim();
          this.#partialText = "";
        } else {
          this.#partialText = transcript;
        }
        options?.onPartial?.(`${this.#finalText} ${this.#partialText}`.trim());
      }),
      module.addListener("error", (event) => {
        // "no-speech" and "aborted" are normal endings of a press, not faults.
        if (event.error !== "no-speech" && event.error !== "aborted") {
          this.#failure = event.message ?? event.error ?? "speech recognition failed";
        }
        this.#finish();
      }),
      module.addListener("end", () => {
        this.#finish();
      }),
    ];

    module.start({
      lang: options?.locale ?? "en-US",
      interimResults: true,
      continuous: true,
    });
    return Promise.resolve();
  }

  async stop(): Promise<TranscriptionResult> {
    const module = this.#load();
    if (this.#listening && module !== undefined) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FINAL_RESULT_TIMEOUT_MS);
        this.#onEnd = () => {
          clearTimeout(timer);
          resolve();
        };
        module.stop();
      });
    }

    const text = `${this.#finalText} ${this.#partialText}`.trim();
    const failure = this.#failure;
    this.#release();
    this.#listening = false;
    if (failure !== undefined && text.length === 0) throw new Error(failure);
    return { text };
  }

  cancel(): Promise<void> {
    this.#finalText = "";
    this.#partialText = "";
    if (this.#listening) this.#load()?.abort();
    this.#listening = false;
    this.#release();
    return Promise.resolve();
  }

  #finish(): void {
    this.#listening = false;
    this.#onEnd?.();
    this.#onEnd = undefined;
  }

  #release(): void {
    for (const subscription of this.#subscriptions) subscription.remove();
    this.#subscriptions = [];
    this.#onEnd = undefined;
  }
}

/** Absent from Expo Go: the import itself throws when the native module is missing. */
function loadSpeechRecognition(): SpeechRecognitionModule | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- may be absent at runtime
    const loaded = require("expo-speech-recognition") as {
      ExpoSpeechRecognitionModule?: SpeechRecognitionModule;
    };
    return loaded.ExpoSpeechRecognitionModule;
  } catch {
    return undefined;
  }
}
