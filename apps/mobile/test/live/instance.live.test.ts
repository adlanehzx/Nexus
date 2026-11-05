import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("expo-speech", () => ({}));
vi.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1 }));
vi.mock("@react-native-community/netinfo", () => ({
  default: { addEventListener: () => () => undefined },
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

import {
  ApiClient,
  RealtimeClient,
  SessionManager,
  VolatileStorage,
  clientSocketUrl,
  type ClientAction,
} from "@nexus/client-core";
import { MobileApi } from "../../lib/api.js";
import { ChatController } from "../../lib/chat-controller.js";
import type { MobileAction } from "../../lib/chat-state.js";
import { describeFailure, type Failure } from "../../lib/errors.js";
import { registerForPush } from "../../lib/notifications.js";
import { NativeSocket, TimeoutHttpClient } from "../../lib/platform.js";

/**
 * The mobile client against a real NEXUS core.
 *
 * Nothing is mocked on the server side: same HTTP client, socket and session as
 * the app, only the secure store swapped for memory. It runs only when pointed
 * at an instance:
 *
 *   NEXUS_LIVE_URL=http://localhost:3910 pnpm test
 *
 * It creates accounts, so never aim it at an installation you care about.
 */

const url = process.env.NEXUS_LIVE_URL;

async function failureOf(work: () => Promise<unknown>): Promise<Failure | undefined> {
  try {
    await work();
    return undefined;
  } catch (cause) {
    return describeFailure(cause);
  }
}

describe.skipIf(url === undefined)("live NEXUS instance", { timeout: 60_000 }, () => {
  const baseUrl = url ?? "";
  const frames: ClientAction[] = [];
  const socket = new NativeSocket();
  const session = new SessionManager({
    http: new TimeoutHttpClient(baseUrl),
    storage: new VolatileStorage(),
  });
  const api = new ApiClient(session);
  const mobile = new MobileApi(session);
  const realtime = new RealtimeClient({
    socket,
    session,
    url: clientSocketUrl(baseUrl),
    dispatch: (action) => {
      frames.push(action);
    },
    reconnectMinMs: 200,
  });

  // The first account of a core is its administrator, and the screens need one:
  // a fixed identity keeps reruns on the same instance administrator too.
  const email = "mobile-live-test@example.test";
  const password = "Mobile-live-test-1234!";

  beforeAll(async () => {
    const readiness = await session.checkReadiness();
    expect(readiness.status).not.toBe("down");

    const { initialized } = await session.checkSetupStatus();
    if (initialized) await session.login(email, password);
    else await session.register({ email, displayName: "Mobile live test", password });
  });

  afterAll(() => {
    realtime.stop("test finished");
  });

  it("registers this phone and reports it pending or approved", async () => {
    const device = await session.ensureDevice({
      name: `Live test phone ${String(Date.now())}`,
      type: "ANDROID",
      platform: "ANDROID",
      role: "CLIENT",
    });
    expect(device.origin).toBe("registered");
    expect(device.trust).toBe("PENDING");

    const listed = await api.listDevices();
    expect(listed.map((candidate) => candidate.id)).toContain(device.deviceId);
  });

  it("approves a device with a bodyless POST, which an unconditional content-type would break", async () => {
    const deviceId = session.deviceId ?? "";
    const trusted = await api.trustDevice(deviceId);
    expect(trusted.trust).toBe("TRUSTED");
  });

  it("opens the realtime channel once approved and reconnects after a dropped socket", async () => {
    await realtime.start();
    await vi.waitFor(() => {
      expect(realtime.state).toBe("connected");
    });
    const devices = await realtime.listDevices();
    expect(devices.devices.length).toBeGreaterThan(0);

    frames.length = 0;
    socket.close("simulated network drop");
    await vi.waitFor(
      async () => {
        expect(frames).toContainEqual(
          expect.objectContaining({ kind: "connection", state: "reconnecting" }),
        );
        expect(realtime.state).toBe("connected");
        await expect(realtime.listDevices()).resolves.toBeDefined();
      },
      { timeout: 30_000, interval: 500 },
    );
  });

  it("reads the screens' data with the shapes they expect", async () => {
    const overview = await mobile.overview();
    expect(typeof overview.agentRuns.running).toBe("number");
    expect(Array.isArray(overview.health)).toBe(true);

    expect(Array.isArray(await mobile.listRuns())).toBe(true);
    expect(Array.isArray(await mobile.listTasks())).toBe(true);
    expect(Array.isArray(await mobile.tools())).toBe(true);
    expect(Array.isArray(await mobile.providers())).toBe(true);
    expect(Array.isArray(await mobile.models())).toBe(true);
    expect(Array.isArray(await mobile.satellites())).toBe(true);
    expect(Array.isArray(await mobile.providerAccounts())).toBe(true);
    expect(Array.isArray(await mobile.connections())).toBe(true);

    const mcp = await mobile.mcp();
    expect(typeof mcp.configured).toBe("boolean");
    expect(Array.isArray(mcp.configurations)).toBe(true);

    const control = await mobile.missionControl();
    expect(typeof control.reachable).toBe("boolean");

    const engines = await mobile.llmEngines();
    expect(typeof engines.preferLocal).toBe("boolean");

    const fleet = await mobile.fleet();
    const self = await mobile.getDevice(session.deviceId ?? "");
    expect(fleet.map((row) => row.id)).toContain(self.id);
    expect(self.health).toHaveProperty("activeTasks");
    expect(Array.isArray(self.capabilities)).toBe(true);

    const me = await mobile.me();
    expect(me.email).toBe(email);
    expect(Array.isArray(await mobile.permissions())).toBe(true);
  });

  it("reports push honestly, whether or not the core has the route yet", async () => {
    const outcome = await registerForPush(mobile, session.deviceId ?? "", {
      module: {
        getPermissionsAsync: () => Promise.resolve({ granted: true }),
        getExpoPushTokenAsync: () => Promise.resolve({ data: "ExponentPushToken[live-test]" }),
      } as never,
      projectId: "live-test",
    });
    // Becomes "registered" the day the core ships the contract in docs/BACKEND-GAPS.md.
    expect(["server-unsupported", "registered"]).toContain(outcome.state);
    console.info(`Push on this instance: ${outcome.state}`);
  });

  it("classifies a missing record", async () => {
    const record = await failureOf(() =>
      mobile.getRunDetail("00000000-0000-0000-0000-000000000000"),
    );
    expect(record?.kind).toBe("notFound");
  });

  it("pauses and resumes NEXUS for real", async () => {
    const paused = await mobile.setPaused(true, "Mobile live test");
    expect(paused.paused).toBe(true);
    expect((await mobile.pauseState()).reason).toBe("Mobile live test");

    const refused = await failureOf(() => mobile.submitMission("should not start", "UTC"));
    expect(refused).toBeDefined();

    expect((await mobile.setPaused(false)).paused).toBe(false);
  });

  it("creates, reads and archives a conversation", async () => {
    const created = await mobile.createConversation("Live test");
    expect((await mobile.listConversations()).map((item) => item.id)).toContain(created.id);
    const { items } = await mobile.listAllMessages(created.id);
    expect(items).toEqual([]);
    expect((await mobile.archiveConversation(created.id)).id).toBe(created.id);
  });

  it("adds, reconnects and removes an MCP server", async () => {
    const name = `live-${String(Date.now())}`;
    await mobile.saveMcp({
      name,
      url: "https://mcp.invalid/mcp",
      transport: "http",
      enabled: false,
      defaultPermissions: [],
      defaultRisk: "MEDIUM",
      toolPolicies: {},
      headers: {},
      headerRefs: {},
    });
    const saved = await mobile.mcp();
    const config = saved.configurations.find((item) => item.name === name);
    expect(config?.transport).toBe("http");

    // What the toggle does: round-trip the document with one field changed.
    if (config !== undefined) await mobile.saveMcp({ ...config, enabled: false });

    await mobile.removeMcp(name);
    expect((await mobile.mcp()).configurations.map((item) => item.name)).not.toContain(name);
  });

  it("chat sends through the real agent route, or reports exactly why it cannot", async () => {
    const actions: MobileAction[] = [];
    const chat = new ChatController({
      mobile,
      api,
      realtime,
      session,
      dispatch: (action) => {
        actions.push(action);
      },
      onChange: () => undefined,
    });

    await chat.send("Reply with the single word: pong", "chat");

    expect(chat.state.conversationId).not.toBeNull();
    const error = actions.find((action) => action.kind === "error");
    if (error === undefined) {
      const hydrated = actions.filter((action) => action.kind === "hydrateMessages").at(-1);
      expect(hydrated).toBeDefined();
      if (hydrated?.kind === "hydrateMessages") {
        expect(hydrated.messages.some((message) => message.role === "assistant")).toBe(true);
      }
    } else if (error.kind === "error") {
      // No LLM configured on this instance: the message must say so, not pretend.
      expect(error.code).toBe("CHAT_SEND_FAILED");
      expect(error.message.length).toBeGreaterThan(0);
      console.info(`Chat on this instance reports: ${error.message}`);
    }
  });

  it("a second account is told it lacks the role, and cannot see the first one's devices", async () => {
    const other = new SessionManager({
      http: new TimeoutHttpClient(baseUrl),
      storage: new VolatileStorage(),
    });
    await other.register({
      email: `mobile-live-${String(Date.now())}@example.test`,
      displayName: "Second account",
      password,
    });
    const failure = await failureOf(() => new MobileApi(other).overview());
    expect(failure?.kind).toBe("forbidden");

    const devices = await new ApiClient(other).listDevices();
    expect(devices.map((device) => device.id)).not.toContain(session.deviceId);
  });

  it("logs out, after which the session no longer reaches the API", async () => {
    realtime.stop("logging out");
    await session.logout();
    const failure = await failureOf(() => mobile.overview());
    expect(failure?.kind).toBe("auth");
  });
});
