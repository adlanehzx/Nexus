import type {
  ChannelDeliveryResult,
  NotificationMessage,
  NotificationPriority,
  NtfyChannelConfig,
} from "../types.js";

export interface NtfyChannelOptions {
  config: NtfyChannelConfig;
  token?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}

/**
 * Canal de notifications mobiles push via le protocole ouvert ntfy.
 *
 * Fonctionne avec le service public gratuit https://ntfy.sh ou n'importe
 * quelle instance auto-hébergée, sans compte développeur Apple ou Google.
 */
export class NtfyChannel {
  readonly #config: NtfyChannelConfig;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: NtfyChannelOptions) {
    this.#config = options.config;
    this.#token = options.token;
    this.#fetch = options.fetchFn ?? globalThis.fetch;
  }

  readonly name = "ntfy";

  get enabled(): boolean {
    return this.#config.enabled;
  }

  /**
   * Publie une notification push vers le sujet ntfy configuré.
   */
  async send(message: NotificationMessage): Promise<ChannelDeliveryResult> {
    if (!this.enabled) {
      return {
        channel: this.name,
        success: false,
        skippedReason: "Canal ntfy désactivé.",
      };
    }

    const base = this.#config.serverUrl.replace(/\/$/, "");
    const topic = encodeURIComponent(this.#config.topic);
    const targetUrl = `${base}/${topic}`;

    const priorityHeader = this.#mapPriority(message.priority ?? "default");
    const tags = ["nexus", ...(message.tags ?? [])];
    if (message.priority === "urgent" || message.priority === "high") {
      tags.push("warning");
    }

    const headers: Record<string, string> = {
      Title: message.title,
      Priority: priorityHeader,
      Tags: tags.join(","),
    };

    if (this.#token) {
      headers.Authorization = `Bearer ${this.#token}`;
    }

    if (message.url) {
      headers.Click = message.url;
      const actionLabel = message.actionTitle ?? "Ouvrir";
      headers.Actions = `view, ${actionLabel}, ${message.url}`;
    }

    try {
      const response = await this.#fetch(targetUrl, {
        method: "POST",
        headers,
        body: message.body,
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return {
          channel: this.name,
          success: false,
          error: `Erreur HTTP ${response.status} de ntfy: ${text.slice(0, 200)}`,
        };
      }

      return { channel: this.name, success: true };
    } catch (cause) {
      const err = cause instanceof Error ? cause.message : String(cause);
      return {
        channel: this.name,
        success: false,
        error: `Échec d'envoi ntfy vers ${targetUrl}: ${err}`,
      };
    }
  }

  #mapPriority(priority: NotificationPriority): string {
    switch (priority) {
      case "urgent":
        return "5";
      case "high":
        return "4";
      case "default":
        return "3";
      case "low":
        return "2";
      case "min":
        return "1";
      default:
        return "3";
    }
  }
}
