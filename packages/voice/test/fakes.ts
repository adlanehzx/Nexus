import type { ClockPort, FilePort, ProcessPort, SpawnedProcess } from "../src/ports.js";

/**
 * System port test doubles.
 *
 * Automated test suites cannot attach a physical microphone. Testing therefore focuses
 * on the lifecycle: what is spawned, with what arguments, what is killed, and what
 * is deleted.
 */

export interface FakeRun {
  command: string;
  args: string[];
  stdin: string | undefined;
  killed: boolean;
}

export class FakeProcess implements ProcessPort {
  readonly runs: FakeRun[] = [];
  readonly available = new Set<string>();
  /** Output returned per command. */
  readonly outputs = new Map<string, string>();
  /** Exit code per command. Default: 0. */
  readonly codes = new Map<string, number>();
  /** Commands that stay running until killed. */
  readonly longRunning = new Set<string>();

  /**
   * Command side-effects, mapped by name.
   */
  readonly effects = new Map<string, (args: readonly string[]) => void>();

  spawn(command: string, args: readonly string[], stdin?: string): SpawnedProcess {
    const run: FakeRun = { command, args: [...args], stdin, killed: false };
    this.runs.push(run);
    this.effects.get(command)?.(run.args);

    let resolveExit: (code: number) => void = () => undefined;
    const exit = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    if (!this.longRunning.has(command)) resolveExit(this.codes.get(command) ?? 0);

    return {
      exit: () => exit,
      output: () => Promise.resolve(this.outputs.get(command) ?? ""),
      stderr: () => Promise.resolve(""),
      kill: () => {
        run.killed = true;
        resolveExit(143);
      },
      get running() {
        return !run.killed;
      },
    };
  }

  which(command: string): Promise<string | undefined> {
    return Promise.resolve(this.available.has(command) ? `/usr/bin/${command}` : undefined);
  }

  /** All invocations of a given command. */
  of(command: string): FakeRun[] {
    return this.runs.filter((run) => run.command === command);
  }
}

export class FakeFiles implements FilePort {
  readonly files = new Map<string, number>();
  readonly directories = new Set<string>();
  readonly removals: string[] = [];
  /** Paths where removal fails silently. */
  readonly undeletable = new Set<string>();
  readonly contents = new Map<string, string>();

  mkdir(path: string): Promise<void> {
    this.directories.add(path);
    return Promise.resolve();
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }

  remove(path: string): Promise<void> {
    this.removals.push(path);
    if (!this.undeletable.has(path)) this.files.delete(path);
    return Promise.resolve();
  }

  size(path: string): Promise<number | undefined> {
    return Promise.resolve(this.files.get(path));
  }

  read(path: string): Promise<string> {
    return Promise.resolve(this.contents.get(path) ?? "");
  }
}

export class FakeClock implements ClockPort {
  #now = 0;
  /** Requested sleep durations in chronological order. */
  readonly sleeps: number[] = [];

  now(): number {
    return this.#now;
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.#now += ms;
    return Promise.resolve();
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}
