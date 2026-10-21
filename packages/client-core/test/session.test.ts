import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/session.js";
import { FakeHttpClient, FakeSecureStorage, TOKENS, loginResponse } from "./fixtures.js";

/**
 * Session and token lifecycle tests.
 */

function makeSession(options: { onSignedOut?: (reason: string) => void } = {}) {
  const http = new FakeHttpClient();
  const storage = new FakeSecureStorage();
  const session = new SessionManager({
    http,
    storage,
    ...(options.onSignedOut === undefined ? {} : { onSignedOut: options.onSignedOut }),
  });

  return { http, storage, session };
}

describe("sign in", () => {
  it("opens session and stores tokens in secure storage", async () => {
    const { http, storage, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());

    await session.login("alex@example.test", "a sufficient password");

    expect(session.isAuthenticated).toBe(true);
    expect(storage.values.get("nexus.access")).toBe(TOKENS.access);
    expect(storage.values.get("nexus.refresh")).toBe(TOKENS.refresh);
  });

  it("rejects invalid credentials", async () => {
    const { http, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", {
      status: 401,
      body: {
        error: { code: "INVALID_CREDENTIALS", message: "Incorrect email or password." },
      },
    });

    await expect(session.login("alex@example.test", "wrong")).rejects.toMatchObject({
      code: "CLIENT_LOGIN_FAILED",
    });
    expect(session.isAuthenticated).toBe(false);
  });

  it("never stores plain text password", async () => {
    const { http, storage, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());

    await session.login("alex@example.test", "MySecretPassword2026");

    expect(JSON.stringify([...storage.values.values()])).not.toContain("MySecretPassword2026");
  });

  it("restores session from secure storage on startup", async () => {
    const { storage, session } = makeSession();
    await storage.set("nexus.access", TOKENS.access);
    await storage.set("nexus.refresh", TOKENS.refresh);
    await storage.set("nexus.device", "device-iphone");

    expect(await session.restore()).toBe(true);
    expect(session.accessToken()).toBe(TOKENS.access);
    expect(session.deviceId).toBe("device-iphone");
  });

  it("restores nothing when secure storage is empty", async () => {
    const { session } = makeSession();
    expect(await session.restore()).toBe(false);
    expect(session.isAuthenticated).toBe(false);
  });
});

describe("token refresh", () => {
  it("rotates token and stores new one", async () => {
    const { http, storage, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/auth/refresh", {
      status: 200,
      body: { data: { accessToken: "access-2", refreshToken: "refresh-2" } },
    });

    await session.login("alex@example.test", "password");
    const token = await session.refresh();

    expect(token).toBe("access-2");
    expect(storage.values.get("nexus.refresh")).toBe("refresh-2");
  });

  it("runs only one rotation for ten concurrent calls", async () => {
    const { http, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/auth/refresh", {
      status: 200,
      body: { data: { accessToken: "access-2", refreshToken: "refresh-2" } },
    });

    await session.login("alex@example.test", "password");

    const results = await Promise.all(Array.from({ length: 10 }, () => session.refresh()));

    expect(http.countOf("POST", "/api/v1/auth/refresh")).toBe(1);
    expect(new Set(results)).toEqual(new Set(["access-2"]));
  });

  it("clears storage when server rejects rotation", async () => {
    const reasons: string[] = [];
    const { http, storage, session } = makeSession({
      onSignedOut: (reason) => reasons.push(reason),
    });

    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/auth/refresh", {
      status: 401,
      body: { error: { code: "SESSION_REVOKED" } },
    });

    await session.login("alex@example.test", "password");
    await expect(session.refresh()).rejects.toMatchObject({ code: "CLIENT_NOT_AUTHENTICATED" });

    expect(session.isAuthenticated).toBe(false);
    expect(storage.removed).toContain("nexus.access");
    expect(reasons).toEqual(["refresh rejected"]);
  });

  it("allows new rotation after previous completes", async () => {
    const { http, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on(
      "POST",
      "/api/v1/auth/refresh",
      { status: 200, body: { data: { accessToken: "a2", refreshToken: "r2" } } },
      { status: 200, body: { data: { accessToken: "a3", refreshToken: "r3" } } },
    );

    await session.login("alex@example.test", "password");

    expect(await session.refresh()).toBe("a2");
    expect(await session.refresh()).toBe("a3");
  });
});

describe("authenticated requests", () => {
  it("attaches bearer token", async () => {
    const { http, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("GET", "/api/v1/devices", { status: 200, body: { data: [] } });

    await session.login("alex@example.test", "password");
    await session.authorizedRequest({ method: "GET", path: "/api/v1/devices" });

    expect(http.requests.at(-1)?.authorization).toBe(`Bearer ${TOKENS.access}`);
  });

  it("refreshes and retries once on 401", async () => {
    const { http, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/auth/refresh", {
      status: 200,
      body: { data: { accessToken: "access-2", refreshToken: "r2" } },
    });
    http.on(
      "GET",
      "/api/v1/devices",
      { status: 401, body: { error: { code: "TOKEN_EXPIRED" } } },
      { status: 200, body: { data: [{ id: "d1" }] } },
    );

    await session.login("alex@example.test", "password");
    const response = await session.authorizedRequest({ method: "GET", path: "/api/v1/devices" });

    expect(response.status).toBe(200);
    expect(http.requests.at(-1)?.authorization).toBe("Bearer access-2");
  });

  it("does not loop if new token is also rejected", async () => {
    const { http, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/auth/refresh", {
      status: 200,
      body: { data: { accessToken: "access-2", refreshToken: "r2" } },
    });
    http.on("GET", "/api/v1/devices", { status: 401, body: { error: { code: "FORBIDDEN" } } });

    await session.login("alex@example.test", "password");
    const response = await session.authorizedRequest({ method: "GET", path: "/api/v1/devices" });

    expect(response.status).toBe(401);
    expect(http.countOf("GET", "/api/v1/devices")).toBe(2);
    expect(http.countOf("POST", "/api/v1/auth/refresh")).toBe(1);
  });
});

describe("sign out", () => {
  it("clears secure storage", async () => {
    const { http, storage, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/auth/logout", { status: 200, body: { data: { closed: true } } });

    await session.login("alex@example.test", "password");
    await session.logout();

    expect(session.isAuthenticated).toBe(false);
    expect(storage.removed).toEqual(expect.arrayContaining(["nexus.access", "nexus.refresh"]));
  });

  it("clears secure storage even if server is unreachable", async () => {
    const { http, storage, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());

    await session.login("alex@example.test", "password");
    http.failNext = true;
    await session.logout();

    expect(session.isAuthenticated).toBe(false);
    expect(storage.removed).toContain("nexus.access");
  });
});

describe("device registration", () => {
  it("sends public key and stores device ID", async () => {
    const { http, storage, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "device-iphone" } } });

    await session.login("alex@example.test", "password");
    const deviceId = await session.registerDevice({
      name: "Alex's iPhone",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----",
    });

    expect(deviceId).toBe("device-iphone");
    expect(storage.values.get("nexus.device")).toBe("device-iphone");

    const body = http.requests.at(-1)?.body as { type: string; role: string; publicKeyPem: string };
    expect(body).toMatchObject({ type: "IPHONE", role: "CLIENT" });
    expect(body.publicKeyPem).not.toContain("PRIVATE");
  });

  it("registers as CLIENT by default", async () => {
    const { http, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "password");
    await session.registerDevice({ name: "iPhone", publicKeyPem: "key" });

    expect((http.requests.at(-1)?.body as { role: string }).role).toBe("CLIENT");
  });

  it("never grants itself permissions upon registration", async () => {
    const { http, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());
    http.on("POST", "/api/v1/devices", { status: 201, body: { data: { id: "d" } } });

    await session.login("alex@example.test", "password");
    await session.registerDevice({
      name: "Laptop",
      publicKeyPem: "key",
      type: "WINDOWS_PC",
      platform: "WINDOWS",
      role: "BOTH",
    });

    const body = http.requests.at(-1)?.body as {
      role: string;
      type: string;
      grantedPermissions: string[];
    };
    expect(body).toMatchObject({ role: "BOTH", type: "WINDOWS_PC" });
    expect(body.grantedPermissions).toEqual([]);
  });

  it("binds to existing registered device without creating duplicate", async () => {
    const { http, storage, session } = makeSession();
    http.on("POST", "/api/v1/auth/login", loginResponse());

    await session.login("alex@example.test", "password");
    const before = http.countOf("POST", "/api/v1/devices");

    await session.bindDevice("device-laptop");

    expect(session.deviceId).toBe("device-laptop");
    expect(storage.values.get("nexus.device")).toBe("device-laptop");
    expect(http.countOf("POST", "/api/v1/devices")).toBe(before);
  });
});
