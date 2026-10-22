import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, reduce, resyncTasks, type ClientState } from "@nexus/client-core";
import type { LLMProvider } from "@nexus/llm";
import { mountClient, mountWorker, type ClientRig, type WorkerRig } from "./laptop.js";
import {
  createAccount,
  makeApi,
  registerDevice,
  settle,
  until,
  type Account,
  type ApiHarness,
  type RegisteredDevice,
} from "./harness.js";

/**
 * Real clients driving the core.
 *
 * Verifies end-to-end execution:
 * client -> core -> planner -> authorization -> supervisor
 *        -> gateway -> worker -> result -> core -> client
 */

/**
 * Mock planner.
 *
 * Returns a deterministic plan to open Chrome on a workstation.
 */
function fakePlanner(step: { capability: string; tool: string; riskLevel: string }) {
  return {
    id: "fake",
    model: "fake",
    capabilities: {
      tools: false,
      vision: false,
      structuredOutput: true,
      maxContextTokens: 100_000,
    },
    countTokens: () => Promise.resolve(10),
    structuredOutput: <T>(): Promise<T> =>
      Promise.resolve({
        title: "Open Chrome",
        reasoning: "User request",
        steps: [
          {
            id: "step-1",
            description: "Opens Chrome",
            requiredCapabilities: [step.capability],
            tool: step.tool,
            arguments: { app: "chrome" },
            dependsOn: [],
            riskLevel: step.riskLevel,
          },
        ],
      } as unknown as T),
    generate: () =>
      Promise.resolve({
        content: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "fake",
      }),
    // eslint-disable-next-line @typescript-eslint/require-await
    stream: async function* () {
      yield { type: "text_delta", delta: "" } as never;
    },
  } as unknown as LLMProvider;
}

interface Rig {
  harness: ApiHarness;
  account: Account;
  iphone: RegisteredDevice;
  desktop: RegisteredDevice;
  client: ClientRig;
  api: ApiClient;
  worker: WorkerRig;
}

const GRANTED = ["app.open", "terminal.execute"];

async function boot(
  options: {
    capability?: string;
    riskLevel?: string;
    confirmationThreshold?: "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    permissions?: string[];
  } = {},
): Promise<Rig> {
  const capability = options.capability ?? "app.open";

  const harness = await makeApi({
    llmProvider: fakePlanner({
      capability,
      tool: `device.${capability}`,
      riskLevel: options.riskLevel ?? "LOW",
    }),
    ...(options.confirmationThreshold === undefined
      ? {}
      : { confirmationThreshold: options.confirmationThreshold }),
  });

  const account = await createAccount(harness);
  const permissions = options.permissions ?? GRANTED;

  const iphone = await registerDevice(harness, account, {
    name: "iPhone 17",
    role: "CLIENT",
    type: "IPHONE",
    platform: "IOS",
    permissions,
  });
  const desktop = await registerDevice(harness, account, {
    name: "Desktop Workstation",
    role: "WORKER",
    permissions,
  });

  const client = await mountClient(harness, account, iphone);
  const api = new ApiClient(client.session);

  const worker = mountWorker(harness, desktop, {
    capabilities: [capability],
    connectionId: "conn-desktop",
  });
  await worker.runtime.start();

  await until(async () => {
    const device = await harness.services.deviceRegistry.requireDevice(desktop.device.id);
    return device.capabilities.length > 0;
  });

  return { harness, account, iphone, desktop, client, api, worker };
}

let rig: Rig | undefined;

beforeEach(() => {
  rig = undefined;
});

afterEach(async () => {
  await rig?.harness.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// Full path
// ─────────────────────────────────────────────────────────────────────────────

describe("client instruction controls the fleet", () => {
  it('"open Chrome on my PC" really reaches the worker', async () => {
    rig = await boot();

    const plan = await rig.api.instruct({
      instruction: "open Chrome on my PC",
      originClientDeviceId: rig.iphone.device.id,
    });

    expect(plan.id).toBeTruthy();
    expect(plan.originClientDeviceId).toBe(rig.iphone.device.id);

    await until(() => rig!.worker.executed.length > 0);

    expect(rig.worker.executed[0]?.capability).toBe("app.open");
    expect(rig.worker.executed[0]?.input).toMatchObject({ app: "chrome" });
  });

  it("client receives task state until completion", async () => {
    rig = await boot();

    await rig.api.instruct({
      instruction: "open Chrome",
      originClientDeviceId: rig.iphone.device.id,
    });

    await until(() => rig!.client.state().tasks.some((task) => task.status === "succeeded"));

    const task = rig.client.state().tasks[0];
    expect(task?.status).toBe("succeeded");
    expect(task?.percent).toBe(100);
    expect(task?.originClientDeviceId).toBe(rig.iphone.device.id);
  });

  it("client neither plans nor executes: it transmits a sentence", async () => {
    rig = await boot();

    const plan = await rig.api.instruct({
      instruction: "open Chrome on my PC",
      originClientDeviceId: rig.iphone.device.id,
    });

    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps[0]?.description).toBeTruthy();
    expect(plan.steps[0]?.selectedDeviceId ?? rig.desktop.device.id).toBe(rig.desktop.device.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authorization: no bypass from a client
// ─────────────────────────────────────────────────────────────────────────────

describe("no bypass from a client", () => {
  it("instruction whose capability is not granted is rejected", async () => {
    rig = await boot({ capability: "terminal.execute", permissions: ["app.open"] });

    await expect(
      rig.api.instruct({
        instruction: "run a command",
        originClientDeviceId: rig.iphone.device.id,
      }),
    ).rejects.toThrow();

    await settle(20);
    expect(rig.worker.executed).toEqual([]);
  });

  it("a client cannot impersonate another device", async () => {
    rig = await boot();

    await expect(
      rig.api.instruct({
        instruction: "open Chrome",
        originClientDeviceId: "unknown-device",
      }),
    ).rejects.toThrow();
  });

  it("risky action awaits human confirmation before reaching worker", async () => {
    rig = await boot({ riskLevel: "CRITICAL", confirmationThreshold: "MEDIUM" });

    await rig.api.instruct({
      instruction: "delete everything",
      originClientDeviceId: rig.iphone.device.id,
    });

    await until(() => rig!.client.state().confirmations.length > 0);

    const confirmation = rig.client.state().confirmations[0];
    expect(confirmation?.riskLevel).toBe("CRITICAL");
    expect(confirmation?.answered).toBe(false);

    await settle(20);
    expect(rig.worker.executed).toEqual([]);
  });

  it("rejection of confirmation prevents execution", async () => {
    rig = await boot({ riskLevel: "CRITICAL", confirmationThreshold: "MEDIUM" });

    await rig.api.instruct({
      instruction: "delete everything",
      originClientDeviceId: rig.iphone.device.id,
    });
    await until(() => rig!.client.state().confirmations.length > 0);

    const id = rig.client.state().confirmations[0]!.id;
    await rig.client.realtime.respondToConfirmation(id, "rejected");

    await settle(30);
    expect(rig.worker.executed).toEqual([]);
  });

  it("approved confirmation lets execution resume", async () => {
    rig = await boot({ riskLevel: "CRITICAL", confirmationThreshold: "MEDIUM" });

    await rig.api.instruct({
      instruction: "open Chrome",
      originClientDeviceId: rig.iphone.device.id,
    });
    await until(() => rig!.client.state().confirmations.length > 0);

    const id = rig.client.state().confirmations[0]!.id;
    await rig.client.realtime.respondToConfirmation(id, "approved");

    await until(() => rig!.worker.executed.length > 0);
    expect(rig.worker.executed[0]?.capability).toBe("app.open");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotence from client perspective
// ─────────────────────────────────────────────────────────────────────────────

describe("idempotence from client perspective", () => {
  it("reconnection does not rerun any instruction", async () => {
    rig = await boot();

    await rig.api.instruct({
      instruction: "open Chrome",
      originClientDeviceId: rig.iphone.device.id,
    });
    await until(() => rig!.worker.executed.length > 0);

    const before = rig.worker.executed.length;

    rig.client.socket.close("network drop");
    await settle(20);
    await rig.client.realtime.start();
    await settle(30);

    expect(rig.worker.executed).toHaveLength(before);
    expect(rig.client.state().tasks).toHaveLength(1);
  });

  it("two identical instructions create two distinct tasks by design", async () => {
    rig = await boot();

    const first = await rig.api.instruct({
      instruction: "open Chrome",
      originClientDeviceId: rig.iphone.device.id,
    });
    const second = await rig.api.instruct({
      instruction: "open Chrome",
      originClientDeviceId: rig.iphone.device.id,
    });

    expect(first.id).not.toBe(second.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Resync after disconnect
// ─────────────────────────────────────────────────────────────────────────────

describe("resync after disconnect", () => {
  it("client recovers completed task state from core after offline period", async () => {
    rig = await boot();

    const plan = await rig.api.instruct({
      instruction: "open Chrome",
      originClientDeviceId: rig.iphone.device.id,
    });

    rig.client.socket.close("tunnel");
    await until(() => rig!.worker.executed.length > 0);
    await settle(30);

    const fromCore = await rig.api.getTask(plan.id);
    expect(fromCore.status).toBe("succeeded");

    let state: ClientState = {
      ...rig.client.state(),
      tasks: [
        {
          id: plan.id,
          title: plan.title,
          status: "running",
          percent: 40,
          label: "running",
          workerDeviceId: null,
          originClientDeviceId: rig.iphone.device.id,
          startedAt: null,
          completedAt: null,
          durationMs: null,
          error: null,
          stepCount: 1,
        },
      ],
    };

    const outcome = await resyncTasks({
      api: rig.api,
      state,
      dispatch: (action) => {
        state = reduce(state, action);
      },
    });

    expect(outcome.checked).toBe(1);
    expect(outcome.updated).toBe(1);
    expect(state.tasks[0]?.status).toBe("succeeded");
    expect(state.tasks[0]?.percent).toBe(100);
    expect(state.tasks).toHaveLength(1);
  });
});
