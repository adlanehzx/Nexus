import { describe, expect, it } from "vitest";
import { WORKER_MESSAGE } from "@nexus/protocol";
import { createTaskPlan } from "@nexus/devices";
import { makeHarness, until, ALLOWED_ROOT, IPHONE, USER_ID } from "./fixtures.js";

/**
 * Long outages.
 *
 * A three-second outage proves nothing: everything survives three seconds.
 * What breaks a worker is a **prolonged** outage — the laptop closed for a night,
 * Wi-Fi cut off during a meeting, the core rebooted for a migration.
 * During this time, time passes *on the core side*: sessions expire, the device
 * transitions to offline, nonces age. The worker simply waits.
 *
 * This gap is tested here, which is why the harness has two clocks: the core's
 * clock, which is advanced, and the worker timers, which are triggered.
 */

const PERMISSIONS = ["terminal.execute", "filesystem.read"];

/** Selects messages of a given type emitted by the worker. */
const sent = (harness: Awaited<ReturnType<typeof makeHarness>>, type: string) =>
  harness.link.sent.filter((envelope) => envelope.type === type);

/**
 * A "long" outage.
 *
 * Long **relative to the session lifetime**, which is what matters: tests set this
 * duration to 40 ms and wait 80 ms, so the session truly expires in real time.
 *
 * The temptation was to advance a clock by ten hours. That does not work, and the
 * reason is instructive: the worker signs its frames with its own clock, and the
 * gateway rejects a handshake whose timestamp drifts too far. Advancing the core
 * clock would make recovery fail due to clock drift — a valid rejection, but not
 * the subject of this test.
 */
const SESSION_TTL_MS = 40;
const outage = () => new Promise((resolve) => setTimeout(resolve, SESSION_TTL_MS * 2));

describe("recovery after a long outage", () => {
  it("reconnects with a full handshake, not an expired session", async () => {
    const harness = await makeHarness({
      sessionTtlMs: SESSION_TTL_MS,
      rotateConnections: true,
    });
    await harness.connectWorker();
    expect(harness.worker.state).toBe("ready");

    const firstHandshakes = sent(harness, WORKER_MESSAGE.authenticate).length;
    expect(firstHandshakes).toBe(1);

    // ── The outage: an entire night.
    await harness.dropLink();
    await outage();

    // The worker reconnects when its timer expires. We wait for the handshake to
    // restart, rather than checking state: "reconnecting" is true from the first
    // millisecond, so waiting for it waits for nothing.
    harness.timers.flush();
    await until(() => sent(harness, WORKER_MESSAGE.authenticate).length > firstHandshakes);
    await until(() => harness.worker.state === "ready");

    // The point: it re-signed a challenge. Reusing yesterday's session token would
    // be useless — it expired core-side — and the worker must not discover this on
    // first dispatch, which is the worst time.
    expect(sent(harness, WORKER_MESSAGE.authenticate).length).toBe(firstHandshakes + 1);
    expect(harness.worker.state).toBe("ready");
  });

  it("finds the device online and capable of working", async () => {
    const harness = await makeHarness({
      sessionTtlMs: SESSION_TTL_MS,
      rotateConnections: true,
    });
    await harness.connectWorker();

    await harness.dropLink();
    // The core must see the device offline: a device believed online would be
    // assigned tasks that never arrive.
    await until(
      async () => (await harness.registry.requireDevice(harness.device.id)).status !== "ONLINE",
    );

    await outage();
    harness.timers.flush();
    await until(() => harness.worker.state === "ready");
    // Registration following handshake puts the device back online: waiting for
    // it prevents observing an intermediate state.
    await until(() => sent(harness, WORKER_MESSAGE.register).length >= 2);

    const device = await harness.registry.requireDevice(harness.device.id);
    expect(device.status).toBe("ONLINE");
    expect(device.trust).toBe("TRUSTED");
    // Trust does not need to be regranted: an outage is not a fault.
    expect(device.revokedAt).toBeNull();
  });

  it("executes a plan after recovery, as if nothing happened", async () => {
    const harness = await makeHarness({
      sessionTtlMs: SESSION_TTL_MS,
      rotateConnections: true,
      seed: ({ fileSystem }) => {
        fileSystem.files.set(`${ALLOWED_ROOT}\\note.txt`, "after the night");
      },
    });
    await harness.connectWorker();
    await harness.attachClient();

    await harness.dropLink();
    await outage();
    harness.timers.flush();
    await until(() => harness.worker.state === "ready");
    await until(() => sent(harness, WORKER_MESSAGE.register).length >= 2);

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "Reread the note",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-after-outage",
      steps: [
        {
          id: "read",
          description: "Read the file",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          arguments: { path: `${ALLOWED_ROOT}\\note.txt` },
          riskLevel: "SAFE",
        },
      ],
    });

    const executed = await harness.coordinator.execute(plan, { userPermissions: PERMISSIONS });
    expect(executed.status).toBe("succeeded");
    expect(executed.steps[0]?.selectedDeviceId).toBe(harness.device.id);
    expect((executed.steps[0]?.result as { content: string }).content).toBe("after the night");
  });

  it("does not flood the core: backoff increases and caps", async () => {
    const harness = await makeHarness({
      config: { reconnectMinMs: 1_000, reconnectMaxMs: 60_000 },
      rotateConnections: true,
    });
    await harness.connectWorker();

    const delays: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await harness.dropLink();
      // Next connect fails: we simulate an ongoing outage, not brief hiccups.
      harness.link.failNextConnect = true;
      const scheduled = harness.timers.delays.at(-1);
      if (scheduled !== undefined) delays.push(scheduled);
      harness.timers.flush();
      await until(() => harness.worker.state !== "connecting");
    }

    expect(delays.length).toBeGreaterThan(3);
    // Without backoff, a rebooting core is brought down by its own workers;
    // without a ceiling, an idle worker would wait hours.
    expect(Math.max(...delays)).toBeLessThanOrEqual(60_000);
    expect(Math.max(...delays)).toBeGreaterThan(Math.min(...delays));
  });

  it("nonce from before the outage is no longer used afterwards", async () => {
    const harness = await makeHarness({
      sessionTtlMs: SESSION_TTL_MS,
      rotateConnections: true,
    });
    await harness.connectWorker();

    const first = sent(harness, WORKER_MESSAGE.authenticate)[0];
    const firstNonce = (first?.payload as { nonce?: string } | undefined)?.nonce;
    expect(firstNonce).toBeTruthy();

    await harness.dropLink();
    await outage();
    harness.timers.flush();
    await until(() => harness.worker.state === "ready");

    const second = sent(harness, WORKER_MESSAGE.authenticate).at(-1);
    const secondNonce = (second?.payload as { nonce?: string } | undefined)?.nonce;
    // A replayable nonce would turn a frame captured during the outage into a valid session after it.
    expect(secondNonce).toBeTruthy();
    expect(secondNonce).not.toBe(firstNonce);
  });

  it("a task assigned during outage fails clearly instead of disappearing", async () => {
    const harness = await makeHarness({
      sessionTtlMs: SESSION_TTL_MS,
      rotateConnections: true,
    });
    await harness.connectWorker();
    await harness.attachClient();

    await harness.dropLink();
    await until(
      async () => (await harness.registry.requireDevice(harness.device.id)).status !== "ONLINE",
    );

    const plan = createTaskPlan({
      userId: USER_ID,
      title: "During outage",
      originClientDeviceId: IPHONE.id,
      correlationId: "corr-during-outage",
      steps: [
        {
          id: "read",
          description: "Read the file",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          arguments: { path: `${ALLOWED_ROOT}\\absent.txt` },
          riskLevel: "SAFE",
        },
      ],
    });

    // The core has no eligible worker. It must report it: a plan that remains
    // "in progress" indefinitely is the worst response, because no one knows
    // whether to wait or retry.
    const executed = await harness.coordinator.execute(plan, { userPermissions: PERMISSIONS });
    expect(executed.status).toBe("failed");
    expect(JSON.stringify(executed.steps[0]?.error)).toMatch(/eligible|online|worker/i);
  });
});
