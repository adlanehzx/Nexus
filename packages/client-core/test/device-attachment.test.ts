import { describe, expect, it } from "vitest";
import { RealtimeClient } from "../src/realtime.js";
import { SessionManager } from "../src/session.js";
import { initialState, reduce, type ClientAction, type ClientState } from "../src/store.js";
import {
  FakeHttpClient,
  FakeNetwork,
  FakeSecureStorage,
  FakeSocket,
  TestTimers,
  loginResponse,
} from "./fixtures.js";

/**
 * Device attachment tests on client side.
 */

const IPHONE = { name: "iPhone", type: "IPHONE", platform: "IOS", role: "CLIENT" } as const;

/** A device representation as returned by `GET /devices`. */
function device(overrides: Record<string, unknown> = {}) {
  return {
    id: "device-iphone",
    name: "iPhone",
    type: "IPHONE",
    platform: "IOS",
    role: "CLIENT",
    status: "OFFLINE",
    trust: "TRUSTED",
    capabilities: [],
    grantedPermissions: [],
    health: { activeTasks: 0, maxConcurrentTasks: 1 },
    lastSeenAt: null,
    authenticated: false,
    ...overrides,
  };
}

function devicesList(...items: unknown[]) {
  return { status: 200, body: { data: items, meta: { total: items.length } } };
}

function makeSession(storage = new FakeSecureStorage()) {
  const http = new FakeHttpClient();
  http.on("POST", "/api/v1/auth/login", loginResponse());
  http.on("POST", "/api/v1/auth/logout", { status: 204, body: null });

  return { http, storage, session: new SessionManager({ http, storage }) };
}

describe("1. sign in with existing attached device", () => {
  it("registers nothing and skips querying fleet", async () => {
    const storage = new FakeSecureStorage();
    storage.values.set("nexus.access", "access-token-1");
    storage.values.set("nexus.refresh", "refresh-token-1");
    storage.values.set("nexus.device", "device-already-there");
    storage.values.set("nexus.user", "u1");

    const { http, session } = makeSession(storage);
    await session.restore();

    const result = await session.ensureDevice(IPHONE);

    expect(result).toEqual({ deviceId: "device-already-there", origin: "session" });
    expect(http.countOf("POST", "/api/v1/devices")).toBe(0);
    expect(http.countOf("GET", "/api/v1/devices?limit=100")).toBe(0);
  });

  it("reuses account device when secure storage was cleared", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList(device()));

    await session.login("alex@example.test", "password");
    const result = await session.ensureDevice(IPHONE);

    expect(result).toEqual({ deviceId: "device-iphone", origin: "existing", trust: "TRUSTED" });
    expect(session.deviceId).toBe("device-iphone");
    expect(http.countOf("POST", "/api/v1/devices")).toBe(0);
  });

  it("never reuses a revoked device", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList(device({ trust: "REVOKED" })));
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "device-new" } } });

    await session.login("alex@example.test", "password");
    const result = await session.ensureDevice(IPHONE);

    expect(result.origin).toBe("registered");
    expect(result.deviceId).toBe("device-new");
    expect(http.countOf("POST", "/api/v1/devices")).toBe(1);
  });

  it("does not reuse device belonging to a different phone", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList(device({ name: "Alex's Work Phone" })));
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "device-personal" } } });

    await session.login("alex@example.test", "password");
    const result = await session.ensureDevice(IPHONE);

    expect(result.deviceId).toBe("device-personal");
    expect(http.countOf("POST", "/api/v1/devices")).toBe(1);
  });
});

describe("2. registering a new device", () => {
  it("creates device when none matches", async () => {
    const { http, storage, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "device-new" } } });

    await session.login("alex@example.test", "password");
    const result = await session.ensureDevice(IPHONE);

    expect(result).toEqual({ deviceId: "device-new", origin: "registered", trust: "PENDING" });
    expect(session.deviceId).toBe("device-new");
    expect(storage.values.get("nexus.device")).toBe("device-new");
  });

  it("sends no public key for CLIENT role", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "password");
    await session.ensureDevice(IPHONE);

    const body = http.requests.at(-1)?.body as Record<string, unknown>;
    expect("publicKeyPem" in body).toBe(false);
  });
});

describe("3. idempotence across multiple calls", () => {
  it("registers only once even if attachment is called repeatedly", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "device-first" } } });

    await session.login("alex@example.test", "password");
    await session.ensureDevice(IPHONE);
    await session.ensureDevice(IPHONE);
    await session.ensureDevice(IPHONE);

    expect(http.countOf("POST", "/api/v1/devices")).toBe(1);
  });
});

describe("4. rejected registration", () => {
  it("surfaces core server message rather than generic failure", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", {
      status: 403,
      body: { error: { code: "DEVICE_QUOTA", message: "Too many devices on this account." } },
    });

    await session.login("alex@example.test", "password");

    await expect(session.ensureDevice(IPHONE)).rejects.toThrow("Too many devices on this account.");
    expect(session.deviceId).toBeNull();
  });

  it("fails cleanly when core server is unreachable", async () => {
    const { http, session } = makeSession();
    await session.login("alex@example.test", "password");

    http.failNext = true;
    await expect(session.ensureDevice(IPHONE)).rejects.toThrow();
    expect(session.deviceId).toBeNull();
  });

  it("registers despite unreadable device list rather than blocking", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", { status: 500, body: null });
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "password");

    expect((await session.ensureDevice(IPHONE)).origin).toBe("registered");
  });
});

describe("5. device pending approval", () => {
  it("reports PENDING for freshly created device", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "password");

    expect((await session.ensureDevice(IPHONE)).trust).toBe("PENDING");
  });

  it("reuses pending device without re-registering", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList(device({ trust: "PENDING" })));

    await session.login("alex@example.test", "password");
    const result = await session.ensureDevice(IPHONE);

    expect(result).toEqual({ deviceId: "device-iphone", origin: "existing", trust: "PENDING" });
    expect(http.countOf("POST", "/api/v1/devices")).toBe(0);
  });
});

describe("6. channel only opens with bound device", () => {
  function makeRealtime(session: SessionManager) {
    const socket = new FakeSocket();
    const timers = new TestTimers();
    const actions: ClientAction[] = [];
    let state: ClientState = initialState;

    const client = new RealtimeClient({
      socket,
      session,
      url: "wss://nexus.test/ws/client",
      network: new FakeNetwork(),
      timers,
      random: () => 0.5,
      now: () => new Date("2026-09-02T12:00:00.000Z"),
      dispatch: (action) => {
        actions.push(action);
        state = reduce(state, action);
      },
    });

    return { client, socket, timers, actions, state: () => state };
  }

  it("opens no socket without bound device", async () => {
    const { session } = makeSession();
    await session.login("alex@example.test", "password");

    const h = makeRealtime(session);
    await h.client.start();

    expect(h.socket.state).toBe("idle");
    expect(h.socket.sent).toHaveLength(0);
    expect(h.client.state).toBe("offline");
  });

  it("does not schedule reconnection without bound device", async () => {
    const { session } = makeSession();
    await session.login("alex@example.test", "password");

    const h = makeRealtime(session);
    await h.client.start();

    expect(h.timers.pending.size).toBe(0);
    expect(h.actions.filter((a) => a.kind === "connection").map((a) => a.state)).not.toContain(
      "reconnecting",
    );
  });

  it("reports descriptive error instead of empty screen", async () => {
    const { session } = makeSession();
    await session.login("alex@example.test", "password");

    const h = makeRealtime(session);
    await h.client.start();

    expect(h.state().lastError?.code).toBe("CLIENT_NO_DEVICE");
  });

  it("opens and announces device as soon as it is bound", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "device-new" } } });

    await session.login("alex@example.test", "password");

    const h = makeRealtime(session);
    await h.client.start();
    expect(h.socket.sent).toHaveLength(0);

    await session.ensureDevice(IPHONE);
    await h.client.start();

    expect(h.client.state).toBe("connected");
    expect(h.socket.lastOfType("client.hello")?.payload.deviceId).toBe("device-new");
  });
});

describe("7. sign out", () => {
  it("clears device binding along with tokens", async () => {
    const { http, storage, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "password");
    await session.ensureDevice(IPHONE);
    await session.logout();

    expect(session.deviceId).toBeNull();
    expect(session.isAuthenticated).toBe(false);
    expect(storage.removed).toContain("nexus.device");
    expect(storage.values.has("nexus.device")).toBe(false);
  });

  it("clears device binding even if server is unreachable", async () => {
    const { http, storage, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "password");
    await session.ensureDevice(IPHONE);

    http.failNext = true;
    await session.logout();

    expect(storage.removed).toContain("nexus.device");
  });
});

describe("8. reconnection and account switching", () => {
  it("same account recovers its device binding", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList(device()));

    await session.login("alex@example.test", "password");
    await session.ensureDevice(IPHONE);
    await session.login("alex@example.test", "password");

    expect(session.deviceId).toBe("device-iphone");
  });

  it("different account does not inherit previous device binding", async () => {
    const { http, storage, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList(device()));

    await session.login("alex@example.test", "password");
    await session.ensureDevice(IPHONE);
    expect(session.deviceId).toBe("device-iphone");

    const sarah = loginResponse({ access: "token-sarah", refresh: "refresh-sarah" });
    (sarah.body as { data: { user: { id: string } } }).data.user.id = "u2";
    http.on("POST", "/api/v1/auth/login", sarah);

    await session.login("sarah@example.test", "password");

    expect(session.deviceId).toBeNull();
    expect(storage.removed).toContain("nexus.device");
  });

  it("does not destroy valid binding when user info is absent", async () => {
    const storage = new FakeSecureStorage();
    storage.values.set("nexus.access", "a");
    storage.values.set("nexus.refresh", "r");
    storage.values.set("nexus.device", "device-legacy");

    const { session } = makeSession(storage);
    await session.restore();
    await session.login("alex@example.test", "password");

    expect(session.deviceId).toBe("device-legacy");
  });
});

describe("9. no excess privileges granted to client", () => {
  it("grants no permissions and requests no worker role", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "password");
    await session.ensureDevice(IPHONE);

    const body = http.requests.at(-1)?.body as { role: string; grantedPermissions: string[] };
    expect(body.role).toBe("CLIENT");
    expect(body.grantedPermissions).toEqual([]);
  });

  it("does not self-approve", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "password");
    await session.ensureDevice(IPHONE);

    expect(http.requests.some((r) => r.path.includes("/trust"))).toBe(false);
  });

  it("does not re-register as a worker", async () => {
    const { http, session } = makeSession();
    http.on("GET", "/api/v1/devices?limit=100", devicesList());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "password");
    await session.ensureDevice(IPHONE);

    const roles = http.requests
      .filter((r) => r.method === "POST" && r.path === "/api/v1/devices")
      .map((r) => (r.body as { role: string }).role);
    expect(roles).toEqual(["CLIENT"]);
  });
});
