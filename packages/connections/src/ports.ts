/**
 * Ports for everything that touches the operating system.
 *
 * Detection runs other people's binaries. No test suite can install Codex,
 * Claude and Antigravity in order to check that we read their versions
 * correctly, so what is tested is the **lifecycle**: what is spawned, with which
 * arguments, which environment is handed over, what is killed, what is
 * truncated. That is also where the expensive mistakes live — a leaked
 * credential in an error message, an interactive process that never exits, a
 * shell that interprets a provider's output.
 *
 * ## A note on duplication
 *
 * This is the same shape as `ProcessPort` in `@nexus/voice`, and that is not an
 * accident: the two needs are identical. Depending on `@nexus/voice` from here
 * would drag whisper.cpp and Piper into a package about connections, so the
 * shape is repeated instead. The right destination is `@nexus/shared`, and
 * moving it there is listed as a deferred change for the integration phase —
 * deliberately not done now, because it would touch a package outside this
 * batch's scope.
 */

export interface SpawnedProcess {
  /** Waits for exit and yields the exit code. */
  exit(): Promise<number>;
  /** Accumulated standard output. */
  output(): Promise<string>;
  /** Accumulated standard error. Diagnostics only, never shown unredacted. */
  stderr(): Promise<string>;
  /** Immediate termination. Must be idempotent: callers kill without checking. */
  kill(): void;
  readonly running: boolean;
}

export interface SpawnOptions {
  /**
   * The exact environment handed to the child.
   *
   * Required, not optional, and that is the point: an optional environment
   * invites `process.env`, which carries every credential the parent happens to
   * hold. Making it mandatory forces the caller to decide.
   */
  env: Readonly<Record<string, string>>;
  cwd?: string;
}

export interface ProcessPort {
  /**
   * Spawns a binary with an argument vector.
   *
   * There is no overload taking a command string, and that absence is the
   * security property: a string would need a shell to split it, and a shell
   * interprets `;`, `&&`, `$(…)` and globs. An argument vector cannot be
   * reinterpreted, so there is no injection to filter.
   */
  spawn(file: string, args: readonly string[], options: SpawnOptions): SpawnedProcess;
  /** Absolute path of a binary on PATH, or `undefined`. Never uses a shell. */
  which(file: string): Promise<string | undefined>;
}

export interface ClockPort {
  now(): number;
  /** Resolves after `ms`. Replaced in tests so no suite waits on real time. */
  sleep(ms: number): Promise<void>;
}
