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

/**
 * Extensions Windows cannot start without a command interpreter.
 *
 * A `.cmd` or `.bat` file is a script for `cmd.exe`, not an image
 * `CreateProcess` can load. Node used to paper over this; since the fix for
 * CVE-2024-27980 it refuses, because the only way to run one is through
 * `cmd.exe`, and quoting arguments safely for `cmd.exe` is not something anyone
 * has managed to do reliably — which is what that CVE was about.
 */
const WINDOWS_SHELL_SCRIPT_EXTENSIONS = [".cmd", ".bat"] as const;

/**
 * Whether a resolved path can be launched without a shell.
 *
 * This matters because npm installs its executables on Windows as `.cmd`
 * shims. So the tools NEXUS wants to probe are, on that platform, precisely the
 * files that cannot be started without `cmd.exe` — and `shell: true` would
 * reintroduce the injection class this package exists to exclude. There is no
 * third option available here, so the answer is "not launchable", reported as
 * such rather than worked around.
 *
 * Pure and platform-injectable: the rule is about Windows, and no test on this
 * repository's CI runs there.
 */
export function launchability(
  resolvedPath: string,
  platform: NodeJS.Platform,
): { launchable: true } | { launchable: false; reason: string } {
  if (platform !== "win32") return { launchable: true };
  const lowered = resolvedPath.toLowerCase();
  const extension = WINDOWS_SHELL_SCRIPT_EXTENSIONS.find((suffix) => lowered.endsWith(suffix));
  if (extension === undefined) return { launchable: true };
  return {
    launchable: false,
    reason: `${extension} files require a command interpreter, and NEXUS does not use one`,
  };
}

/**
 * Raised instead of spawning something that would need a shell.
 *
 * A distinct type so the caller can classify it as `unsupported_platform`
 * rather than `not_found`: the file is there, and telling somebody to
 * reinstall a tool that is correctly installed wastes their afternoon.
 */
export class UnsupportedExecutableError extends Error {
  readonly resolvedPath: string;

  constructor(resolvedPath: string, reason: string) {
    super(`cannot launch ${resolvedPath} without a shell: ${reason}`);
    this.name = "UnsupportedExecutableError";
    this.resolvedPath = resolvedPath;
  }
}

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
  readonly #platform: NodeJS.Platform;

  constructor(options: { path?: string; pathExt?: string; platform?: NodeJS.Platform } = {}) {
    this.#pathValue = options.path ?? process.env.PATH ?? "";
    const platform = options.platform ?? process.platform;
    this.#platform = platform;
    const rawExt = options.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
    // On POSIX an executable needs no extension; on Windows it needs one, and
    // resolving `codex` to `codex.cmd` is what makes npm-installed tools
    // findable there at all.
    this.#pathExt = platform === "win32" ? rawExt.split(";").filter(Boolean) : [""];
  }

  spawn(file: string, args: readonly string[], options: SpawnOptions): SpawnedProcess {
    // Checked here rather than at resolution time so that "the file exists" and
    // "the file can be run safely" stay separate answers, and so no caller can
    // reach the spawn by resolving a path some other way.
    const verdict = launchability(file, this.#platform);
    if (!verdict.launchable) throw new UnsupportedExecutableError(file, verdict.reason);
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
