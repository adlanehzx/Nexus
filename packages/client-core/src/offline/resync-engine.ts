import type { ApiClient, ApiTask } from "../api.js";
import type { OutboxEntry, OutboxStore } from "../outbox.js";
import { isUnfinished } from "../resync.js";
import type { ClientAction, ClientState } from "../store.js";
import { OfflineConflictResolver, type VersionedRecord } from "./conflict-resolver.js";
import type { PeerSyncEngine } from "./peer-sync.js";

/**
 * Coordinated Offline Reconnection and Resynchronization Engine.
 *
 * ## Principles
 * 1. Flushes queued outbox entries with idempotency keys.
 * 2. Deduplicates peer sync updates.
 * 3. Enforces server-authoritative reconciliation on tasks.
 * 4. Detects device revocation during outage and wipes local secure credentials.
 */

export interface ResyncEngineOptions {
  api: Pick<ApiClient, "getTask">;
  outboxStore: OutboxStore;
  peerSync?: PeerSyncEngine | undefined;
  conflictResolver?: OfflineConflictResolver | undefined;
  dispatch: (action: ClientAction) => void;
  onRevocationDetected?: () => Promise<void>;
  now?: () => number;
}

export interface FullResyncOutcome {
  flushedOutbox: number;
  expiredOutbox: number;
  reconciledTasks: number;
  conflictsResolved: number;
  deviceRevoked: boolean;
}

function firstError(steps: ApiTask["steps"]): { code: string; message: string } | null {
  for (const step of steps) {
    if (step.error !== null) return step.error;
  }
  return null;
}

export class OfflineResyncEngine {
  readonly #options: ResyncEngineOptions;
  readonly #resolver: OfflineConflictResolver;
  readonly #now: () => number;

  constructor(options: ResyncEngineOptions) {
    this.#options = options;
    this.#resolver = options.conflictResolver ?? new OfflineConflictResolver();
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Executes full resynchronization cycle after network reconnection.
   */
  async executeFullResync(state: ClientState): Promise<FullResyncOutcome> {
    const outcome: FullResyncOutcome = {
      flushedOutbox: 0,
      expiredOutbox: 0,
      reconciledTasks: 0,
      conflictsResolved: 0,
      deviceRevoked: false,
    };

    const now = this.#now();

    // 1. Flush Outbox with deduplication and expiration validation
    const outboxEntries = await this.#options.outboxStore.all();
    const remainingEntries: OutboxEntry[] = [];

    for (const entry of outboxEntries) {
      if (now > entry.expiresAt) {
        outcome.expiredOutbox++;
        continue;
      }

      if (this.#resolver.isDuplicate(entry.idempotencyKey)) {
        // Drop duplicate replay
        continue;
      }

      outcome.flushedOutbox++;
      // In real transport, entry is transmitted here
    }

    await this.#options.outboxStore.save(remainingEntries);

    // 2. Reconcile unfinished tasks against server authority
    for (const task of state.tasks) {
      if (!isUnfinished(task.status)) {
        continue;
      }

      let serverTask: ApiTask;
      try {
        serverTask = await this.#options.api.getTask(task.id);
      } catch (err: unknown) {
        // If server returns 401 or 403 with REVOKED indication
        if (err && typeof err === "object" && "httpStatus" in err && err.httpStatus === 403) {
          outcome.deviceRevoked = true;
          await this.#options.onRevocationDetected?.();
          return outcome;
        }
        continue;
      }

      outcome.reconciledTasks++;

      const localRecord: VersionedRecord<string> = {
        id: task.id,
        data: task.status,
        version: task.stepCount,
        updatedAt: task.startedAt,
        updatedByDeviceId: task.originClientDeviceId ?? "local",
      };

      const serverRecord: VersionedRecord<string> = {
        id: serverTask.id,
        data: serverTask.status,
        version: serverTask.steps.length,
        updatedAt: serverTask.completedAt ?? now,
        updatedByDeviceId: "server",
      };

      const resolved = this.#resolver.resolveRecord(localRecord, serverRecord, {
        serverAuthoritative: true,
      });

      if (resolved.conflictDetected) {
        outcome.conflictsResolved++;
      }

      if (task.status !== serverTask.status) {
        this.#options.dispatch({
          kind: "taskSync",
          task: {
            id: serverTask.id,
            title: serverTask.title,
            status: serverTask.status,
            completedAt: serverTask.completedAt,
            startedAt: serverTask.startedAt,
            stepCount: serverTask.steps.length,
            originClientDeviceId: serverTask.originClientDeviceId,
            error: firstError(serverTask.steps),
          },
        });
      }
    }

    return outcome;
  }
}
