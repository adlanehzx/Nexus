import { request } from "node:http";
import type { BundledStatus } from "../../home-supervisor/supervisor.js";

/**
 * API side of the bundled Home Assistant toggle. The API never touches
 * Docker: it asks the home supervisor over a private Unix socket. When the
 * supervisor is not running (API started outside compose, supervisor
 * disabled), the toggle is reported as unavailable rather than failing.
 */

export type BundledHomeAssistantView =
  ({ available: true } & BundledStatus) | { available: false; reason: string };

export interface BundledHomeAssistantControl {
  status(): Promise<BundledHomeAssistantView>;
  setEnabled(enabled: boolean): Promise<BundledHomeAssistantView>;
}

export class SupervisorSocketClient implements BundledHomeAssistantControl {
  readonly #socketPath: string;
  readonly #timeoutMs: number;

  constructor(socketPath: string, timeoutMs = 10_000) {
    this.#socketPath = socketPath;
    this.#timeoutMs = timeoutMs;
  }

  status(): Promise<BundledHomeAssistantView> {
    return this.#call("GET", "/status");
  }

  setEnabled(enabled: boolean): Promise<BundledHomeAssistantView> {
    return this.#call("POST", enabled ? "/enable" : "/disable");
  }

  #call(method: "GET" | "POST", path: string): Promise<BundledHomeAssistantView> {
    return new Promise((resolve) => {
      const req = request({ socketPath: this.#socketPath, method, path }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
              BundledStatus | { error?: string };
            if (res.statusCode === 200 && "state" in body) resolve({ available: true, ...body });
            else
              resolve({
                available: false,
                reason: ("error" in body ? body.error : undefined) ?? "supervisor error",
              });
          } catch {
            resolve({ available: false, reason: "invalid supervisor response" });
          }
        });
      });
      req.setTimeout(this.#timeoutMs, () => req.destroy(new Error("timeout")));
      req.on("error", () =>
        resolve({
          available: false,
          reason: "The home supervisor is not running (start NEXUS with docker compose).",
        }),
      );
      req.end();
    });
  }
}
