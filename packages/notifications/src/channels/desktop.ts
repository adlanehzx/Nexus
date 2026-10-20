import { spawn } from "node:child_process";
import type {
  ChannelDeliveryResult,
  DesktopChannelConfig,
  NotificationMessage,
  NotificationPriority,
} from "../types.js";

export interface DesktopChannelOptions {
  config: DesktopChannelConfig;
  executablePath?: string | undefined;
}

/**
 * Canal de notifications bureau Linux natif via notify-send.
 */
export class DesktopChannel {
  readonly #config: DesktopChannelConfig;
  readonly #executablePath: string;

  constructor(options: DesktopChannelOptions) {
    this.#config = options.config;
    this.#executablePath = options.executablePath ?? "/usr/bin/notify-send";
  }

  readonly name = "desktop";

  get enabled(): boolean {
    return this.#config.enabled;
  }

  /**
   * Émet une notification sur le bureau.
   */
  async send(message: NotificationMessage): Promise<ChannelDeliveryResult> {
    if (!this.enabled) {
      return {
        channel: this.name,
        success: false,
        skippedReason: "Canal bureau désactivé.",
      };
    }

    const urgency = this.#mapUrgency(message.priority ?? "default");
    const icon = this.#mapIcon(message.priority ?? "default");

    let body = message.body;
    if (message.url) {
      body += `\n${message.url}`;
    }

    const args = [
      "--app-name=NEXUS",
      `--urgency=${urgency}`,
      `--icon=${icon}`,
      message.title,
      body,
    ];

    try {
      await this.#runCommand(this.#executablePath, args);
      return { channel: this.name, success: true };
    } catch (cause) {
      const err = cause instanceof Error ? cause.message : String(cause);
      return {
        channel: this.name,
        success: false,
        error: `Échec notify-send: ${err}`,
      };
    }
  }

  #mapUrgency(priority: NotificationPriority): "low" | "normal" | "critical" {
    switch (priority) {
      case "urgent":
        return "critical";
      case "high":
        return "critical";
      case "low":
      case "min":
        return "low";
      case "default":
      default:
        return this.#config.urgency;
    }
  }

  #mapIcon(priority: NotificationPriority): string {
    switch (priority) {
      case "urgent":
      case "high":
        return "dialog-error";
      case "low":
      case "min":
        return "dialog-information";
      case "default":
      default:
        return "dialog-warning";
    }
  }

  async #runCommand(path: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(path, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      let stderr = "";
      proc.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      proc.once("error", reject);
      proc.once("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Exit code ${code}: ${stderr.trim()}`));
        }
      });
    });
  }
}
