import { describe, expect, it } from "vitest";
import {
  MutationExpiredError,
  OfflineConflictResolver,
  type VersionedRecord,
} from "../src/offline/conflict-resolver.js";

describe("Offline Conflict Resolution and Deduplication", () => {
  it("deduplicates actions using idempotency keys", () => {
    const resolver = new OfflineConflictResolver();
    const key = "idem_task_create_12345";

    expect(resolver.isDuplicate(key)).toBe(false); // First time: not duplicate
    expect(resolver.isDuplicate(key)).toBe(true); // Replay: duplicate
    expect(resolver.isDuplicate(key)).toBe(true); // Replay 2: duplicate

    expect(resolver.isDuplicate("idem_task_create_67890")).toBe(false);
  });

  it("resolves conflicts deterministically using logical clock and tie break", () => {
    const resolver = new OfflineConflictResolver();

    const recordA: VersionedRecord<{ note: string }> = {
      id: "note_1",
      data: { note: "Edit from device A" },
      version: 2,
      updatedAt: 1000,
      updatedByDeviceId: "dev_laptop",
    };

    const recordB: VersionedRecord<{ note: string }> = {
      id: "note_1",
      data: { note: "Edit from device B" },
      version: 3, // Higher version
      updatedAt: 900,
      updatedByDeviceId: "dev_phone",
    };

    const outcome = resolver.resolveRecord(recordA, recordB);
    expect(outcome.conflictDetected).toBe(true);
    expect(outcome.resolutionStrategy).toBe("lamport_winner");
    expect(outcome.winner.data.note).toBe("Edit from device B");
  });

  it("breaks equal version and timestamp ties using deterministic device ID", () => {
    const resolver = new OfflineConflictResolver();

    const recordA: VersionedRecord<string> = {
      id: "doc_1",
      data: "Data from A",
      version: 1,
      updatedAt: 1000,
      updatedByDeviceId: "dev_aaa",
    };

    const recordB: VersionedRecord<string> = {
      id: "doc_1",
      data: "Data from Z",
      version: 1,
      updatedAt: 1000,
      updatedByDeviceId: "dev_zzz",
    };

    const outcome = resolver.resolveRecord(recordA, recordB);
    expect(outcome.resolutionStrategy).toBe("tie_break");
    expect(outcome.winner.updatedByDeviceId).toBe("dev_zzz"); // Lexicographical winner
  });

  it("favors server authoritative records on task status conflicts", () => {
    const resolver = new OfflineConflictResolver();

    const localOfflineTask: VersionedRecord<string> = {
      id: "task_789",
      data: "pending",
      version: 5,
      updatedAt: 2000,
      updatedByDeviceId: "dev_mobile",
    };

    const serverTask: VersionedRecord<string> = {
      id: "task_789",
      data: "failed",
      version: 4,
      updatedAt: 1500,
      updatedByDeviceId: "server",
    };

    const outcome = resolver.resolveRecord(localOfflineTask, serverTask, {
      serverAuthoritative: true,
    });
    expect(outcome.winner.data).toBe("failed");
    expect(outcome.resolutionStrategy).toBe("server_authoritative");
  });

  it("expires mutations from prolonged offline periods beyond TTL", () => {
    const resolver = new OfflineConflictResolver({ maxOfflineTtlMs: 24 * 3600 * 1000 }); // 1 day
    const now = Date.now();

    const freshRecord: VersionedRecord = {
      id: "rec_fresh",
      data: {},
      version: 1,
      updatedAt: now - 3600 * 1000, // 1 hour ago
      updatedByDeviceId: "dev_1",
    };
    expect(() => resolver.assertNotExpired(freshRecord, now)).not.toThrow();

    const staleRecord: VersionedRecord = {
      id: "rec_stale",
      data: {},
      version: 1,
      updatedAt: now - 48 * 3600 * 1000, // 2 days ago (> 1 day TTL)
      updatedByDeviceId: "dev_1",
    };
    expect(() => resolver.assertNotExpired(staleRecord, now)).toThrowError(MutationExpiredError);
  });
});
