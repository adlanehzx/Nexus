import { spawn } from "node:child_process";

export interface BrowserHarnessHealth {
  schema_version: number;
  healthy: boolean;
  version: string | null;
  install_mode: string | null;
  chrome_running: boolean | null;
  daemon: {
    name: string;
    alive: boolean;
    browser_ready: boolean;
  };
}

/**
 * Thin supervisor for the official Browser Use harness.
 *
 * The harness owns CDP and browser interaction. NEXUS only starts its local
 * connection and reads the machine-readable doctor report. No page content is
 * returned to the dashboard, which keeps authenticated tabs out of API logs.
 */
export class BrowserHarnessClient {
  readonly #cdpUrl: string;
  readonly #command: string;

  constructor(options: { cdpUrl: string; command?: string }) {
    const url = new URL(options.cdpUrl);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      throw new Error("Browser Use CDP must stay on loopback.");
    }
    this.#cdpUrl = url.toString().replace(/\/$/, "");
    this.#command = options.command ?? "browser-harness";
  }

  async health(): Promise<BrowserHarnessHealth> {
    const result = await this.#run(["doctor", "--json", "--require-existing-daemon"], "", 8_000);
    const parsed = JSON.parse(result.stdout) as BrowserHarnessHealth;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof parsed.healthy !== "boolean" ||
      typeof parsed.daemon?.browser_ready !== "boolean"
    ) {
      throw new Error("Invalid Browser Use diagnostic.");
    }

    // `doctor` counts active CDP connections at instant T. However, the CLI
    // client normally closes its connection at the end of each command: a
    // perfectly reachable, idle browser was therefore presented as
    // unavailable. An actual probe, whose output is never logged,
    // verifies the real capability we care about.
    if (!parsed.daemon.browser_ready) {
      try {
        await this.#run([], "print(page_info())\n", 8_000);
        return {
          ...parsed,
          healthy: true,
          chrome_running: true,
          daemon: { ...parsed.daemon, browser_ready: true },
        };
      } catch {
        // The initial report remains the most useful diagnostic on failure.
      }
    }
    return parsed;
  }

  async connect(): Promise<BrowserHarnessHealth> {
    return this.health();
  }

  async #run(
    args: string[],
    stdin: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#command, args, {
        env: { ...process.env, BU_CDP_URL: this.#cdpUrl },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Browser Use connection timed out."));
      }, timeoutMs);
      timer.unref();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-32_768);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-8_192);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        const exitCode = code ?? 1;
        // `doctor` exits non-zero when unhealthy but still emits its useful
        // JSON report. All other failures remain errors and stderr is reduced
        // to a generic message so browser details never reach API logs.
        if (exitCode !== 0 && args[0] !== "doctor") {
          reject(new Error("Browser Use could not connect to local browser."));
          return;
        }
        resolve({ stdout, stderr, code: exitCode });
      });
      child.stdin.end(stdin);
    });
  }
}
