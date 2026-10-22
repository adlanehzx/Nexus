import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { ClockPort, ProcessPort, SpawnedProcess, SpawnOptions } from "./ports.js";

/**
 * The real operating-system adapter.
 *
 * Everything security-relevant in this file is a thing it refuses to do:
 *
 *  - No `shell: true`, anywhere. A shell would reinterpret an argument vector
 *    as a command line, which is the whole class of injection this package is
 *    built to exclude.
 *  - No inherited environment. `env` comes from the caller, already filtered.
 *  - No inherited stdin. It is closed immediately, so a provider that decides
 *    to prompt for a password gets EOF and exits instead of hanging forever
 *    holding a worker.
 *  - No unbounded buffers. A provider that prints a gigabyte gets cut off
 *    rather than taking the process down with it.
 *  - No shell for `which`. PATH is walked directly.
 */

/**
 * Per-stream capture ceiling.
 *
 * 1 MiB is far more than any `--version` needs; the point is that the number
 * exists. Without it, "how much can a provider print" is answered by how much
 * memory the machine has.
 */
const MAX_CAPTURED_BYTES = 1024 * 1024;

class NodeSpawnedProcess implements SpawnedProcess {
  readonly #exit: Promise<number>;
  #stdout = "";
  #stderr = "";
  #running = true;
  #kill: () => void;

  constructor(file: string, args: readonly string[], options: SpawnOptions) {
    const child = spawn(file, [...args], {
      // Explicit, and the single most important line in this package.
      shell: false,
      env: { ...options.env },
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      // stdin closed, stdout and stderr piped. Never "inherit": inheriting
      // stdout would let a provider write straight to a log nothing redacts.
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (this.#stdout.length < MAX_CAPTURED_BYTES) this.#stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (this.#stderr.length < MAX_CAPTURED_BYTES) this.#stderr += chunk;
    });

    this.#kill = () => {
      // SIGKILL, not SIGTERM. A process being killed here has already exceeded
      // its deadline or is waiting on input that will never come; asking it
      // politely means waiting again.
      child.kill("SIGKILL");
    };

    this.#exit = new Promise<number>((resolve) => {
      child.once("error", () => {
        // A spawn error (missing binary, not executable) is an exit, not a
        // throw: the caller already classifies a non-zero outcome, and an
        // unhandled rejection here would take down the host instead.
        this.#running = false;
        resolve(-1);
      });
      child.once("close", (code, signal) => {
        this.#running = false;
        resolve(code ?? (signal === null ? -1 : 128));
      });
    });
  }

  exit(): Promise<number> {
    return this.#exit;
  }

  async output(): Promise<string> {
    // Awaiting exit first means a caller cannot read a half-written stream and
    // conclude a version is missing when it was merely late.
    await this.#exit;
    return this.#stdout;
  }

  async stderr(): Promise<string> {
    await this.#exit;
    return this.#stderr;
  }

  kill(): void {
    if (this.#running) this.#kill();
  }

  get running(): boolean {
    return this.#running;
  }
}

export class NodeProcessPort implements ProcessPort {
  readonly #pathValue: string;
  readonly #pathExt: readonly string[];

  constructor(options: { path?: string; pathExt?: string; platform?: NodeJS.Platform } = {}) {
    this.#pathValue = options.path ?? process.env.PATH ?? "";
    const platform = options.platform ?? process.platform;
    const rawExt = options.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
    // On POSIX an executable needs no extension; on Windows it needs one, and
    // resolving `codex` to `codex.cmd` is what makes npm-installed tools
    // findable there at all.
    this.#pathExt = platform === "win32" ? rawExt.split(";").filter(Boolean) : [""];
  }

  spawn(file: string, args: readonly string[], options: SpawnOptions): SpawnedProcess {
    return new NodeSpawnedProcess(file, args, options);
  }

  async which(file: string): Promise<string | undefined> {
    // An absolute path is used as given — but still checked for the execute
    // bit, so "configured" and "runnable" stay different claims.
    if (isAbsolute(file)) return (await this.#executable(file)) ? file : undefined;

    // A relative path containing a separator is refused rather than resolved
    // against the working directory: that would make the result depend on where
    // NEXUS happens to have been started.
    if (file.includes("/") || file.includes("\\")) return undefined;

    for (const directory of this.#pathValue.split(delimiter).filter(Boolean)) {
      for (const extension of this.#pathExt) {
        const candidate = join(directory, `${file}${extension}`);
        if (await this.#executable(candidate)) return candidate;
      }
    }
    return undefined;
  }

  async #executable(candidate: string): Promise<boolean> {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/** Wall-clock implementation. Separated so no test ever waits on real time. */
export class SystemClock implements ClockPort {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Without this, a pending probe timeout keeps a CLI process alive after
      // its work is done — the kind of bug that only shows up as "the command
      // never returns" on somebody else's machine.
      timer.unref?.();
    });
  }
}
