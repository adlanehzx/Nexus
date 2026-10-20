import { newCorrelationId } from "@nexus/shared";
import type { EventRouter } from "@nexus/devices";
import type { NotificationDispatcher, NotificationPriority } from "@nexus/notifications";
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
 *
 * En complément, le NotificationDispatcher relaie les alertes vers les canaux
 * externes (desktop notify-send, mobile push ntfy, webhooks Discord/Telegram)
 * en appliquant les plages silencieuses et le regroupement.
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
   * Appareil à l'origine de ce qui a produit la notification.
   *
   * Transmis tel quel dans l'événement : le client d'origine sait déjà ce qui
   * s'est passé et peut la présenter autrement, voire ne pas la sonner.
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
   * Crée une notification et la diffuse (WebSocket interne + canaux externes).
   *
   * La persistance précède la diffusion, et l'ordre compte : si la diffusion
   * échoue, la notification existe quand même et sera lue au prochain appel de
   * l'API. Dans l'autre sens, un client hors ligne perdrait l'information.
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

    // Envoi externe vers le bureau, ntfy ou les webhooks
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
          // Les erreurs des canaux externes sont interceptées et ne bloquent pas
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
   * Notifie l'issue d'une tâche.
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
        ? (input.detail ?? "La tâche est terminée.")
        : input.status === "partial"
          ? "Certaines étapes n'ont pas abouti."
          : input.status === "cancelled"
            ? "La tâche a été annulée."
            : (input.detail ?? "La tâche a échoué.");

    const taskUrl = `${this.#dashboardBaseUrl.replace(/\/$/, "")}/dashboard?tab=tasks&taskId=${encodeURIComponent(input.taskId)}`;

    return this.create({
      userId: input.userId,
      title: input.title,
      body,
      severity,
      originClientDeviceId: input.originClientDeviceId,
      url: taskUrl,
      actionTitle: "Voir la tâche",
      groupKey: `task-${input.taskId}`,
      tags: ["task", input.status],
    });
  }
}
