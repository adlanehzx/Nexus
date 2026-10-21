import { AppError } from "@nexus/shared";

/**
 * Offline mode: what can be queued without network connectivity, and what must be rejected.
 *
 * ## The trap this module prevents
 *
 * An offline queue easily duplicates actions. The client sends "archive my emails",
 * loses connectivity before receiving a response, and retries on reconnection —
 * dispatching the request twice.
 *
 * Three rules prevent duplicate actions:
 *
 * **1. An idempotency key is mandatory, generated upon enqueueing.**
 * Not at transmission time. This ensures all attempts for an entry carry the same key,
 * allowing the core server to recognize repetitions.
 *
 * **2. Only requests that the server can deduplicate are allowed.**
 * If a route does not honor idempotency keys, queueing it guarantees duplicate execution.
 * The queue rejects such requests explicitly.
 *
 * **3. Queue entries expire.**
 * An action whose context has expired should not run: "reply to this email"
 * queued days ago no longer makes sense and could cause harm if executed late.
 *
 * ## What is never queued
 *
 * Confirmations. Approving a high-risk action offline and sending it hours later
 * approves something without reviewing its current state. Confirmations must be
 * given online in view of the active request.
 */

export interface OutboxRequest {
  method: "POST" | "PATCH" | "PUT";
  path: string;
  body: unknown;
}

export interface OutboxEntry {
  id: string;
  request: OutboxRequest;
  /** Generated upon enqueueing. Kept identical across retries. */
  idempotencyKey: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  lastError: string | null;
}

export interface OutboxStore {
  all(): Promise<OutboxEntry[]>;
  save(entries: readonly OutboxEntry[]): Promise<void>;
}

/** In-memory store. Persistent clients provide their own implementation. */
export class InMemoryOutboxStore implements OutboxStore {
  #entries: OutboxEntry[] = [];

  all(): Promise<OutboxEntry[]> {
    return Promise.resolve(this.#entries.map((entry) => ({ ...entry })));
  }

  save(entries: readonly OutboxEntry[]): Promise<void> {
    this.#entries = entries.map((entry) => ({ ...entry }));
    return Promise.resolve();
  }
}

export class NotQueueableError extends AppError {
  readonly code = "NOT_QUEUEABLE";
  readonly httpStatus = 409;

  constructor(path: string, reason: string) {
    super({
      message: `${path} cannot be queued: ${reason}`,
      userMessage:
        "This action needs the network: NEXUS cannot hold it for later without risking doing it twice.",
      context: { path, reason },
    });
  }
}

export interface OutboxOptions {
  store: OutboxStore;
  /**
   * Request paths for which the server honors idempotency keys.
   *
   * Whitelist approach: new routes are not queued by default.
   */
  idempotentPaths: readonly string[];
  now?: () => number;
  newId?: () => string;
  /** Entry time-to-live. Beyond this, context is stale. */
  ttlMs?: number;
  /** Maximum queue capacity. Beyond this, oldest entries are evicted. */
  capacity?: number;
}

export interface FlushOutcome {
  sent: OutboxEntry[];
  /** Entries remaining in queue: flush stopped or not yet attempted. */
  remaining: OutboxEntry[];
  expired: OutboxEntry[];
  stoppedBy: "completed" | "error" | "offline";
}

export type OutboxSender = (
  entry: OutboxEntry,
) => Promise<{ ok: true } | { ok: false; retryable: boolean; error: string }>;

export class Outbox {
  readonly #store: OutboxStore;
  readonly #idempotent: ReadonlySet<string>;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #ttlMs: number;
  readonly #capacity: number;

  constructor(options: OutboxOptions) {
    this.#store = options.store;
    this.#idempotent = new Set(options.idempotentPaths);
    this.#now = options.now ?? (() => Date.now());
    this.#newId =
      options.newId ??
      (() => `out-${String(this.#now())}-${Math.random().toString(36).slice(2, 10)}`);
    // 24 hours: enough to bridge temporary offline periods without becoming stale.
    this.#ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
    this.#capacity = options.capacity ?? 100;
  }

  /** Checks if this request can wait for network restoration. */
  queueable(request: OutboxRequest): { ok: boolean; reason?: string } {
    if (isConfirmation(request.path)) {
      return {
        ok: false,
        reason:
          "a confirmation must be made online with current context, not hours later",
      };
    }
    if (!this.#idempotent.has(request.path)) {
      return {
        ok: false,
        reason: "the server cannot recognize repeated requests on this path",
      };
    }
    return { ok: true };
  }

  async enqueue(request: OutboxRequest): Promise<OutboxEntry> {
    const verdict = this.queueable(request);
    if (!verdict.ok) throw new NotQueueableError(request.path, verdict.reason ?? "rejected");

    const createdAt = this.#now();
    const entry: OutboxEntry = {
      id: this.#newId(),
      request,
      // The idempotency key is born here and reused on all subsequent retries.
      idempotencyKey: this.#newId(),
      createdAt,
      expiresAt: createdAt + this.#ttlMs,
      attempts: 0,
      lastError: null,
    };

    const existing = await this.#store.all();
    const kept = [...existing, entry].slice(-this.#capacity);
    await this.#store.save(kept);
    return entry;
  }

  async pending(): Promise<OutboxEntry[]> {
    const now = this.#now();
    return (await this.#store.all()).filter((entry) => entry.expiresAt > now);
  }

  /**
   * Flushes the queue in order, stopping at the first retryable error.
   *
   * Maintaining ordering and stopping on error prevents subsequent requests
   * from being processed out of sequence.
   */
  async flush(send: OutboxSender, options: { online?: boolean } = {}): Promise<FlushOutcome> {
    const now = this.#now();
    const all = await this.#store.all();
    const expired = all.filter((entry) => entry.expiresAt <= now);
    let queue = all.filter((entry) => entry.expiresAt > now);

    if (options.online === false) {
      await this.#store.save(queue);
      return { sent: [], remaining: queue, expired, stoppedBy: "offline" };
    }

    const sent: OutboxEntry[] = [];
    let stoppedBy: FlushOutcome["stoppedBy"] = "completed";

    while (queue.length > 0) {
      const entry = queue[0];
      if (entry === undefined) break;
      const attempted: OutboxEntry = { ...entry, attempts: entry.attempts + 1 };
      const result = await send(attempted);

      if (result.ok) {
        sent.push(attempted);
        queue = queue.slice(1);
        continue;
      }
      if (!result.retryable) {
        // Permanent rejection (invalid request, missing permission) won't succeed later;
        // drop it to unblock the rest of the queue.
        queue = queue.slice(1);
        continue;
      }
      queue = [{ ...attempted, lastError: result.error }, ...queue.slice(1)];
      stoppedBy = "error";
      break;
    }

    await this.#store.save(queue);
    return { sent, remaining: queue, expired, stoppedBy };
  }

  /** Clears the queue on sign-out (queue belongs to a session). */
  async clear(): Promise<void> {
    await this.#store.save([]);
  }
}

function isConfirmation(path: string): boolean {
  return /\/confirmations?\//.test(path) || path.endsWith("/confirmation");
}
