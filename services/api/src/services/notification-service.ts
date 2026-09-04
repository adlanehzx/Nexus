import { newCorrelationId } from "@nexus/shared";
import type { EventRouter } from "@nexus/devices";
import type { Notification, NotificationStore } from "./stores.js";

/**
 * Notifications, produites **au centre**.
 *
 * C'est une décision d'architecture, pas une commodité d'implémentation. Si
 * chaque client décidait quoi notifier, l'iPhone et le portable afficheraient
 * des choses différentes du même événement, et une tâche terminée pendant que
 * l'iPhone était éteint ne produirait rien du tout.
 *
 * Ici, une notification est **créée une fois**, persistée, puis diffusée à tous
 * les clients de l'utilisateur par le routeur existant. Un client absent la
 * retrouve dans sa file au retour ; un client présent la voit tout de suite. Les
 * deux voient la même.
 */

export interface NotificationServiceOptions {
  store: NotificationStore;
  router: EventRouter;
  now?: () => Date;
}

export interface CreateNotificationInput {
  userId: string;
  title: string;
  body: string;
  severity?: "info" | "warning" | "error";
  /**
   * Appareil à l'origine de ce qui a produit la notification.
   *
   * Transmis tel quel dans l'événement : le client d'origine sait déjà ce qui
   * s'est passé et peut la présenter autrement, voire ne pas la sonner.
   */
  originClientDeviceId?: string | null;
}

export class NotificationService {
  readonly #store: NotificationStore;
  readonly #router: EventRouter;

  constructor(options: NotificationServiceOptions) {
    this.#store = options.store;
    this.#router = options.router;
  }

  /**
   * Crée une notification et la diffuse.
   *
   * La persistance précède la diffusion, et l'ordre compte : si la diffusion
   * échoue, la notification existe quand même et sera lue au prochain appel de
   * l'API. Dans l'autre sens, un client hors ligne perdrait l'information.
   */
  async create(input: CreateNotificationInput): Promise<Notification> {
    const notification = await this.#store.create({
      userId: input.userId,
      title: input.title,
      body: input.body,
      severity: input.severity ?? "info",
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

    return notification;
  }

  /**
   * Notifie l'issue d'une tâche.
   *
   * Le seul endroit du système qui décide qu'une tâche mérite une notification.
   * La règle est simple et volontairement conservatrice : **on ne notifie pas un
   * succès complet**. L'utilisateur qui a lancé la tâche voit déjà les
   * événements arriver ; une notification de plus pour dire que tout va bien est
   * du bruit, et le bruit fait couper les notifications.
   */
  async notifyTaskOutcome(input: {
    userId: string;
    taskId: string;
    title: string;
    status: "succeeded" | "partial" | "failed" | "cancelled";
    originClientDeviceId: string | null;
    detail?: string;
  }): Promise<Notification | undefined> {
    // **Une tâche qui aboutit produit une notification, elle aussi.**
    //
    // Ce n'est pas du bruit : une tâche est une demande explicite de
    // l'utilisateur, pas un appel d'outil. « Lance mon projet et dis-moi quand
    // le serveur est prêt » n'a de sens que si quelque chose le lui dit — et
    // l'écran de la tâche ne le lui dira pas si le téléphone est dans sa poche.
    //
    // La gravité, elle, distingue : `info` pour une réussite, `warning` pour un
    // résultat partiel ou une annulation, `error` pour un échec. C'est elle qui
    // décide si le téléphone vibre.
    const severity =
      input.status === "failed" ? "error" : input.status === "succeeded" ? "info" : "warning";

    const body =
      input.status === "succeeded"
        ? (input.detail ?? "La tâche est terminée.")
        : input.status === "partial"
          ? "Certaines étapes n'ont pas abouti."
          : input.status === "cancelled"
            ? "La tâche a été annulée."
            : (input.detail ?? "La tâche a échoué.");

    return this.create({
      userId: input.userId,
      title: input.title,
      body,
      severity,
      originClientDeviceId: input.originClientDeviceId,
    });
  }
}
