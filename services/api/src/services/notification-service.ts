import { newCorrelationId } from "@nexus/shared";
import type { EventRouter } from "@nexus/devices";
import type { NotificationDispatcher, NotificationPriority } from "@nexus/notifications";
import type { Notification, NotificationStore } from "./stores.js";

/**
 * Notifications, produced **centrally**.
 *
 * This is an architectural decision, not an implementation convenience. If
 * each client decided what to notify, an iPhone and a laptop would display
 * different information for the same event, and a task completed while
 * the iPhone was powered off would produce nothing at all.
 *
 * Here, a notification is **created once**, persisted, then broadcast to all
 * user clients through the existing router. An offline client
 * retrieves it from its queue upon returning; an active client sees it immediately.
 * Both see the exact same notification.
 *
 * Additionally, NotificationDispatcher relays alerts to external channels
 * (desktop notify-send, mobile push ntfy, Discord/Telegram webhooks)
 * applying quiet hours and grouping.
 */

export interface NotificationServiceOptions {
  store: NotificationStore;
  router: EventRouter;
  dispatcher?: NotificationDispatcher | undefined;
  dashboardBaseUrl?: string | undefined;
  now?: () => Date;
}

export interface CreateNotificationInput {
  userId: string;
  title: string;
  body: string;
  severity?: "info" | "warning" | "error" | "critical" | undefined;
  /**
   * Device that originated the action producing the notification.
   *
   * Transmitted as-is in the event: the originating client already knows what
   * occurred and can present it differently, or silence it.
   */
  originClientDeviceId?: string | null | undefined;
  url?: string | undefined;
  actionTitle?: string | undefined;
  tags?: string[] | undefined;
  groupKey?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export class NotificationService {
  readonly #store: NotificationStore;
  readonly #router: EventRouter;
  readonly #dispatcher: NotificationDispatcher | undefined;
  readonly #dashboardBaseUrl: string;

  constructor(options: NotificationServiceOptions) {
    this.#store = options.store;
    this.#router = options.router;
    this.#dispatcher = options.dispatcher;
    this.#dashboardBaseUrl = options.dashboardBaseUrl ?? "http://localhost:3000";
  }

  get dispatcher(): NotificationDispatcher | undefined {
    return this.#dispatcher;
  }

  /**
   * Creates a notification and broadcasts it (internal WebSocket + external channels).
   *
   * Persistence precedes broadcast, and order matters: if broadcast
   * fails, the notification still exists and will be read on the next API
   * call. In reverse, an offline client would lose the information.
   */
  async create(input: CreateNotificationInput): Promise<Notification> {
    const storeSeverity = input.severity === "critical" ? "error" : (input.severity ?? "info");
    const notification = await this.#store.create({
      userId: input.userId,
      title: input.title,
      body: input.body,
      severity: storeSeverity,
      originClientDeviceId: input.originClientDeviceId ?? null,
    });

    await this.#router.emit({
      type: "notification.created",
      userId: input.userId,
      correlationId: newCorrelationId(),
      originClientDeviceId: notification.originClientDeviceId,
      payload: {
        notificationId: notification.id,
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
      },
    });

    // External dispatch to desktop, ntfy, or webhooks
    if (this.#dispatcher) {
      const priority = this.#mapSeverityToPriority(input.severity ?? "info");
      void this.#dispatcher
        .dispatch({
          id: notification.id,
          title: notification.title,
          body: notification.body,
          priority,
          tags: input.tags,
          url: input.url,
          actionTitle: input.actionTitle,
          groupKey: input.groupKey,
          userId: input.userId,
          metadata: input.metadata,
        })
        .catch(() => {
          // Errors from external channels are intercepted and non-blocking
        });
    }

    return notification;
  }

  #mapSeverityToPriority(severity: string): NotificationPriority {
    switch (severity) {
      case "critical":
        return "urgent";
      case "error":
        return "high";
      case "warning":
        return "default";
      case "info":
      default:
        return "low";
    }
  }

  /**
   * Notifies the outcome of a task.
   */
  async notifyTaskOutcome(input: {
    userId: string;
    taskId: string;
    title: string;
    status: "succeeded" | "partial" | "failed" | "cancelled";
    originClientDeviceId: string | null;
    detail?: string | undefined;
  }): Promise<Notification | undefined> {
    const severity =
      input.status === "failed" ? "error" : input.status === "succeeded" ? "info" : "warning";

    const body =
      input.status === "succeeded"
        ? (input.detail ?? "The task has completed.")
        : input.status === "partial"
          ? "Some steps did not complete."
          : input.status === "cancelled"
            ? "The task was cancelled."
            : (input.detail ?? "The task failed.");

    const taskUrl = `${this.#dashboardBaseUrl.replace(/\/$/, "")}/dashboard?tab=tasks&taskId=${encodeURIComponent(input.taskId)}`;

    return this.create({
      userId: input.userId,
      title: input.title,
      body,
      severity,
      originClientDeviceId: input.originClientDeviceId,
      url: taskUrl,
      actionTitle: "View task",
      groupKey: `task-${input.taskId}`,
      tags: ["task", input.status],
    });
  }
}
