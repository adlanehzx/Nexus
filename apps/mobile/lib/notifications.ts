import type { Href } from "expo-router";
import { Platform } from "react-native";
import type * as ExpoNotifications from "expo-notifications";
import Constants from "expo-constants";
import { SERVER_TO_CLIENT } from "@nexus/protocol";
import type { MobileApi } from "./api.js";
import { ApiError, describeFailure } from "./errors.js";

/**
 * System notifications.
 *
 * Two distinct paths, and the UI must not blur them:
 *
 *  - **Local**: built here from realtime frames, when they arrive while the app
 *    is not on screen. Works today, but only for as long as the OS keeps the
 *    socket alive, which on iOS is seconds.
 *  - **Push**: the token is registered with the core, which then has to deliver.
 *    The core has no such route yet (docs/BACKEND-GAPS.md), and the registration
 *    reports that instead of claiming success.
 */

export interface LocalAlert {
  title: string;
  body: string;
  channel: "approvals" | "activity";
  /** Screen opened when the notification is tapped. */
  route: string;
}

/** The frames worth interrupting someone for: done, needs you, went wrong. */
export function alertForFrame(
  type: string,
  payload: Record<string, unknown>,
): LocalAlert | undefined {
  const text = (key: string, fallback: string): string => {
    const value = payload[key];
    return typeof value === "string" && value.length > 0 ? value : fallback;
  };

  switch (type) {
    case SERVER_TO_CLIENT.confirmationRequired:
      return {
        title: "Approval needed",
        body: text("description", "NEXUS is waiting for your decision."),
        channel: "approvals",
        route: "/",
      };
    case SERVER_TO_CLIENT.taskCompleted:
      return {
        title: "Mission complete",
        body:
          payload.status === "partial"
            ? "Finished with partial results."
            : "Finished successfully.",
        channel: "activity",
        route: "/missions",
      };
    case SERVER_TO_CLIENT.taskFailed:
      return {
        title: "Mission failed",
        body: text("message", "A task could not be completed."),
        channel: "activity",
        route: "/missions",
      };
    case SERVER_TO_CLIENT.notificationCreated:
      return {
        title: text("title", "NEXUS"),
        body: text("body", ""),
        channel: payload.severity === "error" ? "approvals" : "activity",
        route: "/notifications",
      };
    default:
      return undefined;
  }
}

type NotificationsModule = typeof ExpoNotifications;

let cachedModule: NotificationsModule | null | undefined;

/** The module is partly unavailable in Expo Go: absence is a state, not a crash. */
function load(): NotificationsModule | undefined {
  if (cachedModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- may be absent at runtime
      cachedModule = require("expo-notifications") as NotificationsModule;
    } catch {
      cachedModule = null;
    }
  }
  return cachedModule ?? undefined;
}

let channelsReady = false;

async function ensureChannels(module: NotificationsModule): Promise<void> {
  if (channelsReady || Platform.OS !== "android") return;
  await module.setNotificationChannelAsync("approvals", {
    name: "Approvals and errors",
    importance: module.AndroidImportance.HIGH,
  });
  await module.setNotificationChannelAsync("activity", {
    name: "Mission activity",
    importance: module.AndroidImportance.DEFAULT,
  });
  channelsReady = true;
}

export type PermissionState = "granted" | "denied" | "undetermined" | "unavailable";

export async function notificationPermission(): Promise<PermissionState> {
  const module = load();
  if (module === undefined) return "unavailable";
  try {
    const { granted, canAskAgain } = await module.getPermissionsAsync();
    return granted ? "granted" : canAskAgain ? "undetermined" : "denied";
  } catch {
    return "unavailable";
  }
}

/** Asked only from an explicit user action: a prompt at launch is usually refused for good. */
export async function requestNotificationPermission(): Promise<PermissionState> {
  const module = load();
  if (module === undefined) return "unavailable";
  try {
    await ensureChannels(module);
    const { granted } = await module.requestPermissionsAsync();
    return granted ? "granted" : "denied";
  } catch {
    return "unavailable";
  }
}

export async function presentLocalAlert(alert: LocalAlert): Promise<void> {
  const module = load();
  if (module === undefined) return;
  try {
    await ensureChannels(module);
    await module.scheduleNotificationAsync({
      content: { title: alert.title, body: alert.body, data: { route: alert.route } },
      trigger: Platform.OS === "android" ? { channelId: alert.channel } : null,
    });
  } catch {
    // Permission withdrawn in system settings: the in-app list still has the event.
  }
}

/** Opens the screen a tapped notification points to. Returns the unsubscribe. */
export function onNotificationTapped(open: (route: Href) => void): () => void {
  const module = load();
  if (module === undefined) return () => undefined;
  try {
    const subscription = module.addNotificationResponseReceivedListener((response) => {
      const route = response.notification.request.content.data?.route;
      // A notification only ever opens a screen of this app, never an outside address.
      if (typeof route === "string" && route.startsWith("/") && !route.startsWith("//")) {
        open(route);
      }
    });
    return () => {
      subscription.remove();
    };
  } catch {
    return () => undefined;
  }
}

export type PushOutcome =
  | { state: "registered" }
  /** The core has no push route: local notifications remain the only path. */
  | { state: "server-unsupported" }
  /** Expo needs an EAS project to issue tokens; not configured in this build. */
  | { state: "not-configured" }
  | { state: "permission-denied" }
  | { state: "unavailable"; detail: string };

function configuredProjectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId;
}

export async function registerForPush(
  mobile: Pick<MobileApi, "registerPushToken">,
  deviceId: string,
  dependencies: {
    module?: Pick<NotificationsModule, "getPermissionsAsync" | "getExpoPushTokenAsync"> | undefined;
    projectId?: string | undefined;
  } = { module: load(), projectId: configuredProjectId() },
): Promise<PushOutcome> {
  const { module, projectId } = dependencies;
  if (module === undefined) return { state: "unavailable", detail: "Not supported by this build." };

  const permission = await module.getPermissionsAsync().catch(() => undefined);
  if (permission?.granted !== true) return { state: "permission-denied" };
  if (projectId === undefined) return { state: "not-configured" };

  try {
    const token = await module.getExpoPushTokenAsync({ projectId });
    await mobile.registerPushToken(deviceId, { token: token.data, provider: "expo" });
    return { state: "registered" };
  } catch (cause) {
    // The device was just read from this core, so a 404 here means the route.
    if (cause instanceof ApiError && cause.status === 404) return { state: "server-unsupported" };
    return { state: "unavailable", detail: describeFailure(cause).message };
  }
}

export function pushOutcomeLabel(outcome: PushOutcome): string {
  switch (outcome.state) {
    case "registered":
      return "Push notifications are active.";
    case "server-unsupported":
      return "This NEXUS core cannot send push yet. You are notified while the app is connected.";
    case "not-configured":
      return "This build has no push project configured. You are notified while the app is connected.";
    case "permission-denied":
      return "Notifications are turned off for NEXUS in system settings.";
    case "unavailable":
      return `Push is unavailable: ${outcome.detail}`;
  }
}
