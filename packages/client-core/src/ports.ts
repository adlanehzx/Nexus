/**
 * Platform ports required by the NEXUS client.
 *
 * Five ports, nothing more. Everything else — session, reconnection, state,
 * voice pipeline, request correlation — is standard TypeScript that runs
 * equally well under Node and Hermes/React Native.
 *
 * This makes the client **testable without an iOS/Android simulator**. A screen can be
 * reviewed visually; a reconnection state machine cannot, it must be verified under test.
 * This separation puts all core logic on the verifiable side.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Secret storage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Local secure storage.
 *
 * On iOS, this is Keychain — encrypted by the OS, bound to the device, and
 * inaccessible to other applications. **Never `AsyncStorage`**: it writes
 * unencrypted plaintext in the application sandbox, which an unencrypted
 * backup exports as-is.
 *
 * Methods are asynchronous because Keychain is asynchronous.
 */
export interface SecureStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Network
// ─────────────────────────────────────────────────────────────────────────────

/** HTTP response, limited to what the client needs. */
export interface HttpResponse {
  status: number;
  body: unknown;
}

/**
 * HTTP client.
 *
 * Modeled as a port rather than direct `fetch` calls: tests can describe serverless
 * responses, and native implementations can add certificate pinning without
 * modifying business logic.
 */
export interface HttpClient {
  request(input: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<HttpResponse>;
}

export type SocketState = "idle" | "connecting" | "open" | "closed";

/**
 * Real-time socket transport.
 *
 * Intentionally leaner than browser WebSocket API: `connect`, `send`, `close`,
 * and two subscription callbacks. The client requires nothing else.
 */
export interface SocketTransport {
  readonly state: SocketState;
  connect(url: string): Promise<void>;
  send(data: string): void;
  close(reason: string): void;
  onMessage(handler: (data: string) => void): void;
  /**
   * Close event, whether forced or requested.
   *
   * `code` is the WebSocket close frame code when provided by the platform.
   * It distinguishes "network lost" from "server rejected session", which require
   * different recovery strategies.
   */
  onClose(handler: (reason: string, code?: number) => void): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Voice
// ─────────────────────────────────────────────────────────────────────────────

export interface TranscriptionResult {
  text: string;
  /** Confidence score from 0 to 1, when provided by the platform. */
  confidence?: number;
}

/**
 * Speech recognition.
 *
 * **There is no always-on listening.** The port only exposes `start` and `stop`:
 * the user presses, speaks, and releases. No method exists to enable continuous
 * listening by design — an API lacking the capability cannot be inadvertently misused.
 *
 * `onPartial` is used to stream text as words are spoken; it never triggers transmission.
 */
export interface SpeechToTextProvider {
  isAvailable(): Promise<boolean>;
  /** Requests microphone permission. Denied = `false`, never an exception. */
  requestPermission(): Promise<boolean>;
  start(options?: { locale?: string; onPartial?: (text: string) => void }): Promise<void>;
  /** Stops listening and returns final transcription. */
  stop(): Promise<TranscriptionResult>;
  /** Aborts listening without transcription — user cancelled. */
  cancel(): Promise<void>;
}

/**
 * Speech synthesis.
 *
 * `speak` is **optional** in the flow: responses are always displayed, and only
 * spoken aloud when requested by the user.
 */
export interface TextToSpeechProvider {
  isAvailable(): Promise<boolean>;
  speak(text: string, options?: { locale?: string; rate?: number }): Promise<void>;
  stop(): Promise<void>;
  isSpeaking(): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Miscellaneous
// ─────────────────────────────────────────────────────────────────────────────

/** Injectable timers: reconnection tests do not actually sleep. */
export interface TimerPort {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export const systemTimers: TimerPort = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Device network connection state.
 *
 * Mobile devices frequently lose connectivity. Distinguishing "offline" from
 * "server unreachable" dictates UI behavior: the user can take action for the former,
 * but not the latter.
 */
export interface NetworkMonitor {
  isOnline(): boolean;
  onChange(handler: (online: boolean) => void): void;
}
