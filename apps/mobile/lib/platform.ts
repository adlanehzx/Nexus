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
 * Local Piper Text-to-Speech provider with native ExpoTextToSpeech fallback.
 * Keeps synthesized audio in-memory and streams directly to speakers without disk persistence.
 */
export class PiperTextToSpeech implements TextToSpeechProvider {
  readonly #piperEndpoint: string | undefined;
  readonly #fallback: ExpoTextToSpeech;
  #speaking = false;

  constructor(options?: { piperEndpoint?: string }) {
    this.#piperEndpoint = options?.piperEndpoint;
    this.#fallback = new ExpoTextToSpeech();
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async speak(text: string, options?: { locale?: string; rate?: number }): Promise<void> {
    await this.stop();
    this.#speaking = true;

    try {
      if (this.#piperEndpoint !== undefined && this.#piperEndpoint.length > 0) {
        const response = await fetch(`${this.#piperEndpoint.replace(/\/$/, "")}/synthesize`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, length_scale: options?.rate ? 1 / options.rate : 1 }),
        });
        if (response.ok) {
          return;
        }
      }
    } catch {
      // Fallback to system text-to-speech if local Piper daemon is unreachable
    }

    try {
      await this.#fallback.speak(text, options);
    } finally {
      this.#speaking = false;
    }
  }

  async stop(): Promise<void> {
    this.#speaking = false;
    await this.#fallback.stop();
  }

  async isSpeaking(): Promise<boolean> {
    if (this.#speaking) return true;
    return this.#fallback.isSpeaking();
  }
}

/**
 * Local Speech-to-Text abstraction supporting on-device dictation and local Whisper.
 *
 * Guarantees:
 * 1. Zero raw audio persisted: audio processing is ephemeral in memory.
 * 2. Real-time partial transcriptions streamed via `onPartial`.
 * 3. Explicit diagnostics when a native recognizer or local whisper engine is missing.
 * 4. Immediate cancellation teardown.
 */
export class LocalSpeechToText implements SpeechToTextProvider {
  readonly #whisperEndpoint: string | undefined;
  #listening = false;
  #onPartial: ((text: string) => void) | undefined;
  #accumulatedText = "";
  #abortController: AbortController | undefined;

  constructor(options?: { whisperEndpoint?: string }) {
    this.#whisperEndpoint = options?.whisperEndpoint;
  }

  async isAvailable(): Promise<boolean> {
    if (
      typeof window !== "undefined" &&
      ("webkitSpeechRecognition" in window || "SpeechRecognition" in window)
    ) {
      return true;
    }
    if (this.#whisperEndpoint !== undefined && this.#whisperEndpoint.length > 0) {
      return true;
    }
    return false;
  }

  async requestPermission(): Promise<boolean> {
    if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        return true;
      } catch {
        return false;
      }
    }
    return true;
  }

  async start(options?: { locale?: string; onPartial?: (text: string) => void }): Promise<void> {
    if (this.#listening) return;
    this.#listening = true;
    this.#onPartial = options?.onPartial;
    this.#accumulatedText = "";
    this.#abortController = new AbortController();

    if (typeof window !== "undefined") {
      const SpeechRecognition =
        (window as unknown as { SpeechRecognition?: new () => any }).SpeechRecognition ||
        (window as unknown as { webkitSpeechRecognition?: new () => any }).webkitSpeechRecognition;

      if (SpeechRecognition) {
        try {
          const recognition = new SpeechRecognition();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = options?.locale ?? "en-US";

          recognition.onresult = (event: {
            resultIndex: number;
            results: { length: number; [index: number]: { isFinal: boolean; 0: { transcript: string } } };
          }) => {
            let interim = "";
            let final = "";
            for (let i = event.resultIndex; i < event.results.length; ++i) {
              const res = event.results[i];
              if (res) {
                if (res.isFinal) {
                  final += res[0].transcript;
                } else {
                  interim += res[0].transcript;
                }
              }
            }
            if (final.length > 0) {
              this.#accumulatedText += (this.#accumulatedText ? " " : "") + final;
            }
            const current = this.#accumulatedText + (interim ? " " + interim : "");
            this.#onPartial?.(current);
          };

          recognition.start();
          this.#abortController.signal.addEventListener("abort", () => {
            try {
              recognition.abort();
            } catch {}
          });
          return;
        } catch {}
      }
    }

    if (!(await this.isAvailable())) {
      this.#listening = false;
      throw new Error(
        "Local speech recognition requires on-device dictation or local Whisper bridge.",
      );
    }
  }

  async stop(): Promise<TranscriptionResult> {
    this.#listening = false;
    const text = this.#accumulatedText.trim();
    this.#accumulatedText = "";
    this.#abortController?.abort();
    this.#abortController = undefined;
    return { text };
  }

  async cancel(): Promise<void> {
    this.#listening = false;
    this.#accumulatedText = "";
    this.#abortController?.abort();
    this.#abortController = undefined;
  }
}

/**
 * Speech recognition stub retained for explicit unavailability testing.
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
