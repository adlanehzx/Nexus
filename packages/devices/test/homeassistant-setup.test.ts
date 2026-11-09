import { describe, expect, it, vi } from "vitest";
import {
  HomeAssistantSetupError,
  acceptDiscoveredIntegration,
  listDiscoveredIntegrations,
  loginHomeAssistant,
  onboardHomeAssistant,
  probeHomeAssistant,
  type HaSocket,
} from "../src/index.js";

const URL_HA = "http://ha.local:8123";

/** WebSocket that accepts `access-1` and mints `ll-token`. */
function socketFactory(): (url: string) => HaSocket {
  return () => {
    const listeners = new Map<string, ((event: never) => void)[]>();
    const emit = (type: string, event: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener(event as never);
    };
    const socket: HaSocket = {
      addEventListener: (type: string, listener: (event: never) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      send: (data: string) => {
        const message = JSON.parse(data) as Record<string, unknown>;
        queueMicrotask(() => {
          if (message.type === "auth") {
            emit("message", {
              data: JSON.stringify({
                type: message.access_token === "access-1" ? "auth_ok" : "auth_invalid",
              }),
            });
          } else if (message.type === "auth/long_lived_access_token") {
            emit("message", {
              data: JSON.stringify({ id: 1, type: "result", success: true, result: "ll-token" }),
            });
          }
        });
      },
      close: () => undefined,
    };
    queueMicrotask(() => emit("message", { data: JSON.stringify({ type: "auth_required" }) }));
    return socket;
  };
}

type Route = (body: unknown, init: RequestInit) => { status: number; body: unknown };

function fakeHa(routes: Record<string, Route>) {
  const calls: { path: string; body: unknown; auth: string | undefined }[] = [];
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const raw = typeof init?.body === "string" ? init.body : "";
    const contentType =
      (init?.headers as Record<string, string> | undefined)?.["content-type"] ?? "";
    const body =
      raw === ""
        ? null
        : contentType.includes("json")
          ? (JSON.parse(raw) as unknown)
          : Object.fromEntries(new URLSearchParams(raw));
    calls.push({
      path: url.pathname,
      body,
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    const route = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    const result =
      route === undefined ? { status: 404, body: "not found" } : route(body, init ?? {});
    return Promise.resolve(new Response(JSON.stringify(result.body), { status: result.status }));
  });
  return { fetch: fetchMock, calls, socketFactory: socketFactory() };
}

describe("Home Assistant hands-free setup", () => {
  it("detects a fresh install waiting for its owner", async () => {
    const ha = fakeHa({
      "GET /api/onboarding": () => ({
        status: 200,
        body: [
          { step: "user", done: false },
          { step: "core_config", done: false },
        ],
      }),
    });
    const probe = await probeHomeAssistant(URL_HA, ha);
    expect(probe).toMatchObject({
      reachable: true,
      isHomeAssistant: true,
      onboarded: false,
      pendingSteps: ["user", "core_config"],
    });
  });

  it("reports an unreachable URL without throwing", async () => {
    const probe = await probeHomeAssistant(URL_HA, {
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(probe).toMatchObject({ reachable: false, isHomeAssistant: false });
  });

  it("onboards a fresh install and returns a long-lived token", async () => {
    const ha = fakeHa({
      "POST /api/onboarding/users": () => ({ status: 200, body: { auth_code: "code-1" } }),
      "POST /auth/token": (body) => ({
        status: 200,
        body:
          (body as Record<string, string>).code === "code-1" ? { access_token: "access-1" } : {},
      }),
      "POST /api/onboarding/core_config": () => ({ status: 200, body: {} }),
      "POST /api/onboarding/analytics": () => ({ status: 200, body: {} }),
      "POST /api/onboarding/integration": () => ({ status: 200, body: { auth_code: "x" } }),
    });
    const result = await onboardHomeAssistant(
      URL_HA,
      { name: "Alex", username: "alex", password: "pw-123456" },
      ha,
    );
    expect(result.token).toBe("ll-token");
    const user = ha.calls.find((c) => c.path === "/api/onboarding/users");
    expect(user?.body).toMatchObject({ client_id: `${URL_HA}/`, username: "alex" });
    expect(ha.calls.find((c) => c.path === "/api/onboarding/core_config")?.auth).toBe(
      "Bearer access-1",
    );
  });

  it("refuses to onboard an install that already has an owner", async () => {
    const ha = fakeHa({
      "POST /api/onboarding/users": () => ({
        status: 403,
        body: { message: "User step already done" },
      }),
    });
    await expect(
      onboardHomeAssistant(URL_HA, { name: "A", username: "a", password: "p" }, ha),
    ).rejects.toMatchObject({
      reason: "already_onboarded",
    });
  });

  it("signs in with username/password, and reports wrong credentials or MFA clearly", async () => {
    let answer: unknown = { type: "create_entry", result: "code-1" };
    const ha = fakeHa({
      "POST /auth/login_flow": () => ({
        status: 200,
        body: { flow_id: "f1", type: "form", step_id: "init" },
      }),
      "POST /auth/login_flow/f1": () => ({ status: 200, body: answer }),
      "POST /auth/token": () => ({ status: 200, body: { access_token: "access-1" } }),
    });
    expect((await loginHomeAssistant(URL_HA, { username: "alex", password: "pw" }, ha)).token).toBe(
      "ll-token",
    );

    answer = { type: "form", step_id: "init", errors: { base: "invalid_auth" } };
    await expect(
      loginHomeAssistant(URL_HA, { username: "alex", password: "bad" }, ha),
    ).rejects.toMatchObject({
      reason: "invalid_auth",
    });
    answer = { type: "form", step_id: "mfa" };
    const error = await loginHomeAssistant(URL_HA, { username: "alex", password: "pw" }, ha).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HomeAssistantSetupError);
    expect((error as HomeAssistantSetupError).reason).toBe("mfa_required");
  });

  it("lists integrations HA discovered on the LAN and confirms them", async () => {
    const client = {
      command: vi.fn(() =>
        Promise.resolve([
          {
            flow_id: "a1b2c3d4e5f6a7b8",
            handler: "hue",
            context: { source: "zeroconf", title_placeholders: { name: "Hue Bridge" } },
          },
          { flow_id: "b1b2c3d4e5f6a7b8", handler: "cast", context: { source: "user" } },
        ]),
      ),
      configFlowStep: vi.fn(() => Promise.resolve({ type: "form", step_id: "link" })),
    };
    expect(await listDiscoveredIntegrations(client)).toEqual([
      { flowId: "a1b2c3d4e5f6a7b8", domain: "hue", source: "zeroconf", title: "Hue Bridge" },
    ]);
    expect(await acceptDiscoveredIntegration(client, "a1b2c3d4e5f6a7b8")).toEqual({
      status: "needs_input",
      detail: "link",
    });
  });
});
