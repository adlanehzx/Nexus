import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SERVER_TO_CLIENT } from "@nexus/protocol";
import { settle } from "./harness.js";
import { GRANTED, bootFleet, planFor, runPlan, waitFor, type Fleet } from "./fleet.js";

/**
 * End-to-end validation.
 *
 * Seven scenarios played across the full fleet: iPhone, laptop, desktop,
 * Redmi, and core. Real code across all five sides — clients, workers,
 * coordinator, selector, confirmations. See `fleet.ts` for what is stubbed
 * and what is real.
 *
 * **Stated limit upfront**: there is no wired language model. The
 * scenarios start from the plan that the prompt denotes, not the prompt itself.
 * Everything that follows — selection, authorization, dispatch, execution, progress,
 * notification, synchronization — is real.
 */

let fleet: Fleet;

beforeEach(async () => {
  fleet = await bootFleet();
});

afterEach(async () => {
  await fleet.close();
});

/** Do both clients converge to the same task state? */
async function bothClientsSee(taskId: string, status: string): Promise<void> {
  await waitFor(
    () =>
      fleet.iphone.state().tasks.find((task) => task.id === taskId)?.status === status &&
      fleet.laptop.state().tasks.find((task) => task.id === taskId)?.status === status,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// E2E 1 — "Open Chrome on my desktop PC and go to Google."
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E 1 — from iPhone, open a browser on desktop workstation", () => {
  it("traverses the entire chain and returns to the iPhone", async () => {
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Open Chrome on desktop workstation",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "open",
          description: "Open Google in browser",
          // The selector only knows capabilities. Never a machine name.
          requiredCapabilities: ["browser.open"],
          tool: "device.browser.open",
          arguments: { url: "https://www.google.com" },
          // "on my desktop PC" becomes a weighted preference.
          preferredDeviceId: fleet.devices.desktop.device.id,
          riskLevel: "LOW",
        },
      ],
    });

    runPlan(fleet, plan);

    // 1. The step reaches the desktop workstation — and only it.
    await waitFor(() => fleet.desktop.executed.length > 0);
    expect(fleet.desktop.executed[0]?.capability).toBe("browser.open");
    expect(fleet.desktop.executed[0]?.input).toMatchObject({ url: "https://www.google.com" });
    expect(fleet.laptopWorker.executed).toEqual([]);
    expect(fleet.redmi.executed).toEqual([]);

    // 2. The iPhone sees the task succeed.
    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "succeeded");

    const task = fleet.iphone.state().tasks[0];
    expect(task?.title).toBe("Open Chrome on desktop workstation");
    // 3. Routing trace holds end-to-end.
    expect(task?.originClientDeviceId).toBe(fleet.devices.iphone.device.id);
    // 4. The iPhone knows where it ran.
    expect(task?.workerDeviceId).toBe(fleet.devices.desktop.device.id);

    // 5. And it receives the notification produced centrally.
    await waitFor(() => fleet.iphone.state().notifications.length > 0);
    expect(fleet.iphone.state().notifications[0]?.title).toBeTruthy();
  });

  it("preference does not bypass capability", async () => {
    // Security premise of scenario: "On my desktop PC" is a preference, not a command.
    // A preferred device lacking the capability remains excluded. Otherwise, naming
    // a machine would become a way to execute undeclared capabilities.
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Open Android application",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "open",
          description: "Open an application",
          requiredCapabilities: ["android.app.open"],
          tool: "device.android.app.open",
          arguments: { package: "com.google.android.youtube" },
          // The user designates desktop workstation, which lacks this capability.
          preferredDeviceId: fleet.devices.desktop.device.id,
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => fleet.redmi.executed.length > 0);

    // Redmi executed; desktop workstation saw nothing.
    expect(fleet.redmi.executed[0]?.capability).toBe("android.app.open");
    expect(fleet.desktop.executed).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E 2 — "Open YouTube on my Redmi."
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E 2 — from laptop, act on Redmi", () => {
  it("reaches phone and synchronizes to iPhone", async () => {
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Open YouTube on Redmi",
      originClientDeviceId: fleet.devices.laptop.device.id,
      steps: [
        {
          id: "youtube",
          description: "Open YouTube",
          requiredCapabilities: ["android.app.open"],
          tool: "device.android.app.open",
          arguments: { package: "com.google.android.youtube" },
          riskLevel: "LOW",
        },
      ],
    });

    runPlan(fleet, plan);

    await waitFor(() => fleet.redmi.executed.length > 0);
    expect(fleet.redmi.executed[0]?.input).toMatchObject({
      package: "com.google.android.youtube",
    });

    // Laptop initiated — and iPhone, which requested nothing, sees same task with same origin.
    // This is central synchronization.
    await bothClientsSee(plan.id, "succeeded");

    const onIphone = fleet.iphone.state().tasks.find((task) => task.id === plan.id);
    expect(onIphone?.originClientDeviceId).toBe(fleet.devices.laptop.device.id);
    expect(onIphone?.workerDeviceId).toBe(fleet.devices.redmi.device.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E 3 — "Start my project and notify me when the server is ready."
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E 3 — server startup with progress reports", () => {
  it("chains read then startup, and reports progress", async () => {
    await fleet.close();
    fleet = await bootFleet({
      behaviours: {
        desktop: {
          // Server startup is not instantaneous: it reports progress.
          "process.start": (input, context) => {
            context.onProgress({ percent: 30, label: "installing dependencies" });
            context.onProgress({ percent: 80, label: "compiling" });
            return Promise.resolve({ pid: 4242, port: 3000, ready: true, input });
          },
        },
      },
    });

    const plan = planFor({
      userId: fleet.account.userId,
      title: "Start project on desktop workstation",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "read",
          description: "Read project configuration",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          arguments: { path: "C:\\Projects\\leynai\\package.json" },
          preferredDeviceId: fleet.devices.desktop.device.id,
          riskLevel: "SAFE",
        },
        {
          id: "start",
          description: "Start development server",
          requiredCapabilities: ["process.start"],
          tool: "device.process.start",
          arguments: { executable: "pnpm", args: ["dev"] },
          dependsOn: ["read"],
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);

    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "succeeded");

    const task = fleet.iphone.state().tasks[0];
    expect(task?.status).toBe("succeeded");
    expect(task?.percent).toBe(100);
    expect(task?.stepCount).toBe(2);

    // Both steps ran on desktop workstation, in order.
    expect(fleet.desktop.executed.map((entry) => entry.capability)).toEqual([
      "filesystem.read",
      "process.start",
    ]);

    // iPhone was notified of completion.
    await waitFor(() => fleet.iphone.state().notifications.length > 0);
  });

  it("iPhone receives progress during execution", async () => {
    // Scenario premise: user watches phone and wants to know progress, not just completion.
    const progressActions = fleet.iphone.actions.filter(
      (action) => action.kind === "server" && action.type === SERVER_TO_CLIENT.taskProgress,
    );
    expect(progressActions).toHaveLength(0);

    const plan = planFor({
      userId: fleet.account.userId,
      title: "Sequential steps",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "a",
          description: "First",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          preferredDeviceId: fleet.devices.desktop.device.id,
          riskLevel: "SAFE",
        },
        {
          id: "b",
          description: "Second",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          dependsOn: ["a"],
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "succeeded");

    const received = fleet.iphone.actions.filter(
      (action) => action.kind === "server" && action.type === SERVER_TO_CLIENT.taskProgress,
    );
    expect(received.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E 4 — "Run tests on my laptop."
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E 4 — iPhone runs execution on laptop", () => {
  it("laptop executes and iPhone receives result", async () => {
    await fleet.close();
    fleet = await bootFleet({
      behaviours: {
        laptop: {
          "terminal.execute": (input) =>
            Promise.resolve({ exitCode: 0, stdout: "1072 tests passed", input }),
        },
      },
    });

    const plan = planFor({
      userId: fleet.account.userId,
      title: "Run tests on laptop",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "tests",
          description: "Execute test suite",
          requiredCapabilities: ["terminal.execute"],
          tool: "device.terminal.execute",
          arguments: { executable: "pnpm", args: ["test"] },
          preferredDeviceId: fleet.devices.laptop.device.id,
          riskLevel: "LOW",
        },
      ],
    });

    runPlan(fleet, plan);

    await waitFor(() => fleet.laptopWorker.executed.length > 0);
    expect(fleet.laptopWorker.executed[0]?.input).toMatchObject({ executable: "pnpm" });

    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "succeeded");
    expect(fleet.iphone.state().tasks[0]?.workerDeviceId).toBe(fleet.devices.laptop.device.id);

    // The result is indeed what machine produced, recorded centrally.
    const executions = await fleet.harness.services.taskStore.listExecutions(plan.id);
    expect(executions[0]?.result).toMatchObject({ exitCode: 0 });
  });

  it("laptop is both client and worker simultaneously", () => {
    // Two channels, two secrets, a single device record.
    expect(fleet.laptop.realtime.state).toBe("connected");
    expect(fleet.harness.services.gateway.isConnected(fleet.devices.laptop.device.id)).toBe(true);
    expect(fleet.harness.app.clientChannel.connectedDeviceIds).toContain(
      fleet.devices.laptop.device.id,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E 5 — Two machines, one dependency
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E 5 — multi-machine plan with dependency", () => {
  it("downloads on desktop workstation then opens on Redmi, in that order", async () => {
    const order: string[] = [];

    await fleet.close();
    fleet = await bootFleet({
      behaviours: {
        desktop: {
          "git.clone": () => {
            order.push("desktop");
            return Promise.resolve({ cloned: true });
          },
        },
        redmi: {
          "android.app.open": () => {
            order.push("redmi");
            return Promise.resolve({ opened: true });
          },
        },
      },
    });

    const plan = planFor({
      userId: fleet.account.userId,
      title: "Download then open",
      originClientDeviceId: fleet.devices.laptop.device.id,
      steps: [
        {
          id: "download",
          description: "Clone project",
          requiredCapabilities: ["git.clone"],
          tool: "device.git.clone",
          arguments: { url: "https://example.com/project.git" },
          riskLevel: "SAFE",
        },
        {
          id: "open",
          description: "Open application on phone",
          requiredCapabilities: ["android.app.open"],
          tool: "device.android.app.open",
          arguments: { package: "com.example.app" },
          dependsOn: ["download"],
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => order.length === 2);

    // Dependency is respected: the second step did not start before the first completed,
    // and they are on two different machines.
    expect(order).toEqual(["desktop", "redmi"]);

    // Selector chose each machine based on capability, without naming them.
    const executed = await fleet.harness.services.taskStore.listExecutions(plan.id);
    const byStep = new Map(executed.map((entry) => [entry.stepId, entry.deviceId]));
    expect(byStep.get("download")).toBe(fleet.devices.desktop.device.id);
    expect(byStep.get("open")).toBe(fleet.devices.redmi.device.id);
  });

  it("both results synchronize on iPhone and laptop", async () => {
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Two machines",
      originClientDeviceId: fleet.devices.laptop.device.id,
      steps: [
        {
          id: "download",
          description: "Clone",
          requiredCapabilities: ["git.clone"],
          tool: "device.git.clone",
          riskLevel: "SAFE",
        },
        {
          id: "open",
          description: "Open",
          requiredCapabilities: ["android.app.open"],
          tool: "device.android.app.open",
          dependsOn: ["download"],
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await bothClientsSee(plan.id, "succeeded");

    // Same identifier, same origin, on both sides.
    const onIphone = fleet.iphone.state().tasks.find((task) => task.id === plan.id);
    const onLaptop = fleet.laptop.state().tasks.find((task) => task.id === plan.id);

    expect(onIphone?.originClientDeviceId).toBe(fleet.devices.laptop.device.id);
    expect(onLaptop?.originClientDeviceId).toBe(fleet.devices.laptop.device.id);
    expect(onIphone?.stepCount).toBe(onLaptop?.stepCount);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E 6 — Disconnection during execution
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E 6 — desktop workstation drops during execution", () => {
  it("fails over to another machine rather than failing silently", async () => {
    // Two machines can read files: desktop and laptop. Desktop is preferred,
    // it disconnects, and the task must complete elsewhere.
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    await fleet.close();
    fleet = await bootFleet({
      behaviours: {
        desktop: {
          // Never returns: machine is busy when cable is disconnected.
          "filesystem.read": async () => {
            await blocked;
            return { content: "never returned" };
          },
        },
        laptop: {
          "filesystem.read": () => Promise.resolve({ content: "read by laptop" }),
        },
      },
    });

    const plan = planFor({
      userId: fleet.account.userId,
      title: "Read with failover",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "read",
          description: "Read file",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          preferredDeviceId: fleet.devices.desktop.device.id,
          retry: { attempts: 2, failoverToAnotherDevice: true },
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);

    // Step starts on desktop workstation.
    await waitFor(() => fleet.desktop.executed.length > 0);
    expect(fleet.harness.services.gateway.isConnected(fleet.devices.desktop.device.id)).toBe(true);

    // Cable is disconnected.
    fleet.desktop.disconnect("cable disconnected");
    await settle(40);

    // 1. NEXUS detects disconnection.
    await waitFor(
      () => !fleet.harness.services.gateway.isConnected(fleet.devices.desktop.device.id),
    );

    // 2. In-flight step is resolved retryable, and fails over to laptop.
    await waitFor(() => fleet.laptopWorker.executed.length > 0);

    // 3. Task succeeds; user is not left hanging.
    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "succeeded");
    expect(fleet.iphone.state().tasks[0]?.workerDeviceId).toBe(fleet.devices.laptop.device.id);

    release?.();
  });

  it("without viable fallback, failure is explicit and notified", async () => {
    // No silent failover, but no silence either: when no machine can handle it,
    // the user must be informed.
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    await fleet.close();
    fleet = await bootFleet({
      behaviours: {
        redmi: {
          "android.app.open": async () => {
            await blocked;
            return { opened: true };
          },
        },
      },
    });

    const plan = planFor({
      userId: fleet.account.userId,
      title: "Open on only phone",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "open",
          description: "Open application",
          // Only Redmi can perform this: no fallback exists.
          requiredCapabilities: ["android.app.open"],
          tool: "device.android.app.open",
          retry: { attempts: 1 },
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => fleet.redmi.executed.length > 0);

    fleet.redmi.disconnect("phone shut down");
    await settle(40);

    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "failed");

    const task = fleet.iphone.state().tasks[0];
    expect(task?.status).toBe("failed");
    expect(task?.error).not.toBeNull();

    // Notification is dispatched — no silent failure.
    await waitFor(() => fleet.iphone.state().notifications.length > 0);
    expect(fleet.iphone.state().notifications[0]?.severity).toBe("error");

    release?.();
  });

  it("reconnecting worker completely re-authenticates", async () => {
    fleet.desktop.disconnect("network outage");
    await settle(40);
    expect(fleet.harness.services.gateway.isConnected(fleet.devices.desktop.device.id)).toBe(false);

    // A session whose validity is uncertain is not a valid session:
    // reconnection performs full handshake, including signature.
    await fleet.desktop.runtime.start();
    await waitFor(() =>
      fleet.harness.services.gateway.isConnected(fleet.devices.desktop.device.id),
    );

    expect(fleet.harness.services.gateway.isConnected(fleet.devices.desktop.device.id)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E 7 — High-risk operation
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E 7 — HIGH risk action awaits human confirmation", () => {
  beforeEach(async () => {
    await fleet.close();
    fleet = await bootFleet({ confirmationThreshold: "HIGH" });
  });

  it("nothing executes before approval", async () => {
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Write to file",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "write",
          description: "Overwrite configuration file",
          requiredCapabilities: ["filesystem.write"],
          tool: "device.filesystem.write",
          arguments: { path: "C:\\Projects\\config.json", content: "{}" },
          riskLevel: "HIGH",
        },
      ],
    });

    runPlan(fleet, plan);

    // Request arrives on origin device.
    await waitFor(() => fleet.iphone.state().confirmations.length > 0);

    const confirmation = fleet.iphone.state().confirmations[0];
    expect(confirmation?.riskLevel).toBe("HIGH");
    expect(confirmation?.description).toContain("configuration");

    // And nothing has executed.
    await settle(40);
    expect(fleet.desktop.executed).toEqual([]);
    expect(fleet.laptopWorker.executed).toEqual([]);

    // Approval unblocks execution.
    await fleet.harness.services.confirmationBroker.respondAndRecord(
      confirmation?.id ?? "",
      "approved",
      fleet.account.userId,
    );

    await waitFor(() => fleet.desktop.executed.length + fleet.laptopWorker.executed.length > 0);
  });

  it("request also appears on other client with origin preserved", async () => {
    // Confirmation requested while on iPhone can be approved from laptop: request lives centrally.
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Risky action",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "write",
          description: "Write",
          requiredCapabilities: ["filesystem.write"],
          tool: "device.filesystem.write",
          riskLevel: "CRITICAL",
        },
      ],
    });

    runPlan(fleet, plan);

    await waitFor(
      () =>
        fleet.iphone.state().confirmations.length > 0 &&
        fleet.laptop.state().confirmations.length > 0,
    );

    const onIphone = fleet.iphone.state().confirmations[0];
    const onLaptop = fleet.laptop.state().confirmations[0];
    expect(onIphone?.id).toBe(onLaptop?.id);

    // Origin is preserved on task: UI knows where to highlight request.
    await waitFor(() => fleet.iphone.state().tasks.length > 0);
    expect(fleet.iphone.state().tasks[0]?.originClientDeviceId).toBe(
      fleet.devices.iphone.device.id,
    );
  });

  it("rejection executes nothing", async () => {
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Rejected action",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "write",
          description: "Write",
          requiredCapabilities: ["filesystem.write"],
          tool: "device.filesystem.write",
          riskLevel: "HIGH",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => fleet.iphone.state().confirmations.length > 0);

    await fleet.harness.services.confirmationBroker.respondAndRecord(
      fleet.iphone.state().confirmations[0]?.id ?? "",
      "rejected",
      fleet.account.userId,
    );

    // Rejection cancels step; expired confirmation fails it. The distinction matters:
    // "I said no" and "no one answered" do not call for same retry.
    // Client sees cancellation: without task.cancelled message, card would remain in progress.
    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "cancelled", {
      label: "task cancelled after rejection",
    });

    expect(fleet.desktop.executed).toEqual([]);
    expect(fleet.laptopWorker.executed).toEqual([]);
  });

  it("ordinary action requires no confirmation", async () => {
    // Threshold must be selective, not block everything: requesting confirmation
    // for every read trains users to approve without reading.
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Ordinary read",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "read",
          description: "Read",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "succeeded");

    expect(fleet.iphone.state().confirmations).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Final validation
// ─────────────────────────────────────────────────────────────────────────────

describe("final validation", () => {
  it("all four devices are in the fleet with their roles", async () => {
    const devices = await fleet.harness.services.deviceRegistry.listDevices(fleet.account.userId);
    const byName = new Map(devices.map((device) => [device.name, device]));

    expect(byName.get("iPhone 17")?.role).toBe("CLIENT");
    expect(byName.get("Windows Laptop")?.role).toBe("BOTH");
    expect(byName.get("Windows Desktop")?.role).toBe("WORKER");
    expect(byName.get("Redmi Note 10S")?.role).toBe("WORKER");
  });

  it("capabilities are resolved from workers, not hardcoded in core", async () => {
    const devices = await fleet.harness.services.deviceRegistry.listDevices(fleet.account.userId);
    const redmi = devices.find((device) => device.name === "Redmi Note 10S");

    // They come from the phone's worker.register envelope.
    expect(redmi?.capabilities.map((capability) => capability.name).sort()).toEqual(
      [...(["android.app.open", "android.app.list", "android.notification"] as const)].sort(),
    );
  });

  it("core does not know any device by name", async () => {
    // Architectural property, verified from the outside: renaming a
    // machine does not change what it executes.
    await fleet.harness.services.deviceRegistry.updateDevice(fleet.devices.redmi.device.id, {
      name: "Renamed phone",
    });

    const plan = planFor({
      userId: fleet.account.userId,
      title: "After rename",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "open",
          description: "Open",
          requiredCapabilities: ["android.app.open"],
          tool: "device.android.app.open",
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => fleet.redmi.executed.length > 0);
    expect(fleet.redmi.executed).toHaveLength(1);
  });

  it("an ungranted capability never leaves core", async () => {
    const plan = planFor({
      userId: fleet.account.userId,
      title: "Forbidden capability",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "forbidden",
          description: "Perform something forbidden",
          requiredCapabilities: ["docker.execute"],
          tool: "device.docker.execute",
          riskLevel: "SAFE",
        },
      ],
    });

    // Supervisor receives permissions that do not contain the
    // capability: this is what the route would do after authorization check.
    fleet.harness.services.supervisor.start(
      plan,
      GRANTED.filter((permission) => permission !== "docker.execute"),
    );

    await waitFor(() => fleet.iphone.state().tasks[0]?.status === "failed");
    expect(fleet.desktop.executed).toEqual([]);
    expect(fleet.redmi.executed).toEqual([]);
    expect(fleet.laptopWorker.executed).toEqual([]);
  });

  it("a task can be cancelled from any client", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    await fleet.close();
    fleet = await bootFleet({
      behaviours: {
        desktop: {
          "process.start": async () => {
            await blocked;
            return { started: true };
          },
        },
      },
    });

    const plan = planFor({
      userId: fleet.account.userId,
      title: "Long task",
      originClientDeviceId: fleet.devices.iphone.device.id,
      steps: [
        {
          id: "long",
          description: "Start a server",
          requiredCapabilities: ["process.start"],
          tool: "device.process.start",
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => fleet.desktop.executed.length > 0);

    // Started from iPhone, cancelled from laptop.
    const result = await fleet.laptop.realtime.cancelTask(plan.id);
    expect(result.cancelled).toBe(true);

    release?.();
  });

  it("a disconnected client catches up", async () => {
    fleet.iphone.realtime.stop("screen locked");
    await settle();

    const plan = planFor({
      userId: fleet.account.userId,
      title: "During iPhone absence",
      originClientDeviceId: fleet.devices.laptop.device.id,
      steps: [
        {
          id: "read",
          description: "Read",
          requiredCapabilities: ["filesystem.read"],
          tool: "device.filesystem.read",
          riskLevel: "SAFE",
        },
      ],
    });

    runPlan(fleet, plan);
    await waitFor(() => fleet.laptop.state().tasks.length > 0);

    // Phone comes out of pocket: it must see what it missed.
    await fleet.iphone.realtime.start();
    await waitFor(() => fleet.iphone.state().tasks.length > 0);

    expect(fleet.iphone.state().tasks[0]?.title).toBe("During iPhone absence");
  });
});
