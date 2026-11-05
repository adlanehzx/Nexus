import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryPushTokenStore,
  PushNotificationService,
} from "../src/services/push-notifications.js";
import { createAccount, makeApi, registerDevice, type ApiHarness } from "./harness.js";

const report = (type: string, queuedFor: string[]) =>
  ({ event: { type, secret: "private task title" }, deliveredTo: [], queuedFor }) as never;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("PushNotificationService", () => {
  it("sends fixed text to unreachable devices, with the route to open", async () => {
    const store = new InMemoryPushTokenStore();
    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse({ data: [{ status: "ok" }] })));
    const push = new PushNotificationService({ store, fetchFn: fetchFn });
    await push.register({
      deviceId: "d",
      userId: "u",
      token: "ExponentPushToken[a]",
      provider: "expo",
    });

    await push.deliver(report("confirmation.required", ["d"]));

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual([
      {
        to: "ExponentPushToken[a]",
        title: "NEXUS",
        body: "An action is waiting for your decision.",
        data: { route: "/" },
      },
    ]);
    expect(body).not.toContain("private task title");
  });

  it("sends nothing for connected devices, unknown events or devices without a token", async () => {
    const store = new InMemoryPushTokenStore();
    const fetchFn = vi.fn();
    const push = new PushNotificationService({ store, fetchFn: fetchFn as never });
    await push.register({ deviceId: "d", userId: "u", token: "t", provider: "expo" });

    await push.deliver(report("task.failed", []));
    await push.deliver(report("message.delta", ["d"]));
    await push.deliver(report("task.failed", ["other"]));

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("forgets a token Expo reports as no longer registered", async () => {
    const store = new InMemoryPushTokenStore();
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          data: [{ status: "error", details: { error: "DeviceNotRegistered" } }],
        }),
      ),
    );
    const push = new PushNotificationService({ store, fetchFn: fetchFn });
    await push.register({ deviceId: "d", userId: "u", token: "gone", provider: "expo" });

    await push.deliver(report("task.completed", ["d"]));

    await expect(store.listForDevices(["d"])).resolves.toEqual([]);
  });

  it("swallows a failing provider and reports it", async () => {
    const onError = vi.fn();
    const store = new InMemoryPushTokenStore();
    const push = new PushNotificationService({
      store,
      fetchFn: (() => Promise.resolve(jsonResponse({}, 500))),
      onError,
    });
    await push.register({ deviceId: "d", userId: "u", token: "t", provider: "expo" });

    await expect(push.deliver(report("task.failed", ["d"]))).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("push token routes", () => {
  let harness: ApiHarness | undefined;

  afterEach(async () => harness?.close());

  it("lets only the owner register, and forgets the token on revocation", async () => {
    harness = await makeApi();
    const owner = await createAccount(harness, "push-owner@example.test");
    const other = await createAccount(harness, "push-other@example.test");
    const { device } = await registerDevice(harness, owner, {
      name: "phone",
      role: "BOTH",
      type: "ANDROID",
      platform: "ANDROID",
      trust: true,
    });
    const url = `/api/v1/devices/${device.id}/push-token`;
    const payload = { token: "ExponentPushToken[a]", provider: "expo" };
    const store = harness.app.services.pushTokenStore;

    const foreign = await harness.app.inject({
      method: "POST",
      url,
      headers: other.authorization,
      payload,
    });
    expect([403, 404]).toContain(foreign.statusCode);
    await expect(store.listForDevices([device.id])).resolves.toEqual([]);

    const created = await harness.app.inject({
      method: "POST",
      url,
      headers: owner.authorization,
      payload,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json<{ data: unknown }>().data).toEqual({ registered: true });
    await expect(store.listForDevices([device.id])).resolves.toHaveLength(1);

    const removed = await harness.app.inject({
      method: "DELETE",
      url,
      headers: owner.authorization,
    });
    expect(removed.json<{ data: unknown }>().data).toEqual({ registered: false });
    await expect(store.listForDevices([device.id])).resolves.toEqual([]);

    await harness.app.inject({ method: "POST", url, headers: owner.authorization, payload });
    // A stranger naming this device at logout does not unregister it.
    await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: other.authorization,
      payload: { deviceId: device.id },
    });
    await expect(store.listForDevices([device.id])).resolves.toHaveLength(1);

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: owner.authorization,
      payload: { deviceId: device.id },
    });
    await expect(store.listForDevices([device.id])).resolves.toEqual([]);

    const again = await createAccount(harness, "push-owner-2@example.test");
    const { device: second } = await registerDevice(harness, again, {
      name: "phone 2",
      role: "BOTH",
      type: "ANDROID",
      platform: "ANDROID",
      trust: true,
    });
    await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${second.id}/push-token`,
      headers: again.authorization,
      payload,
    });
    const revoked = await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${second.id}/revoke`,
      headers: again.authorization,
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    await expect(store.listForDevices([second.id])).resolves.toEqual([]);
  });
});
