import type {
  ChannelDeliveryResult,
  NotificationMessage,
  WebhookChannelConfig,
} from "../types.js";

export interface WebhookChannelOptions {
  config: WebhookChannelConfig;
  token?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}

/**
 * Canal de notification par webhook externe (Discord, Telegram, Apprise ou JSON générique).
 */
export class WebhookChannel {
  readonly #config: WebhookChannelConfig;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: WebhookChannelOptions) {
    this.#config = options.config;
    this.#token = options.token;
    this.#fetch = options.fetchFn ?? globalThis.fetch;
  }

  readonly name = "webhook";

  get enabled(): boolean {
    return this.#config.enabled && Boolean(this.#config.url);
  }

  /**
   * Transmet la notification au webhook configuré.
   */
  async send(message: NotificationMessage): Promise<ChannelDeliveryResult> {
    if (!this.enabled || !this.#config.url) {
      return {
        channel: this.name,
        success: false,
        skippedReason: "Canal webhook non configuré ou inactif.",
      };
    }

    const payload = this.#buildPayload(message);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "NEXUS-Notification-Engine/1.0",
    };

    if (this.#token) {
      headers.Authorization = `Bearer ${this.#token}`;
    }

    try {
      const response = await this.#fetch(this.#config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return {
          channel: this.name,
          success: false,
          error: `Erreur HTTP ${response.status} du webhook: ${text.slice(0, 200)}`,
        };
      }

      return { channel: this.name, success: true };
    } catch (cause) {
      const err = cause instanceof Error ? cause.message : String(cause);
      return {
        channel: this.name,
        success: false,
        error: `Échec d'envoi webhook vers ${this.#config.url}: ${err}`,
      };
    }
  }

  #buildPayload(message: NotificationMessage): Record<string, unknown> {
    switch (this.#config.format) {
      case "discord":
        return this.#formatDiscord(message);
      case "telegram":
        return this.#formatTelegram(message);
      case "apprise":
        return this.#formatApprise(message);
      case "generic":
      default:
        return this.#formatGeneric(message);
    }
  }

  #formatDiscord(message: NotificationMessage): Record<string, unknown> {
    // Discord Embed Colors: Green (info), Orange (warning), Red (error/urgent)
    let color = 0x3498db; // blue
    if (message.priority === "urgent" || message.priority === "high") {
      color = 0xe74c3c; // red
    } else if (message.priority === "default") {
      color = 0xf39c12; // orange
    } else if (message.priority === "low" || message.priority === "min") {
      color = 0x2ecc71; // green
    }

    const embed: Record<string, unknown> = {
      title: message.title,
      description: message.body,
      color,
      timestamp: (message.createdAt ?? new Date()).toISOString(),
      footer: { text: "NEXUS Agent Engine" },
    };

    if (message.url) {
      embed.url = message.url;
    }

    return { embeds: [embed] };
  }

  #formatTelegram(message: NotificationMessage): Record<string, unknown> {
    let text = `<b>${this.#escapeHtml(message.title)}</b>\n${this.#escapeHtml(message.body)}`;
    if (message.url) {
      const label = message.actionTitle ?? "Accéder au dashboard NEXUS";
      text += `\n\n<a href="${message.url}">${this.#escapeHtml(label)}</a>`;
    }

    return {
      text,
      parse_mode: "HTML",
    };
  }

  #formatApprise(message: NotificationMessage): Record<string, unknown> {
    let type = "info";
    if (message.priority === "urgent" || message.priority === "high") {
      type = "failure";
    } else if (message.priority === "default") {
      type = "warning";
    }

    const payload: Record<string, unknown> = {
      title: message.title,
      body: message.body,
      type,
    };

    if (message.url) {
      payload.url = message.url;
    }

    return payload;
  }

  #formatGeneric(message: NotificationMessage): Record<string, unknown> {
    return {
      id: message.id,
      title: message.title,
      body: message.body,
      priority: message.priority ?? "default",
      tags: message.tags ?? [],
      url: message.url,
      actionTitle: message.actionTitle,
      groupKey: message.groupKey,
      timestamp: (message.createdAt ?? new Date()).toISOString(),
      userId: message.userId,
      metadata: message.metadata,
    };
  }

  #escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}
