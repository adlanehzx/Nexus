import { spawn } from "node:child_process";
import { access, constants, mkdir, readFile, rm, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { ClockPort, FilePort, ProcessPort, SpawnedProcess } from "./ports.js";

/**
 * System implementations of voice ports.
 *
 * All platform-specific system interactions reside here in one place for a
 * straightforward reason: this is the thin boundary that unit tests do not directly exercise,
 * so it must remain as simple and minimal as possible. All business behavior —
 * what is spawned, terminated, or deleted — lives in the unit-tested modules.
 */

export const systemProcess: ProcessPort = {
  spawn(command, args, stdin) {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let running = true;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Bounded buffer: verbose process error output must not bloat memory
      // during dictation runs.
      err = (err + chunk).slice(-8_192);
    });

    const finished = new Promise<number>((resolve) => {
      child.once("exit", (code) => {
        running = false;
        resolve(code ?? 0);
      });
      child.once("error", () => {
        running = false;
        resolve(-1);
      });
    });

    if (stdin !== undefined) {
      child.stdin.end(stdin, "utf8");
    }

    const handle: SpawnedProcess = {
      exit: () => finished,
      output: async () => {
        await finished;
        return out;
      },
      stderr: async () => {
        await finished;
        return err;
      },
      kill: () => {
        if (!running) return;
        child.kill("SIGTERM");
        // An unhandled SIGTERM could leave the microphone active; a follow-up SIGKILL guarantees termination.
        const force = setTimeout(() => {
          if (running) child.kill("SIGKILL");
        }, 500);
        force.unref();
      },
      get running() {
        return running;
      },
    };
    return handle;
  },

  /**
   * Looks up a binary in `PATH` without spawning a subshell.
   */
  async which(command) {
    if (command.includes("/")) {
      return (await executable(command)) ? command : undefined;
    }
    const path = process.env.PATH ?? "";
    for (const directory of path.split(delimiter)) {
      if (directory.length === 0) continue;
      const candidate = join(directory, command);
      if (await executable(candidate)) return candidate;
    }
    return undefined;
  },
};

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export const systemFiles: FilePort = {
  // 0700: Temporary recordings are restricted to the owner.
  mkdir: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  exists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  remove: async (path) => {
    await rm(path, { force: true });
  },
  size: async (path) => {
    try {
      return (await stat(path)).size;
    } catch {
      return undefined;
    }
  },
  read: (path) => readFile(path, "utf8"),
};

export const systemClock: ClockPort = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
