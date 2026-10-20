import { DesktopChannel } from "./channels/desktop.js";
import { NtfyChannel } from "./channels/ntfy.js";
import { WebhookChannel } from "./channels/webhook.js";
import { isQuietHours, NotificationThrottler } from "./policy.js";
import type {
  ChannelDeliveryResult,
  DeliveryReport,
  NotificationMessage,
  NotificationsConfig,
} from "./types.js";

export type SecretResolver = (tokenRef: string) => Promise<string | undefined>;

export interface NotificationDispatcherOptions {
  config: NotificationsConfig;
  resolveSecret?: SecretResolver | undefined;
  fetchFn?: typeof fetch | undefined;
  desktopExecutablePath?: string | undefined;
}

export class NotificationDispatcher {
  #config: NotificationsConfig;
  readonly #resolveSecret: SecretResolver | undefined;
  readonly #fetch: typeof fetch | undefined;
  readonly #desktopExecutablePath: string | undefined;
  readonly #throttler = new NotificationThrottler();

  constructor(options: NotificationDispatcherOptions) {
    this.#config = options.config;
    this.#resolveSecret = options.resolveSecret;
    this.#fetch = options.fetchFn;
    this.#desktopExecutablePath = options.desktopExecutablePath;
  }

  get config(): NotificationsConfig {
    return this.#config;
  }

  updateConfig(newConfig: NotificationsConfig): void {
    this.#config = newConfig;
  }

  /**
   * Distribue une notification vers tous les canaux configurés et autorisés.
   */
  async dispatch(message: NotificationMessage, now = new Date()): Promise<DeliveryReport> {
    const timestamp = now.toISOString();

    if (!this.#config.enabled) {
      return {
        messageId: message.id,
        timestamp,
        channels: [
          {
            channel: "all",
            success: false,
            skippedReason: "Système de notifications externes désactivé globalement.",
          },
        ],
      };
    }

    // 1. Plages silencieuses
    const inQuietHours = isQuietHours(now, this.#config.quietHours);
    const isUrgent = message.priority === "urgent" || message.priority === "high";

    if (inQuietHours && (!isUrgent || !this.#config.quietHours.allowUrgent)) {
      return {
        messageId: message.id,
        timestamp,
        channels: [
          {
            channel: "all",
            success: false,
            skippedReason: `Notification ignorée : plage silencieuse active (${this.#config.quietHours.start} - ${this.#config.quietHours.end} ${this.#config.quietHours.timezone}).`,
          },
        ],
      };
    }

    // 2. Régulation de flux (throttling / regroupement)
    let dispatchedMessage = message;
    if (this.#config.grouping.enabled && message.groupKey) {
      const throttle = this.#throttler.evaluate(
        message,
        this.#config.grouping.windowSeconds,
        now.getTime(),
      );

      if (!throttle.shouldSend) {
        return {
          messageId: message.id,
          timestamp,
          channels: [
            {
              channel: "all",
              success: false,
              skippedReason: `Notification regroupée (${throttle.suppressedCount} occurrences dans la fenêtre de ${this.#config.grouping.windowSeconds}s).`,
            },
          ],
        };
      }

      if (throttle.suppressedCount > 0) {
        dispatchedMessage = {
          ...message,
          title: `${message.title} (+${throttle.suppressedCount} similaire(s))`,
        };
      }
    }

    // 3. Résolution des canaux actifs
    const channels = await this.#buildActiveChannels();
    if (channels.length === 0) {
      return {
        messageId: message.id,
        timestamp,
        channels: [
          {
            channel: "none",
            success: false,
            skippedReason: "Aucun canal de notification externe n'est activé.",
          },
        ],
      };
    }

    // 4. Dispatch parallèle
    const results = await Promise.allSettled(
      channels.map(async (c) => {
        try {
          return await c.send(dispatchedMessage);
        } catch (cause) {
          const err = cause instanceof Error ? cause.message : String(cause);
          return {
            channel: c.name,
            success: false,
            error: `Exception inattendue dans le canal ${c.name}: ${err}`,
          };
        }
      }),
    );

    const deliveryResults: ChannelDeliveryResult[] = results.map((res, idx) => {
      if (res.status === "fulfilled") {
        return res.value;
      }
      return {
        channel: channels[idx]?.name ?? "unknown",
        success: false,
        error: res.reason instanceof Error ? res.reason.message : String(res.reason),
      };
    });

    return {
      messageId: message.id,
      timestamp,
      channels: deliveryResults,
    };
  }

  /**
   * Émet un message de test sur tous les canaux actifs.
   */
  async sendTest(): Promise<DeliveryReport> {
    const testMessage: NotificationMessage = {
      id: "test-" + Date.now(),
      title: "Test de notification NEXUS",
      body: "Ce message confirme la bonne liaison de vos canaux de notification externes NEXUS.",
      priority: "high",
      tags: ["test", "nexus"],
      url: `${this.#config.dashboardBaseUrl.replace(/\/$/, "")}/dashboard`,
      actionTitle: "Ouvrir NEXUS",
      createdAt: new Date(),
    };

    return this.dispatch(testMessage);
  }

  async #buildActiveChannels(): Promise<
    { name: string; send: (msg: NotificationMessage) => Promise<ChannelDeliveryResult> }[]
  > {
    const active: {
      name: string;
      send: (msg: NotificationMessage) => Promise<ChannelDeliveryResult>;
    }[] = [];

    // Desktop
    if (this.#config.desktop.enabled) {
      const desktop = new DesktopChannel({
        config: this.#config.desktop,
        executablePath: this.#desktopExecutablePath,
      });
      active.push(desktop);
    }

    // ntfy
    if (this.#config.ntfy.enabled) {
      let token: string | undefined;
      if (this.#config.ntfy.tokenRef && this.#resolveSecret) {
        token = await this.#resolveSecret(this.#config.ntfy.tokenRef);
      }
      const ntfy = new NtfyChannel({
        config: this.#config.ntfy,
        token,
        fetchFn: this.#fetch,
      });
      active.push(ntfy);
    }

    // Webhook
    if (this.#config.webhook?.enabled && this.#config.webhook.url) {
      let token: string | undefined;
      if (this.#config.webhook.tokenRef && this.#resolveSecret) {
        token = await this.#resolveSecret(this.#config.webhook.tokenRef);
      }
      const webhook = new WebhookChannel({
        config: this.#config.webhook,
        token,
        fetchFn: this.#fetch,
      });
      active.push(webhook);
    }

    return active;
  }
}
