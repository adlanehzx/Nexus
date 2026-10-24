import { AppError } from "@nexus/shared";

/**
 * Offline Conflict Resolution, Deduplication, and Prolonged-Disconnection Engine.
 *
 * ## Principles
 * 1. Strict deduplication via idempotency keys and origin sequence numbers.
 * 2. Deterministic conflict resolution: Lamport logical clocks with device-id tie breaking.
 * 3. Server-authoritative resolution: server status overrides local offline mutations.
 * 4. Prolonged disconnection ceiling: mutations exceeding maximum offline TTL expire fail-closed.
 */

export interface VersionedRecord<T = unknown> {
  readonly id: string;
  readonly data: T;
  readonly version: number;
  readonly updatedAt: number | string | null;
  readonly updatedByDeviceId: string;
}

export interface ConflictResolutionOutcome<T = unknown> {
  readonly winner: VersionedRecord<T>;
  readonly conflictDetected: boolean;
  readonly resolutionStrategy:
    "identical" | "lamport_winner" | "server_authoritative" | "tie_break";
}

export class MutationExpiredError extends AppError {
  readonly code = "OFFLINE_MUTATION_EXPIRED";
  readonly httpStatus = 410;

  constructor(recordId: string, ageMs: number, maxTtlMs: number) {
    super({
      message: `Offline mutation for ${recordId} expired after ${Math.round(ageMs / 1000)}s (max allowed: ${Math.round(maxTtlMs / 1000)}s).`,
      userMessage:
        "This action was queued too long ago during offline mode and was discarded to prevent conflicts.",
      context: { recordId, ageMs, maxTtlMs },
    });
  }
}

export class OfflineConflictResolver {
  readonly #seenIdempotencyKeys = new Set<string>();
  readonly #maxOfflineTtlMs: number;

  constructor(options?: { maxOfflineTtlMs?: number }) {
    this.#maxOfflineTtlMs = options?.maxOfflineTtlMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days default
  }

  get maxOfflineTtlMs(): number {
    return this.#maxOfflineTtlMs;
  }

  /**
   * Checks for deduplication using an idempotency key.
   * Returns true if the key is seen previously (duplicate), false if new.
   */
  isDuplicate(idempotencyKey: string): boolean {
    if (this.#seenIdempotencyKeys.has(idempotencyKey)) {
      return true;
    }
    this.#seenIdempotencyKeys.add(idempotencyKey);
    return false;
  }

  /**
   * Validates whether an offline mutation has expired due to prolonged disconnection.
   */
  assertNotExpired(record: VersionedRecord, now = Date.now()): void {
    const ts =
      typeof record.updatedAt === "number"
        ? record.updatedAt
        : record.updatedAt
          ? new Date(record.updatedAt).getTime()
          : 0;
    const age = now - ts;
    if (age > this.#maxOfflineTtlMs) {
      throw new MutationExpiredError(record.id, age, this.#maxOfflineTtlMs);
    }
  }

  /**
   * Resolves concurrent edits between two versions of a record.
   * Deterministic Last-Write-Wins (LWW) with logical version and device ID ordering.
   */
  resolveRecord<T>(
    local: VersionedRecord<T>,
    remote: VersionedRecord<T>,
    options?: { serverAuthoritative?: boolean },
  ): ConflictResolutionOutcome<T> {
    // 1. Exact match
    if (
      local.version === remote.version &&
      local.updatedAt === remote.updatedAt &&
      local.updatedByDeviceId === remote.updatedByDeviceId
    ) {
      return { winner: local, conflictDetected: false, resolutionStrategy: "identical" };
    }

    // 2. Server authoritative override (e.g. server already finalized a task)
    if (options?.serverAuthoritative) {
      return { winner: remote, conflictDetected: true, resolutionStrategy: "server_authoritative" };
    }

    // 3. Higher version wins
    if (remote.version > local.version) {
      return { winner: remote, conflictDetected: true, resolutionStrategy: "lamport_winner" };
    }
    if (local.version > remote.version) {
      return { winner: local, conflictDetected: true, resolutionStrategy: "lamport_winner" };
    }

    // 4. Equal versions: latest timestamp wins
    const localTs =
      typeof local.updatedAt === "number"
        ? local.updatedAt
        : local.updatedAt
          ? new Date(local.updatedAt).getTime()
          : 0;
    const remoteTs =
      typeof remote.updatedAt === "number"
        ? remote.updatedAt
        : remote.updatedAt
          ? new Date(remote.updatedAt).getTime()
          : 0;

    if (remoteTs > localTs) {
      return { winner: remote, conflictDetected: true, resolutionStrategy: "lamport_winner" };
    }
    if (localTs > remoteTs) {
      return { winner: local, conflictDetected: true, resolutionStrategy: "lamport_winner" };
    }

    // 5. Tie break deterministically by lexicographical device ID
    const remoteWins = remote.updatedByDeviceId > local.updatedByDeviceId;
    return {
      winner: remoteWins ? remote : local,
      conflictDetected: true,
      resolutionStrategy: "tie_break",
    };
  }
}
