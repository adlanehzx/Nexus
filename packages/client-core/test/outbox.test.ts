import { describe, expect, it } from "vitest";
import { InMemoryOutboxStore, NotQueueableError, Outbox, type OutboxEntry } from "../src/outbox.js";

/**
 * An offline queue can easily duplicate actions. These tests verify:
 * idempotency keys, order preservation, stopping on first failure, expiration,
 * and rejection of non-queueable requests.
 */

const MESSAGE = {
  method: "POST" as const,
  path: "/api/v1/orchestrator/messages",
  body: { message: "hello" },
};

function outbox(options: { ttlMs?: number; capacity?: number; now?: () => number } = {}) {
  const store = new InMemoryOutboxStore();
  let counter = 0;
  const queue = new Outbox({
    store,
    idempotentPaths: ["/api/v1/orchestrator/messages"],
    newId: () => {
      counter += 1;
      return `id-${String(counter)}`;
    },
    ...options,
  });
  return { queue, store };
}

const ok = () => Promise.resolve({ ok: true as const });

describe("what can wait for the network", () => {
  it("accepts a path that the server can deduplicate", async () => {
    const { queue } = outbox();
    const entry = await queue.enqueue(MESSAGE);
    expect(entry.idempotencyKey).toBeTruthy();
    expect(await queue.pending()).toHaveLength(1);
  });

  it("rejects a path whose key is not honored", async () => {
    const { queue } = outbox();
    const verdict = queue.queueable({ method: "POST", path: "/api/v1/tasks", body: {} });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("repeated requests");
    await expect(
      queue.enqueue({ method: "POST", path: "/api/v1/tasks", body: {} }),
    ).rejects.toBeInstanceOf(NotQueueableError);
  });

  it("rejects a confirmation, even on an idempotent path", () => {
    const { queue } = outbox();
    for (const path of [
      "/api/v1/confirmations/abc/respond",
      "/api/v1/agent-core/runs/abc/confirmation",
    ]) {
      expect(queue.queueable({ method: "POST", path, body: {} }).ok, path).toBe(false);
    }
  });
});

describe("idempotency key", () => {
  it("does not change across retry attempts", async () => {
    const { queue } = outbox();
    await queue.enqueue(MESSAGE);

    const keys: string[] = [];
    const failing = (entry: OutboxEntry) => {
      keys.push(entry.idempotencyKey);
      return Promise.resolve({ ok: false as const, retryable: true, error: "network" });
    };

    await queue.flush(failing);
    await queue.flush(failing);
    await queue.flush(failing);

    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it("differs between distinct entries", async () => {
    const { queue } = outbox();
    const first = await queue.enqueue(MESSAGE);
    const second = await queue.enqueue(MESSAGE);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });
});

describe("sending", () => {
  it("respects order", async () => {
    const { queue } = outbox();
    await queue.enqueue({ ...MESSAGE, body: { message: "one" } });
    await queue.enqueue({ ...MESSAGE, body: { message: "two" } });

    const order: unknown[] = [];
    await queue.flush((entry) => {
      order.push((entry.request.body as { message: string }).message);
      return ok();
    });
    expect(order).toEqual(["one", "two"]);
  });

  it("stops at the first retryable failure", async () => {
    const { queue } = outbox();
    await queue.enqueue({ ...MESSAGE, body: { message: "one" } });
    await queue.enqueue({ ...MESSAGE, body: { message: "two" } });

    let calls = 0;
    const outcome = await queue.flush(() => {
      calls += 1;
      return Promise.resolve({ ok: false as const, retryable: true, error: "network" });
    });

    expect(calls).toBe(1);
    expect(outcome.stoppedBy).toBe("error");
    expect(outcome.remaining).toHaveLength(2);
    expect(outcome.remaining[0]?.lastError).toBe("network");
  });

  it("discards permanent failures to avoid blocking the queue", async () => {
    const { queue } = outbox();
    await queue.enqueue({ ...MESSAGE, body: { message: "invalid" } });
    await queue.enqueue({ ...MESSAGE, body: { message: "valid" } });

    const sent: string[] = [];
    const outcome = await queue.flush((entry) => {
      const message = (entry.request.body as { message: string }).message;
      if (message === "invalid") {
        return Promise.resolve({ ok: false as const, retryable: false, error: "400" });
      }
      sent.push(message);
      return ok();
    });

    expect(sent).toEqual(["valid"]);
    expect(outcome.remaining).toHaveLength(0);
  });

  it("does not send anything when offline", async () => {
    const { queue } = outbox();
    await queue.enqueue(MESSAGE);
    let calls = 0;
    const outcome = await queue.flush(
      () => {
        calls += 1;
        return ok();
      },
      { online: false },
    );

    expect(calls).toBe(0);
    expect(outcome.stoppedBy).toBe("offline");
    expect(outcome.remaining).toHaveLength(1);
  });

  it("counts attempts", async () => {
    const { queue } = outbox();
    await queue.enqueue(MESSAGE);
    const fail = () => Promise.resolve({ ok: false as const, retryable: true, error: "network" });
    await queue.flush(fail);
    const outcome = await queue.flush(fail);
    expect(outcome.remaining[0]?.attempts).toBe(2);
  });
});

describe("expiration", () => {
  it("does not send an intention whose context has expired", async () => {
    let instant = 1_000;
    const { queue } = outbox({ now: () => instant, ttlMs: 60_000 });
    await queue.enqueue(MESSAGE);

    instant += 60_001;
    let calls = 0;
    const outcome = await queue.flush(() => {
      calls += 1;
      return ok();
    });

    expect(calls).toBe(0);
    expect(outcome.expired).toHaveLength(1);
    expect(outcome.remaining).toHaveLength(0);
  });

  it("disappears from pending queue before being sent", async () => {
    let instant = 1_000;
    const { queue } = outbox({ now: () => instant, ttlMs: 60_000 });
    await queue.enqueue(MESSAGE);
    expect(await queue.pending()).toHaveLength(1);
    instant += 60_001;
    expect(await queue.pending()).toHaveLength(0);
  });
});

describe("capacity", () => {
  it("evicts oldest entries when full", async () => {
    const { queue } = outbox({ capacity: 2 });
    await queue.enqueue({ ...MESSAGE, body: { message: "one" } });
    await queue.enqueue({ ...MESSAGE, body: { message: "two" } });
    await queue.enqueue({ ...MESSAGE, body: { message: "three" } });

    const pending = await queue.pending();
    expect(pending.map((entry) => (entry.request.body as { message: string }).message)).toEqual([
      "two",
      "three",
    ]);
  });
});

describe("sign out", () => {
  it("clears the queue as it belongs to a session", async () => {
    const { queue } = outbox();
    await queue.enqueue(MESSAGE);
    await queue.clear();
    expect(await queue.pending()).toHaveLength(0);
  });
});
