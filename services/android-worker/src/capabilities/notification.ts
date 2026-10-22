import { z } from "zod";
import type { LocalCapability } from "@nexus/worker-core";
import type { AndroidNotificationController } from "../ports.js";
import { AndroidPermissionDeniedError } from "../errors.js";

/**
 * `android.notification`.
 *
 * Post notifications only.
 */

export const notificationInputSchema = z.object({
  title: z.string().min(1).max(128),
  body: z.string().min(1).max(1_024),
  /**
   * Notification channel.
   */
  channelId: z.literal("nexus.tasks").default("nexus.tasks"),
});

export type NotificationInput = z.infer<typeof notificationInputSchema>;

export interface NotificationDependencies {
  controller: AndroidNotificationController;
}

export function createNotificationCapability(
  dependencies: NotificationDependencies,
): LocalCapability<NotificationInput, { posted: boolean; notificationId: number }> {
  return {
    name: "android.notification",
    description:
      "Displays a notification on the user's Android phone. " +
      "Does not access received notifications.",
    inputSchema: notificationInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notification title" },
        body: { type: "string", description: "Message body" },
      },
      required: ["title", "body"],
    },
    riskLevel: "MEDIUM",

    probe: () => dependencies.controller.canPostNotifications(),

    execute: async (input) => {
      if (!(await dependencies.controller.canPostNotifications())) {
        throw new AndroidPermissionDeniedError(
          "POST_NOTIFICATIONS",
          "Allow notifications for NEXUS Worker in Android settings.",
        );
      }

      return dependencies.controller.notify({
        title: input.title,
        body: input.body,
        channelId: input.channelId,
      });
    },
  };
}
