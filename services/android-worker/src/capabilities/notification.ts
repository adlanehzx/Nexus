import { z } from "zod";
import type { LocalCapability } from "@nexus/worker-core";
import type { AndroidNotificationController } from "../ports.js";
import { AndroidPermissionDeniedError } from "../errors.js";

/**
 * `android.notification`.
 *
 * **Émettre une notification, et rien d'autre.**
 *
 * La distinction avec la lecture des notifications est fondamentale, et ce n'est
 * pas une nuance de vocabulaire : Android les traite comme deux mondes séparés.
 *
 * | | Émettre | Lire |
 * | --- | --- | --- |
 * | Mécanisme | `NotificationManager.notify()` | `NotificationListenerService` |
 * | Permission | `POST_NOTIFICATIONS` (Android 13+) | `BIND_NOTIFICATION_LISTENER_SERVICE` |
 * | Portée | ce que NEXUS écrit | **tout** ce que le téléphone reçoit |
 * | Activation | permission d'exécution ordinaire | écran de réglages dédié |
 *
 * La lecture donnerait accès aux messages, aux codes à usage unique, aux
 * notifications bancaires — de tout ce que l'utilisateur reçoit. Elle n'est pas
 * nécessaire ici, elle n'est pas implémentée, et un test vérifie qu'aucun
 * `NotificationListenerService` n'est déclaré au manifeste.
 */

export const notificationInputSchema = z.object({
  title: z.string().min(1).max(128),
  body: z.string().min(1).max(1_024),
  /**
   * Canal de notification.
   *
   * Un seul canal existe, et c'est délibéré : l'utilisateur peut couper les
   * notifications de NEXUS d'un geste, depuis les réglages du système, sans
   * avoir à démêler une arborescence de sous-canaux.
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
      "Affiche une notification sur le téléphone Android de l'utilisateur. " +
      "N'accède pas aux notifications reçues.",
    inputSchema: notificationInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Titre de la notification" },
        body: { type: "string", description: "Corps du message" },
      },
      required: ["title", "body"],
    },
    // MEDIUM : une notification est visible et peut afficher n'importe quel
    // texte sur l'écran de verrouillage de l'utilisateur.
    riskLevel: "MEDIUM",

    probe: () => dependencies.controller.canPostNotifications(),

    execute: async (input) => {
      // Revérifié à l'exécution : sur Android 13 et suivants, `POST_NOTIFICATIONS`
      // est une permission d'exécution, révocable à tout moment depuis les
      // réglages.
      if (!(await dependencies.controller.canPostNotifications())) {
        throw new AndroidPermissionDeniedError(
          "POST_NOTIFICATIONS",
          "Autorisez les notifications pour NEXUS Worker dans les réglages Android.",
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
