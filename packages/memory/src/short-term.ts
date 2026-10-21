/**
 * Short-term working context.
 *
 * Ephemeral information tied to active session state (e.g. current file, git branch,
 * immediate tool outputs) that should not pollute long-term memory.
 *
 * Properties:
 *  - In-memory only (never written to persistent database);
 *  - Time-to-live per note;
 *  - Bounded capacity per conversation (LRU eviction).
 */

export interface ShortTermNote {
  conversationId: string;
  /** Stable key — setting existing key updates rather than duplicates. */
  key: string;
  value: string;
  updatedAt: Date;
  expiresAt: Date;
}

export interface ShortTermContextOptions {
  /** Maximum notes retained per conversation before evicting oldest. */
  maxNotesPerConversation?: number;
  /** Note time-to-live in milliseconds. */
  ttlMs?: number;
  now?: () => Date;
}

export class ShortTermContext {
  readonly #notes = new Map<string, Map<string, ShortTermNote>>();
  readonly #max: number;
  readonly #ttlMs: number;
  readonly #now: () => Date;

  constructor(options: ShortTermContextOptions = {}) {
    this.#max = options.maxNotesPerConversation ?? 20;
    this.#ttlMs = options.ttlMs ?? 2 * 60 * 60 * 1000;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Sets or updates a note under a stable key.
   */
  set(conversationId: string, key: string, value: string): ShortTermNote {
    const now = this.#now();
    const note: ShortTermNote = {
      conversationId,
      key,
      value,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + this.#ttlMs),
    };

    const bucket = this.#notes.get(conversationId) ?? new Map<string, ShortTermNote>();
    bucket.delete(key);
    bucket.set(key, note);

    while (bucket.size > this.#max) {
      const oldest = bucket.keys().next().value;
      if (oldest === undefined) break;
      bucket.delete(oldest);
    }

    this.#notes.set(conversationId, bucket);
    return note;
  }

  /** Active notes for a conversation, ordered from oldest to newest. */
  list(conversationId: string): ShortTermNote[] {
    const bucket = this.#notes.get(conversationId);
    if (bucket === undefined) return [];

    const now = this.#now().getTime();
    const alive: ShortTermNote[] = [];

    for (const [key, note] of bucket) {
      if (note.expiresAt.getTime() <= now) bucket.delete(key);
      else alive.push(note);
    }

    if (bucket.size === 0) this.#notes.delete(conversationId);
    return alive;
  }

  get(conversationId: string, key: string): ShortTermNote | undefined {
    return this.list(conversationId).find((note) => note.key === key);
  }

  delete(conversationId: string, key: string): boolean {
    return this.#notes.get(conversationId)?.delete(key) ?? false;
  }

  /** Clears notes for a conversation when archived or closed. */
  clear(conversationId: string): void {
    this.#notes.delete(conversationId);
  }
}
