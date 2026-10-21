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
 * Mobile push notification channel via the open ntfy protocol.
 *
 * Works with public ntfy instances (e.g. https://ntfy.sh) or self-hosted
 * instances without requiring Apple or Google developer accounts.
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
   * Publishes a push notification to configured ntfy topic.
   */
  async send(message: NotificationMessage): Promise<ChannelDeliveryResult> {
    if (!this.enabled) {
      return {
        channel: this.name,
        success: false,
        skippedReason: "ntfy channel disabled.",
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
      const actionLabel = message.actionTitle ?? "Open";
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
          error: `HTTP error ${response.status} from ntfy: ${text.slice(0, 200)}`,
        };
      }

      return { channel: this.name, success: true };
    } catch (cause) {
      const err = cause instanceof Error ? cause.message : String(cause);
      return {
        channel: this.name,
        success: false,
        error: `ntfy send failed to ${targetUrl}: ${err}`,
      };
    }
  }

  #mapPriority(priority: NotificationPriority): string {
    switch (priority) {
      case "urgent":
        return "5"; // max
      case "high":
        return "4"; // high
      case "default":
        return "3"; // default
      case "low":
        return "2"; // low
      case "min":
        return "1"; // min
      default:
        return "3";
    }
  }
}
