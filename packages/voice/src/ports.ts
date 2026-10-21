/**
 * Local voice subsystem ports.
 *
 * Everything interfacing with the operating system — microphone, transcription engine,
 * speech synthesizer, speaker — goes through a port. This is not just an architectural
 * preference: it is the only way to reliably test the voice pipeline, since
 * automated test suites cannot attach a physical microphone. Testing therefore focuses
 * on the **lifecycle** — what is spawned, with what arguments, what is killed, and what
 * is deleted — which is precisely where high-cost failure modes happen: leaked
 * recordings on disk, unstopped synthesis processes, or orphaned microphone streams.
 */

export interface SpawnedProcess {
  /** Waits for completion and returns exit code. */
  exit(): Promise<number>;
  /** Standard output, accumulated. */
  output(): Promise<string>;
  /** Standard error, accumulated — for diagnostics, never exposed directly to user. */
  stderr(): Promise<string>;
  /** Immediate termination. Must be idempotent. */
  kill(): void;
  readonly running: boolean;
}

export interface ProcessPort {
  /** Spawns a command. `stdin` is written then closed, if provided. */
  spawn(command: string, args: readonly string[], stdin?: string): SpawnedProcess;
  /** Checks if a binary exists and is executable. */
  which(command: string): Promise<string | undefined>;
}

export interface FilePort {
  /** Creates directory restricted to owner permissions (0700). */
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  /** Size in bytes, or `undefined` if nonexistent. */
  size(path: string): Promise<number | undefined>;
  read(path: string): Promise<string>;
}

export interface ClockPort {
  now(): number;
  sleep(ms: number): Promise<void>;
}
