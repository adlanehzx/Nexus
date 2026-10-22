import { clientEnvelope, type ServerToClientType } from "@nexus/protocol";
import type {
  HttpClient,
  HttpResponse,
  NetworkMonitor,
  SecureStorage,
  SocketState,
  SocketTransport,
  SpeechToTextProvider,
  TextToSpeechProvider,
  TimerPort,
  TranscriptionResult,
} from "../src/ports.js";

/**
 * Test doubles for the five ports.
 */

/** In-memory secure storage. Also tracks removed keys. */
export class FakeSecureStorage implements SecureStorage {
  readonly values = new Map<string, string>();
  readonly removed: string[] = [];

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.values.delete(key);
    this.removed.push(key);
    return Promise.resolve();
  }
}

export interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
  authorization?: string;
}

/**
 * Scripted HTTP client.
 */
export class FakeHttpClient implements HttpClient {
  readonly requests: RecordedRequest[] = [];
  readonly responses = new Map<string, HttpResponse[]>();
  /** Makes next call fail with network error. */
  failNext = false;

  on(method: string, path: string, ...responses: HttpResponse[]): this {
    this.responses.set(`${method} ${path}`, responses);
    return this;
  }

  request(input: Parameters<HttpClient["request"]>[0]): Promise<HttpResponse> {
    this.requests.push({
      method: input.method,
      path: input.path,
      body: input.body,
      ...(input.headers?.authorization === undefined
        ? {}
        : { authorization: input.headers.authorization }),
    });

    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("network unavailable"));
    }

    const queue = this.responses.get(`${input.method} ${input.path}`);
    if (queue === undefined || queue.length === 0) {
      return Promise.resolve({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    }

    return Promise.resolve(queue.length === 1 ? queue[0]! : queue.shift()!);
  }

  countOf(method: string, path: string): number {
    return this.requests.filter((r) => r.method === method && r.path === path).length;
  }
}

/** In-memory socket transport where tests play the server role. */
export class FakeSocket implements SocketTransport {
  #state: SocketState = "idle";
  #onMessage: ((data: string) => void) | undefined;
  #onClose: ((reason: string, code?: number) => void) | undefined;

  readonly sent: { type: string; requestId?: string; payload: Record<string, unknown> }[] = [];
  /** Fails next `connect` call to simulate unreachable server. */
  failNextConnect = false;

  get state(): SocketState {
    return this.#state;
  }

  connect(_url: string): Promise<void> {
    this.#state = "connecting";
    if (this.failNextConnect) {
      this.failNextConnect = false;
      this.#state = "closed";
      return Promise.reject(new Error("connection refused"));
    }
    this.#state = "open";
    return Promise.resolve();
  }

  send(data: string): void {
    const envelope = JSON.parse(data) as {
      type: string;
      requestId?: string;
      payload: Record<string, unknown>;
    };
    this.sent.push(envelope);
  }

  close(reason: string, code = 1000): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#onClose?.(reason, code);
  }

  onMessage(handler: (data: string) => void): void {
    this.#onMessage = handler;
  }

  onClose(handler: (reason: string, code?: number) => void): void {
    this.#onClose = handler;
  }

  /** Pushes server-to-client message. */
  deliver(type: ServerToClientType, payload: unknown, requestId?: string): void {
    this.#onMessage?.(
      JSON.stringify(
        clientEnvelope(type, payload as never, {
          id: `s-${String(this.sent.length)}`,
          at: new Date("2026-09-02T12:00:00.000Z"),
          requestId,
        }),
      ),
    );
  }

  /** Raw frame delivery for malformed frame tests. */
  deliverRaw(data: string): void {
    this.#onMessage?.(data);
  }

  /** Simulates network drop. */
  drop(reason = "network lost", code = 1006): void {
    this.close(reason, code);
  }

  /** Simulates server session rejection (expired token, revoked device). */
  reject(reason = "authentication refused"): void {
    this.close(reason, 4401);
  }

  /** Reopens socket after drop to test recovery. */
  reopen(): void {
    this.#state = "idle";
  }

  lastOfType(type: string) {
    return this.sent.filter((message) => message.type === type).at(-1);
  }
}

/** Controlled network monitor. */
export class FakeNetwork implements NetworkMonitor {
  #online = true;
  #handler: ((online: boolean) => void) | undefined;

  isOnline(): boolean {
    return this.#online;
  }

  onChange(handler: (online: boolean) => void): void {
    this.#handler = handler;
  }

  set(online: boolean): void {
    this.#online = online;
    this.#handler?.(online);
  }
}

/** Controlled timers for deterministic testing without sleeping. */
export class TestTimers implements TimerPort {
  #next = 1;
  readonly pending = new Map<number, { callback: () => void; delayMs: number }>();

  set = (callback: () => void, delayMs: number): unknown => {
    const handle = this.#next++;
    this.pending.set(handle, { callback, delayMs });
    return handle;
  };

  clear = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  flush(): number {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, { callback }] of entries) callback();
    return entries.length;
  }

  get delays(): number[] {
    return [...this.pending.values()].map((entry) => entry.delayMs);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Voice
// ─────────────────────────────────────────────────────────────────────────────

export class FakeSpeechToText implements SpeechToTextProvider {
  available = true;
  permitted = true;
  transcript: TranscriptionResult = { text: "open Spotify", confidence: 0.95 };

  started = 0;
  stopped = 0;
  cancelled = 0;
  #onPartial: ((text: string) => void) | undefined;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.available);
  }

  requestPermission(): Promise<boolean> {
    return Promise.resolve(this.permitted);
  }

  start(options?: { onPartial?: (text: string) => void }): Promise<void> {
    this.started += 1;
    this.#onPartial = options?.onPartial;
    return Promise.resolve();
  }

  stop(): Promise<TranscriptionResult> {
    this.stopped += 1;
    return Promise.resolve(this.transcript);
  }

  cancel(): Promise<void> {
    this.cancelled += 1;
    return Promise.resolve();
  }

  /** Simulates partial transcription streaming. */
  emitPartial(text: string): void {
    this.#onPartial?.(text);
  }
}

export class FakeTextToSpeech implements TextToSpeechProvider {
  available = true;
  readonly spoken: string[] = [];
  stopped = 0;
  failNext = false;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.available);
  }

  speak(text: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("speech synthesis unavailable"));
    }
    this.spoken.push(text);
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopped += 1;
    return Promise.resolve();
  }

  isSpeaking(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

export const TOKENS = {
  access: "access-token-1",
  refresh: "refresh-token-1",
};

export function loginResponse(tokens = TOKENS): HttpResponse {
  return {
    status: 200,
    body: {
      data: {
        user: { id: "u1", email: "alex@example.test" },
        tokens: {
          accessToken: tokens.access,
          refreshToken: tokens.refresh,
          accessExpiresAt: "2026-09-02T12:15:00.000Z",
          refreshExpiresAt: "2026-10-02T12:00:00.000Z",
        },
      },
      meta: { requestId: "r1" },
    },
  };
}

export async function settle(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

export async function until(predicate: () => boolean, rounds = 200): Promise<boolean> {
  for (let index = 0; index < rounds; index += 1) {
    if (predicate()) return true;
    await Promise.resolve();
  }
  return predicate();
}
