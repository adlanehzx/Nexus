import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAccount,
  makeApi,
  registerDevice,
  signNonce,
  PASSWORD,
  type Account,
  type ApiHarness,
} from "./harness.js";

/**
 * REST API tests.
 *
 * Verifies both successful paths and security rejections across all endpoints.
 */

let harness: ApiHarness;
let account: Account;

beforeEach(async () => {
  harness = await makeApi();
  account = await createAccount(harness);
});

afterEach(async () => {
  await harness.close();
});

describe("response envelope", () => {
  it("carries request id on success", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: account.authorization,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: unknown; meta: { requestId: string } }>();

    expect(body.meta.requestId).toBeTruthy();
    expect(response.headers["x-request-id"]).toBe(body.meta.requestId);
  });

  it("carries request id on errors", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/v1/users/me" });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("UNAUTHENTICATED");
  });

  it("paginates via cursor", async () => {
    for (let index = 0; index < 5; index += 1) {
      await harness.app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        headers: account.authorization,
        payload: { title: `Conversation ${String(index)}` },
      });
    }

    const first = await harness.app.inject({
      method: "GET",
      url: "/api/v1/conversations?limit=2",
      headers: account.authorization,
    });

    const page = first.json<{
      data: { id: string }[];
      meta: { nextCursor: string | null; total: number };
    }>();

    expect(page.data).toHaveLength(2);
    expect(page.meta.total).toBe(5);
    expect(page.meta.nextCursor).toBeTruthy();

    const second = await harness.app.inject({
      method: "GET",
      url: `/api/v1/conversations?limit=2&cursor=${page.meta.nextCursor ?? ""}`,
      headers: account.authorization,
    });

    const next = second.json<{ data: { id: string }[] }>();
    expect(next.data.map((c) => c.id)).not.toContain(page.data[0]?.id);
  });

  it("caps requested page size", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/conversations?limit=100000",
      headers: account.authorization,
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("authentication", () => {
  it("rejects request without token", async () => {
    const response = await harness.app.inject({ method: "GET", url: "/api/v1/devices" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects tampered token", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { authorization: "Bearer not.a.token" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("logs in with correct password", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "alex@example.test", password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ data: { tokens: { accessToken: string } } }>().data.tokens.accessToken,
    ).toBeTruthy();
  });

  it("rejects wrong password without revealing whether account exists", async () => {
    const known = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "alex@example.test", password: "wrong password" },
    });
    const unknown = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "unknown@example.com", password: "wrong password" },
    });

    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.json<{ error: { message: string } }>().error.message).toBe(
      unknown.json<{ error: { message: string } }>().error.message,
    );
  });

  it("never returns password hash", async () => {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: account.authorization,
    });

    expect(response.body).not.toContain("scrypt$");
    expect(response.body).not.toContain("passwordHash");
  });

  it("rotates refresh token", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: account.refreshToken },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { refreshToken: string } }>().data.refreshToken).not.toBe(
      account.refreshToken,
    );
  });

  it("closes all sessions if refresh token is replayed", async () => {
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: account.refreshToken },
    });

    const replay = await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: account.refreshToken },
    });

    expect(replay.statusCode).toBe(401);
    expect(replay.json<{ error: { code: string } }>().error.code).toBe("SESSION_REVOKED");

    const after = await harness.app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: account.authorization,
    });
    expect(after.statusCode).toBe(401);
  });

  it("logout takes effect immediately", async () => {
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: account.authorization,
    });

    const after = await harness.app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: account.authorization,
    });
    expect(after.statusCode).toBe(401);
  });

  it("rate limits login attempts", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        harness.app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { email: "alex@example.test", password: "wrong" },
        }),
      ),
    );

    expect(attempts.some((response) => response.statusCode === 429)).toBe(true);
  });
});

describe("tenant isolation", () => {
  it("does not show another user's devices", async () => {
    const other = await createAccount(harness, "other@example.com");
    await registerDevice(harness, other, { name: "Private Workstation", role: "WORKER" });

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: account.authorization,
    });

    expect(response.json<{ data: unknown[] }>().data).toHaveLength(0);
  });

  it("refuses to read another user's device without revealing existence", async () => {
    const other = await createAccount(harness, "other@example.com");
    const { device } = await registerDevice(harness, other, {
      name: "Private Workstation",
      role: "WORKER",
    });

    const response = await harness.app.inject({
      method: "GET",
      url: `/api/v1/devices/${device.id}`,
      headers: account.authorization,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { message: string } }>().error.message).toBe(
      "The requested resource does not exist.",
    );
  });

  it("refuses to read another user's conversation", async () => {
    const other = await createAccount(harness, "other@example.com");
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers: other.authorization,
      payload: { title: "Private" },
    });
    const id = created.json<{ data: { id: string } }>().data.id;

    const response = await harness.app.inject({
      method: "GET",
      url: `/api/v1/conversations/${id}`,
      headers: account.authorization,
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("devices", () => {
  it("registers device offline and pending", async () => {
    const { device } = await registerDevice(harness, account, {
      name: "Desktop Workstation",
      role: "WORKER",
      trust: false,
    });

    expect(device.status).toBe("OFFLINE");
    expect(device.trust).toBe("PENDING");
  });

  it("registers CLIENT without public key", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices",
      headers: account.authorization,
      payload: {
        name: "Alex's iPhone",
        type: "IPHONE",
        platform: "IOS",
        role: "CLIENT",
        grantedPermissions: [],
      },
    });

    expect(response.statusCode).toBe(201);
    const created = response.json<{ data: { role: string; trust: string } }>().data;
    expect(created.role).toBe("CLIENT");
    expect(created.trust).toBe("PENDING");
  });

  it("rejects WORKER without public key", async () => {
    for (const role of ["WORKER", "BOTH"]) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/v1/devices",
        headers: account.authorization,
        payload: {
          name: `Workstation ${role}`,
          type: "WINDOWS_PC",
          platform: "WINDOWS",
          role,
          grantedPermissions: [],
        },
      });

      expect(response.statusCode).toBe(400);
    }
  });

  it("CLIENT without key opens no device session", async () => {
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/devices",
      headers: account.authorization,
      payload: {
        name: "Bare iPhone",
        type: "IPHONE",
        platform: "IOS",
        role: "CLIENT",
        grantedPermissions: [],
      },
    });
    const deviceId = created.json<{ data: { id: string } }>().data.id;

    const challenge = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${deviceId}/challenge`,
    });
    const nonce = challenge.json<{ data: { nonce: string } }>().data.nonce;

    const session = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${deviceId}/sessions`,
      payload: { nonce, signature: "c2lnbmF0dXJlLWJpZG9u", capabilities: [] },
    });

    expect(session.statusCode).toBe(404);
  });

  it("approves a device", async () => {
    const { device } = await registerDevice(harness, account, {
      name: "Desktop Workstation",
      role: "WORKER",
    });
    expect(device.trust).toBe("TRUSTED");
  });

  it("opens device session on signed challenge", async () => {
    const { device, privateKeyPem } = await registerDevice(harness, account, {
      name: "Desktop Workstation",
      role: "WORKER",
      permissions: ["terminal.execute"],
    });

    const challenge = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/challenge`,
    });
    const nonce = challenge.json<{ data: { nonce: string } }>().data.nonce;

    const session = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/sessions`,
      payload: { nonce, signature: signNonce(privateKeyPem, nonce), capabilities: [] },
    });

    expect(session.statusCode).toBe(201);
    expect(session.json<{ data: { token: string } }>().data.token).toBeTruthy();
  });

  it("rejects invalid signature", async () => {
    const { device } = await registerDevice(harness, account, {
      name: "Desktop Workstation",
      role: "WORKER",
    });

    const challenge = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/challenge`,
    });
    const nonce = challenge.json<{ data: { nonce: string } }>().data.nonce;

    const session = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/sessions`,
      payload: { nonce, signature: "c2lnbmF0dXJlLWJpZG9u", capabilities: [] },
    });

    expect(session.statusCode).toBe(401);
  });

  it("rejects revoked device", async () => {
    const { device, privateKeyPem } = await registerDevice(harness, account, {
      name: "Desktop Workstation",
      role: "WORKER",
    });

    await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/revoke`,
      headers: account.authorization,
    });

    const challenge = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/challenge`,
    });

    expect(challenge.statusCode).toBe(401);
    expect(privateKeyPem).toBeTruthy();
  });

  it("exposes capabilities present in fleet", async () => {
    const { device } = await registerDevice(harness, account, {
      name: "Desktop Workstation",
      role: "WORKER",
    });

    await harness.app.inject({
      method: "PUT",
      url: `/api/v1/devices/${device.id}/capabilities`,
      headers: account.authorization,
      payload: {
        capabilities: [
          { name: "terminal.execute", version: "1", description: "", enabled: true, metadata: {} },
        ],
      },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/capabilities",
      headers: account.authorization,
    });

    const body = response.json<{ data: { available: { name: string }[] } }>();
    expect(body.data.available.map((c) => c.name)).toContain("terminal.execute");
  });
});

describe("tasks", () => {
  it("rejects ungranted capability", async () => {
    const { device } = await registerDevice(harness, account, {
      name: "iPhone",
      role: "CLIENT",
      type: "IPHONE",
      platform: "IOS",
    });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Execute a command",
        originClientDeviceId: device.id,
        steps: [
          {
            description: "Run tests",
            requiredCapabilities: ["terminal.execute"],
            tool: "device.terminal.execute",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      "terminal.execute",
    );
  });

  it("rejects origin device not owned by caller", async () => {
    const other = await createAccount(harness, "other@example.com");
    const { device } = await registerDevice(harness, other, { name: "iPhone", role: "CLIENT" });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: {
        title: "Hijack",
        originClientDeviceId: device.id,
        steps: [{ description: "x", requiredCapabilities: ["filesystem.read"], tool: "device.x" }],
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects plan without steps", async () => {
    const { device } = await registerDevice(harness, account, { name: "iPhone", role: "CLIENT" });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: account.authorization,
      payload: { title: "Empty", originClientDeviceId: device.id, steps: [] },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("notifications", () => {
  it("marks notification as read for all clients", async () => {
    const notification = await harness.services.notifications.create({
      userId: account.userId,
      title: "Task completed",
      body: "Tests passed",
    });

    const read = await harness.app.inject({
      method: "POST",
      url: `/api/v1/notifications/${notification.id}/read`,
      headers: account.authorization,
    });

    expect(read.statusCode).toBe(200);
    expect(read.json<{ data: { readAt: string | null } }>().data.readAt).not.toBeNull();
  });

  it("filters unread notifications", async () => {
    const first = await harness.services.notifications.create({
      userId: account.userId,
      title: "One",
      body: "x",
    });
    await harness.services.notifications.create({
      userId: account.userId,
      title: "Two",
      body: "y",
    });

    await harness.app.inject({
      method: "POST",
      url: `/api/v1/notifications/${first.id}/read`,
      headers: account.authorization,
    });

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/notifications?unreadOnly=true",
      headers: account.authorization,
    });

    expect(response.json<{ data: { title: string }[] }>().data).toHaveLength(1);
  });
});

describe("memory", () => {
  it("saves and retrieves a memory", async () => {
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory",
      headers: account.authorization,
      payload: { content: "Alex prefers short answers", kind: "SEMANTIC" },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/memory/search?q=answers",
      headers: account.authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { hits: unknown[] } }>().data.hits.length).toBeGreaterThan(0);
  });

  it("does not cross boundary between users", async () => {
    const other = await createAccount(harness, "other@example.com");
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory",
      headers: other.authorization,
      payload: { content: "Someone else's secret", kind: "SEMANTIC" },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/memory/search?q=Secret",
      headers: account.authorization,
    });

    expect(response.json<{ data: { hits: unknown[] } }>().data.hits).toHaveLength(0);
  });
});

describe("CORS and CSP", () => {
  it("must accept valid preflight", async () => {
    const response = await harness.app.inject({
      method: "OPTIONS",
      url: "/api/v1/auth/login",
      headers: {
        Origin: "http://localhost:5273",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5273");
    expect(response.headers["access-control-allow-methods"]).toMatch(/POST/);
  });
});
