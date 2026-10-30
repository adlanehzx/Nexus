import { createConnection } from "node:net";
import { z } from "zod";
import type { ToolDefinition } from "@nexus/tools";

const ACTION_KEYS = {
  wake: "KEYCODE_WAKEUP",
  sleep: "KEYCODE_SLEEP",
  home: "KEYCODE_HOME",
  volume_up: "KEYCODE_VOLUME_UP",
  volume_down: "KEYCODE_VOLUME_DOWN",
  mute: "KEYCODE_VOLUME_MUTE",
} as const;

export type FireTvAction = keyof typeof ACTION_KEYS;

function packet(command: string): Buffer {
  const body = Buffer.from(command, "utf8");
  return Buffer.concat([Buffer.from(body.length.toString(16).padStart(4, "0")), body]);
}

/** Restricted ADB client: only fixed Android key events can cross this boundary. */
export class FireTvService {
  readonly #serial: string;
  readonly #host: string;
  readonly #port: number;

  constructor(serial: string, server = "127.0.0.1:5037") {
    this.#serial = serial;
    const separator = server.lastIndexOf(":");
    this.#host = server.slice(0, separator);
    this.#port = Number(server.slice(separator + 1));
  }

  control(action: FireTvAction): Promise<{ action: FireTvAction; delivered: true }> {
    const key = ACTION_KEYS[action];
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.#host, port: this.#port });
      let stage: "transport" | "shell" | "output" = "transport";
      let buffered = Buffer.alloc(0);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error === undefined) resolve({ action, delivered: true });
        else reject(error);
      };
      socket.setTimeout(5_000, () => finish(new Error("ADB command timed out")));
      socket.once("error", (error) => finish(error));
      socket.once("connect", () => socket.write(packet(`host:transport:${this.#serial}`)));
      socket.on("data", (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        while (stage !== "output" && buffered.length >= 4) {
          const status = buffered.subarray(0, 4).toString("ascii");
          buffered = buffered.subarray(4);
          if (status !== "OKAY") {
            finish(new Error(`ADB rejected ${stage}: ${status}`));
            return;
          }
          if (stage === "transport") {
            stage = "shell";
            socket.write(packet(`shell:input keyevent ${key}`));
          } else {
            stage = "output";
          }
        }
      });
      socket.once("end", () => {
        if (stage === "output") finish();
        else finish(new Error(`ADB disconnected during ${stage}`));
      });
    });
  }
}

const actionSchema = z.enum(Object.keys(ACTION_KEYS) as [FireTvAction, ...FireTvAction[]]);

export function createFireTvTool(
  service: FireTvService,
): ToolDefinition<{ action: FireTvAction }, { action: FireTvAction; delivered: true }> {
  return {
    name: "home.tv_control",
    description:
      "Controls the studio Fire TV through a fixed allowlist. Use wake to turn it on through HDMI-CEC.",
    version: "1",
    inputSchema: z.object({ action: actionSchema }),
    outputSchema: z.object({ action: actionSchema, delivered: z.literal(true) }),
    riskLevel: "LOW",
    requiredPermissions: ["homeassistant.write"],
    requiresConfirmation: false,
    timeoutMs: 6_000,
    idempotent: false,
    summarize: ({ action }) => `Fire TV: ${action}`,
    execute: ({ action }) => service.control(action),
  };
}
