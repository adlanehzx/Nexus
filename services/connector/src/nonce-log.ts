import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "@nexus/shared";

/**
 * Durable storage for spent nonces.
 *
 * ## Why this has to survive a restart
 *
 * A nonce held only in memory protects nothing across a restart. An attacker
 * who captured a signed request has a window equal to the acceptance window
 * plus skew; restarting the connector inside that window — which a crash loop,
 * an update, or a `systemctl restart` does for them — hands back a fresh nonce
 * namespace and the captured request works once more. The timestamp check
 * bounds the damage to seconds, but "seconds" is not "never", and the whole
 * point of a nonce is to make replay impossible rather than brief.
 *
 * ## Why the write is synchronous
 *
 * Because the ordering matters more than the latency. An asynchronous append
 * would let the connector answer a request whose nonce is not yet on disk; a
 * crash in that gap loses exactly the record that would have refused the
 * replay. A synchronous append means a request is never accepted before its
 * nonce is durable. These are loopback requests at human frequency, not a hot
 * path.
 *
 * ## Format
 *
 * Append-only JSON lines, compacted when they outgrow a threshold. An append
 * cannot corrupt earlier records, and a torn final line is discarded on load
 * rather than failing the whole file — a half-written line is a nonce we may
 * accept once, which is the same exposure as not having been written at all.
 */

export interface SpentNonce {
  clientId: string;
  nonce: string;
  /** Epoch milliseconds after which this record is no longer useful. */
  expiresAt: number;
}

export interface NoncePersistence {
  /** Every record still within its validity window. */
  load(now: number): SpentNonce[];
  /**
   * Records a spent nonce durably.
   *
   * Throws when it cannot. The caller must then refuse the request: accepting
   * one whose nonce could not be recorded is accepting an unbounded replay.
   */
  append(entry: SpentNonce): void;
  /** Drops expired records. Safe to call at any time. */
  compact(now: number): void;
}

export class NoncePersistenceError extends AppError {
  readonly code = "CONNECTOR_NONCE_STORE_UNAVAILABLE";
  readonly httpStatus = 503;

  constructor(detail: string) {
    super({
      message: `connector nonce store is unavailable: ${detail}`,
      userMessage: "The connector cannot accept requests right now.",
    });
  }
}

/** Keeps nothing. For tests and for a deliberately stateless connector. */
export class InMemoryNoncePersistence implements NoncePersistence {
  readonly entries: SpentNonce[] = [];

  load(now: number): SpentNonce[] {
    return this.entries.filter((entry) => entry.expiresAt > now);
  }

  append(entry: SpentNonce): void {
    this.entries.push(entry);
  }

  compact(now: number): void {
    const kept = this.load(now);
    this.entries.length = 0;
    this.entries.push(...kept);
  }
}

export interface FileNoncePersistenceOptions {
  /** The log file. Its directory is created if needed, owner-only. */
  path: string;
  /** Records tolerated before a compaction is triggered on append. */
  compactAfterEntries?: number;
}

export class FileNoncePersistence implements NoncePersistence {
  readonly #path: string;
  readonly #compactAfter: number;
  #appended = 0;

  constructor(options: FileNoncePersistenceOptions) {
    this.#path = options.path;
    // High enough that compaction is rare, low enough that the file cannot grow
    // without bound on a busy connector.
    this.#compactAfter = options.compactAfterEntries ?? 1_000;
    try {
      // 0o700: the log reveals which clients talked to the connector and when,
      // which is not a secret but is nobody else's business.
      mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new NoncePersistenceError(`cannot create ${dirname(this.#path)}: ${errorCode(error)}`);
    }
  }

  load(now: number): SpentNonce[] {
    let raw: string;
    try {
      raw = readFileSync(this.#path, "utf8");
    } catch (error) {
      // A missing file is a first start, not a failure.
      if (errorCode(error) === "ENOENT") return [];
      throw new NoncePersistenceError(`cannot read ${this.#path}: ${errorCode(error)}`);
    }

    const kept: SpentNonce[] = [];
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      const entry = parseEntry(line);
      // A torn or malformed line is skipped rather than fatal. Refusing to
      // start because of one bad line would turn a cosmetic problem into an
      // outage, and the exposure is one replayable nonce — the same as if the
      // line had never been written.
      if (entry !== undefined && entry.expiresAt > now) kept.push(entry);
    }
    return kept;
  }

  append(entry: SpentNonce): void {
    try {
      appendFileSync(this.#path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      throw new NoncePersistenceError(`cannot append to ${this.#path}: ${errorCode(error)}`);
    }
    this.#appended += 1;
    if (this.#appended >= this.#compactAfter) {
      this.compact(Date.now());
      this.#appended = 0;
    }
  }

  compact(now: number): void {
    const kept = this.load(now);
    const temporary = `${this.#path}.${String(process.pid)}.tmp`;
    try {
      const body = kept.map((entry) => `${JSON.stringify(entry)}\n`).join("");
      writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
      // fsync then rename: a rename is atomic, so a crash leaves either the
      // old complete log or the new one, never a truncated file.
      const handle = openSync(temporary, "r");
      try {
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(temporary, this.#path);
    } catch (error) {
      throw new NoncePersistenceError(`cannot compact ${this.#path}: ${errorCode(error)}`);
    }
  }
}

/** The conventional location for a connector's nonce log inside a state directory. */
export function defaultNonceLogPath(stateDir: string): string {
  return join(stateDir, "spent-nonces.jsonl");
}

function parseEntry(line: string): SpentNonce | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const { clientId, nonce, expiresAt } = parsed as Partial<SpentNonce>;
    if (typeof clientId !== "string") return undefined;
    if (typeof nonce !== "string") return undefined;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return undefined;
    return { clientId, nonce, expiresAt };
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code ?? "unknown";
}
