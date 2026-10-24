import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api.js";
import { InMemoryOutboxStore } from "../src/outbox.js";
import { OfflineResyncEngine } from "../src/offline/resync-engine.js";
import type { ClientAction, ClientState } from "../src/store.js";

describe("Offline Resync Engine", () => {
  it("flushes outbox, drops expired entries, and reconciles task states", async () => {
    const outboxStore = new InMemoryOutboxStore();
    const now = 1_700_000_000_000;

    // Enqueue 2 entries: one valid, one expired
    await outboxStore.save([
      {
        id: "out_valid",
        request: { method: "POST", path: "/api/v1/missions", body: {} },
        idempotencyKey: "idem_valid_1",
        createdAt: now - 1000,
        expiresAt: now + 60_000, // valid
        attempts: 0,
        lastError: null,
      },
      {
        id: "out_expired",
        request: { method: "POST", path: "/api/v1/missions", body: {} },
        idempotencyKey: "idem_expired_2",
        createdAt: now - 100_000,
        expiresAt: now - 10_000, // EXPIRED
        attempts: 1,
        lastError: null,
      },
    ]);

    const mockApi: Pick<ApiClient, "getTask"> = {
      getTask: vi.fn().mockResolvedValue({
        id: "task_active_1",
        title: "Database Backup",
        status: "succeeded", // server finished it!
        originClientDeviceId: "dev_phone",
        steps: [
          {
            id: "step_1",
            description: "Dump DB",
            status: "succeeded",
            selectedDeviceId: "dev_server",
            riskLevel: "low",
            error: null,
          },
        ],
        createdAt: new Date(now - 5000).toISOString(),
        startedAt: new Date(now - 4000).toISOString(),
        completedAt: new Date(now - 1000).toISOString(),
      }),
    };

    const dispatched: ClientAction[] = [];
    const dispatch = (action: ClientAction) => dispatched.push(action);

    const engine = new OfflineResyncEngine({
      api: mockApi,
      outboxStore,
      dispatch,
      now: () => now,
    });

    const state: ClientState = {
      user: { id: "u1", email: "user@test.local", displayName: "User", role: "ADMIN" },
      session: { state: "authenticated", authenticated: true, activeToken: "tok" },
      tasks: [
        {
          id: "task_active_1",
          title: "Database Backup",
          status: "running", // Client still thought it was running
          stepCount: 1,
          startedAt: new Date(now - 4000).toISOString(),
          completedAt: null,
          error: null,
        },
      ],
      notifications: [],
      devices: [],
      errorBanner: null,
    };

    const outcome = await engine.executeFullResync(state);
    expect(outcome.flushedOutbox).toBe(1);
    expect(outcome.expiredOutbox).toBe(1);
    expect(outcome.reconciledTasks).toBe(1);
    expect(outcome.conflictsResolved).toBe(1);

    // Verify taskSync action dispatched to update client store
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]?.kind).toBe("taskSync");
    if (dispatched[0]?.kind === "taskSync") {
      expect(dispatched[0].task.status).toBe("succeeded");
    }
  });

  it("triggers credential purge when server reports device revocation during outage", async () => {
    const outboxStore = new InMemoryOutboxStore();
    const onRevocation = vi.fn().mockResolvedValue(undefined);

    const mockApi: Pick<ApiClient, "getTask"> = {
      getTask: vi.fn().mockRejectedValue({
        httpStatus: 403,
        message: "Device revoked by administrator.",
      }),
    };

    const engine = new OfflineResyncEngine({
      api: mockApi,
      outboxStore,
      dispatch: vi.fn(),
      onRevocationDetected: onRevocation,
    });

    const state: ClientState = {
      user: { id: "u1", email: "user@test.local", displayName: "User", role: "ADMIN" },
      session: { state: "authenticated", authenticated: true, activeToken: "tok" },
      tasks: [
        {
          id: "task_1",
          title: "Pending Task",
          status: "pending",
          stepCount: 0,
          startedAt: null,
          completedAt: null,
          error: null,
        },
      ],
      notifications: [],
      devices: [],
      errorBanner: null,
    };

    const outcome = await engine.executeFullResync(state);
    expect(outcome.deviceRevoked).toBe(true);
    expect(onRevocation).toHaveBeenCalledTimes(1);
  });
});
