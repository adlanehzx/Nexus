import { describe, it, expect, vi } from "vitest";
import {
  InMemoryMissionEventStore,
  OptimisticLockingError,
  projectMission,
  InMemoryTransactionalOutbox,
  InMemoryTransactionalInbox,
  InMemoryLeaseManager,
  InMemoryDeadLetterQueue,
  ReconciliationEngine,
} from "../src/index.js";

describe("Transactional Orchestration Engine (LOT A)", () => {
  describe("Event Sourcing & Optimistic Locking", () => {
    it("appends events and rejects out-of-order writes with OptimisticLockingError", async () => {
      const store = new InMemoryMissionEventStore();
      const missionId = "mission-xyz-1";

      const ev1 = await store.append({
        missionId,
        type: "mission.created",
        expectedVersion: 0,
        correlationId: "corr-1",
        payload: { title: "Test Mission" },
      });

      expect(ev1.version).toBe(1);
      expect(ev1.type).toBe("mission.created");

      const ev2 = await store.append({
        missionId,
        type: "mission.started",
        expectedVersion: 1,
        correlationId: "corr-1",
        payload: {},
      });

      expect(ev2.version).toBe(2);

      // Attempt concurrent write with stale version 1
      await expect(
        store.append({
          missionId,
          type: "mission.completed",
          expectedVersion: 1,
          correlationId: "corr-1",
          payload: {},
        }),
      ).rejects.toThrow(OptimisticLockingError);
    });

    it("deterministically projects mission state across full lifecycle", async () => {
      const store = new InMemoryMissionEventStore();
      const missionId = "mission-lifecycle";

      await store.append({
        missionId,
        type: "mission.created",
        expectedVersion: 0,
        correlationId: "corr-lifecycle",
        payload: {},
      });

      await store.append({
        missionId,
        type: "mission.planned",
        expectedVersion: 1,
        correlationId: "corr-lifecycle",
        payload: {
          plan: {
            goal: "Refactor core",
            steps: [
              { id: "s1", title: "Analyze code", status: "pending" },
              { id: "s2", title: "Execute changes", status: "pending" },
            ],
          },
        },
      });

      await store.append({
        missionId,
        type: "mission.started",
        expectedVersion: 2,
        correlationId: "corr-lifecycle",
        payload: {},
      });

      await store.append({
        missionId,
        type: "mission.step_started",
        expectedVersion: 3,
        correlationId: "corr-lifecycle",
        payload: { stepId: "s1" },
      });

      await store.append({
        missionId,
        type: "tool.execution_requested",
        expectedVersion: 4,
        correlationId: "corr-lifecycle",
        payload: { toolCallId: "call-1", toolName: "read_file" },
      });

      await store.append({
        missionId,
        type: "tool.execution_completed",
        expectedVersion: 5,
        correlationId: "corr-lifecycle",
        payload: { toolCallId: "call-1", durationMs: 45, result: "content" },
      });

      await store.append({
        missionId,
        type: "mission.step_completed",
        expectedVersion: 6,
        correlationId: "corr-lifecycle",
        payload: { stepId: "s1", success: true },
      });

      await store.append({
        missionId,
        type: "mission.waiting_confirmation",
        expectedVersion: 7,
        correlationId: "corr-lifecycle",
        payload: {
          confirmationId: "conf-123",
          callId: "call-delete",
          toolName: "delete_database",
          arguments: { force: true },
        },
      });

      const events = await store.getEvents(missionId);
      const intermediateProjection = projectMission(events);

      expect(intermediateProjection?.phase).toBe("waiting_for_confirmation");
      expect(intermediateProjection?.pendingConfirmation?.toolName).toBe("delete_database");
      expect(intermediateProjection?.plan?.steps[0]?.status).toBe("completed");

      // Resume and complete
      await store.append({
        missionId,
        type: "mission.confirmation_resolved",
        expectedVersion: 8,
        correlationId: "corr-lifecycle",
        payload: { approved: true },
      });

      await store.append({
        missionId,
        type: "mission.resumed",
        expectedVersion: 9,
        correlationId: "corr-lifecycle",
        payload: {},
      });

      await store.append({
        missionId,
        type: "mission.completed",
        expectedVersion: 10,
        correlationId: "corr-lifecycle",
        payload: { output: "Successfully executed mission." },
      });

      const finalEvents = await store.getEvents(missionId);
      const finalProjection = projectMission(finalEvents);

      expect(finalProjection?.phase).toBe("completed");
      expect(finalProjection?.pendingConfirmation).toBeUndefined();
      expect(finalProjection?.finalOutput).toBe("Successfully executed mission.");
    });
  });

  describe("Transactional Outbox", () => {
    it("handles batch processing, retries and dead-letter routing", async () => {
      const outbox = new InMemoryTransactionalOutbox();

      await outbox.enqueue([
        {
          aggregateType: "mission",
          aggregateId: "m-1",
          eventType: "mission.created",
          payload: { id: "m-1" },
        },
        {
          aggregateType: "mission",
          aggregateId: "m-2",
          eventType: "mission.failed",
          payload: { error: "Network timeout" },
          maxRetries: 2,
        },
      ]);

      expect(outbox.getPendingCount()).toBe(2);

      // Publisher fails on m-2
      const publisher = vi.fn().mockImplementation(async (msg) => {
        await Promise.resolve();
        if (msg.aggregateId === "m-2") {
          throw new Error("Redis cluster offline");
        }
      });

      const res1 = await outbox.processBatch(publisher);
      expect(res1.published).toBe(1);
      expect(res1.failed).toBe(1);

      // Second attempt on m-2 (reaches maxRetries: 2 -> dead_letter)
      const res2 = await outbox.processBatch(publisher);
      expect(res2.published).toBe(0);
      expect(res2.failed).toBe(1);

      expect(outbox.getDeadLetterCount()).toBe(1);
      expect(outbox.getPendingCount()).toBe(0);
    });
  });

  describe("Transactional Inbox & Idempotency", () => {
    it("deduplicates commands and records receipts deterministically", async () => {
      const inbox = new InMemoryTransactionalInbox();
      const idempotencyKey = "client-req-abc-999";

      const first = await inbox.receive({
        idempotencyKey,
        commandType: "execute_step",
        payload: { step: 1 },
      });

      expect(first.duplicate).toBe(false);

      // Record receipt
      await inbox.recordReceipt(idempotencyKey, {
        status: "completed",
        result: { exitCode: 0, stdout: "Success" },
      });

      // Second receive with identical idempotency key
      const second = await inbox.receive({
        idempotencyKey,
        commandType: "execute_step",
        payload: { step: 1 },
      });

      expect(second.duplicate).toBe(true);
      expect(second.existingReceipt?.status).toBe("completed");
      expect((second.existingReceipt?.result as { exitCode: number })?.exitCode).toBe(0);
    });
  });

  describe("Execution Leases with Fencing Tokens", () => {
    it("enforces mutual exclusion and monotonically increasing fencing tokens", async () => {
      const manager = new InMemoryLeaseManager();
      const resourceId = "mission-res-42";

      const lease1 = await manager.acquire(resourceId, "worker-node-A", 10_000);
      expect(lease1).not.toBeNull();
      expect(lease1?.holderId).toBe("worker-node-A");
      const token1 = lease1!.fencingToken;

      // Concurrent acquire from worker-node-B while active must return null
      const lease2 = await manager.acquire(resourceId, "worker-node-B", 10_000);
      expect(lease2).toBeNull();

      // Verify token
      expect(await manager.verifyToken(resourceId, token1)).toBe(true);
      expect(await manager.verifyToken(resourceId, token1 - 1)).toBe(false);

      // Release by worker A
      const released = await manager.release(resourceId, "worker-node-A", token1);
      expect(released).toBe(true);

      // Now worker B can acquire, receiving a higher fencing token
      const lease3 = await manager.acquire(resourceId, "worker-node-B", 10_000);
      expect(lease3).not.toBeNull();
      expect(lease3?.fencingToken).toBeGreaterThan(token1);
    });
  });

  describe("Reconciliation Engine", () => {
    it("detects expired leases on running missions and recovers state safely", async () => {
      const eventStore = new InMemoryMissionEventStore();
      const outbox = new InMemoryTransactionalOutbox();
      const leaseManager = new InMemoryLeaseManager();
      const deadLetterQueue = new InMemoryDeadLetterQueue();

      const engine = new ReconciliationEngine(eventStore, outbox, leaseManager, deadLetterQueue);

      const missionId = "mission-crashed-worker";

      // Setup running mission
      await eventStore.append({
        missionId,
        type: "mission.created",
        expectedVersion: 0,
        correlationId: "corr-recon",
        payload: {},
      });
      await eventStore.append({
        missionId,
        type: "mission.started",
        expectedVersion: 1,
        correlationId: "corr-recon",
        payload: {},
      });

      // Acquire lease with 1ms TTL (expired immediately)
      await leaseManager.acquire(missionId, "worker-dead", 1);
      await new Promise((r) => setTimeout(r, 10));

      const report = await engine.runSinglePass();
      expect(report.expiredLeasesDetected).toBe(1);
      expect(report.reconciledMissions).toBe(1);

      // Verify event store has the recovery failure event
      const updatedEvents = await eventStore.getEvents(missionId);
      const projection = projectMission(updatedEvents);
      expect(projection?.phase).toBe("failed");
      expect(projection?.failureReason).toContain("crash recovery");
    });
  });
});
