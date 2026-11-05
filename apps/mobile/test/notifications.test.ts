import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

import { SERVER_TO_CLIENT } from "@nexus/protocol";
import { ApiError } from "../lib/errors.js";
import { alertForFrame, pushOutcomeLabel, registerForPush } from "../lib/notifications.js";

const pushModule = (granted = true) =>
  ({
    getPermissionsAsync: vi.fn(() => Promise.resolve({ granted })),
    getExpoPushTokenAsync: vi.fn(() => Promise.resolve({ data: "ExponentPushToken[x]" })),
  }) as unknown as NonNullable<NonNullable<Parameters<typeof registerForPush>[2]>["module"]>;

describe("alertForFrame", () => {
  it("alerts on what needs a person", () => {
    expect(
      alertForFrame(SERVER_TO_CLIENT.confirmationRequired, { description: "Send the email?" }),
    ).toMatchObject({ title: "Approval needed", body: "Send the email?", channel: "approvals" });
    expect(alertForFrame(SERVER_TO_CLIENT.taskFailed, { message: "Disk full" })).toMatchObject({
      title: "Mission failed",
      body: "Disk full",
    });
    expect(alertForFrame(SERVER_TO_CLIENT.taskCompleted, { status: "partial" })?.body).toMatch(
      /partial/,
    );
    expect(
      alertForFrame(SERVER_TO_CLIENT.notificationCreated, {
        title: "T",
        body: "B",
        severity: "error",
      }),
    ).toMatchObject({ title: "T", channel: "approvals" });
  });

  it("stays quiet on routine frames", () => {
    expect(alertForFrame(SERVER_TO_CLIENT.taskProgress, {})).toBeUndefined();
    expect(alertForFrame(SERVER_TO_CLIENT.messageDelta, {})).toBeUndefined();
  });
});

describe("registerForPush", () => {
  it("reports a build without a push project instead of claiming success", async () => {
    const register = vi.fn();
    const outcome = await registerForPush({ registerPushToken: register }, "d1", {
      module: pushModule(),
    });
    expect(outcome).toEqual({ state: "not-configured" });
    expect(register).not.toHaveBeenCalled();
    expect(pushOutcomeLabel(outcome)).toMatch(/while the app is connected/);
  });

  it("reports denied permission", async () => {
    expect(
      await registerForPush({ registerPushToken: vi.fn() }, "d1", {
        module: pushModule(false),
        projectId: "p",
      }),
    ).toEqual({ state: "permission-denied" });
  });

  it("reports a core without the route, which is today's reality", async () => {
    const register = vi.fn(() =>
      Promise.reject(new ApiError(404, "Resource not found.", "NOT_FOUND")),
    );
    expect(
      await registerForPush({ registerPushToken: register }, "d1", {
        module: pushModule(),
        projectId: "p",
      }),
    ).toEqual({ state: "server-unsupported" });
  });

  it("registers the token when the core accepts it", async () => {
    const register = vi.fn(() => Promise.resolve({}));
    expect(
      await registerForPush({ registerPushToken: register }, "d1", {
        module: pushModule(),
        projectId: "p",
      }),
    ).toEqual({ state: "registered" });
    expect(register).toHaveBeenCalledWith("d1", {
      token: "ExponentPushToken[x]",
      provider: "expo",
    });
  });

  it("reports a missing native module", async () => {
    expect(await registerForPush({ registerPushToken: vi.fn() }, "d1", {})).toMatchObject({
      state: "unavailable",
    });
  });
});
