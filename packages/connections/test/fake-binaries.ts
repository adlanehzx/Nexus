import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fake executables on a real filesystem.
 *
 * ## Why not a mocked ProcessPort
 *
 * A mock proves that the code calls `spawn` with the arguments it meant to. It
 * cannot prove the things that actually matter here: that no shell interprets
 * `;` in an argument, that a closed stdin makes an interactive tool exit, that
 * a hung process is really killed, that `which` finds an executable but not a
 * readable-only file. Those are properties of the operating system call, so the
 * tests that assert them have to make the call.
 *
 * Every script is written into a fresh temporary directory, which is also what
 * lets a test own its own PATH instead of depending on what the machine has
 * installed.
 */

export interface FakeBinDir {
  dir: string;
  /** Writes an executable shell script and returns its path. */
  write(name: string, body: string): Promise<string>;
  /** Writes a file that exists but is not executable. */
  writeNonExecutable(name: string, body: string): Promise<string>;
}

export async function createFakeBinDir(): Promise<FakeBinDir> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-connections-"));
  await mkdir(dir, { recursive: true });
  return {
    dir,
    async write(name, body) {
      const path = join(dir, name);
      await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
      await chmod(path, 0o755);
      return path;
    },
    async writeNonExecutable(name, body) {
      const path = join(dir, name);
      await writeFile(path, body, "utf8");
      await chmod(path, 0o644);
      return path;
    },
  };
}

/**
 * A credential-shaped string, built at runtime.
 *
 * Never a literal. A literal `sk-…` in a test file is a secret as far as every
 * scanner is concerned, and the correct response to a secret scanner flagging a
 * test fixture is to stop committing the fixture, not to silence the scanner.
 */
export function fakeSecret(): string {
  return `sk-${randomBytes(24).toString("hex")}`;
}

/** Deterministic clock. Tests that assert on durations cannot depend on machine speed. */
export class FakeClock {
  #now: number;
  readonly sleeps: number[] = [];
  /** When set, `sleep` never resolves — the shape of "this deadline is not reached". */
  neverResolveSleep = false;

  constructor(start = 1_760_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    if (this.neverResolveSleep) return new Promise<void>(() => undefined);
    this.#now += ms;
  }
}
