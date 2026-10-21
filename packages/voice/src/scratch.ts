import { AppError } from "@nexus/shared";
import type { FilePort } from "./ports.js";

/**
 * Temporary audio files and guaranteed cleanup.
 *
 * ## Why this is an isolated module
 *
 * "No audio retained" is the easiest promise to make and the easiest to break.
 * An early return, unhandled exception, or aborted process could easily leave a
 * room recording on disk. Such a guarantee relies on a single strict abstraction
 * enforcing cleanup in all cases and verified by rigorous tests.
 *
 * ## Three core principles
 *
 * 1. **Single dedicated directory:** All temporary audio lives here with 0700 permissions.
 *    `purge()` can reliably remove leftovers without guessing.
 * 2. **Verified deletion:** After deletion, the file must be verified gone.
 * 3. **Cleanup via `finally`:** The `withAudio` helper yields a temporary path and
 *    guarantees cleanup upon completion or failure.
 *
 * ## Scope of the guarantee
 *
 * An unlink unbinds the filesystem reference without overwriting disk blocks.
 * NEXUS guarantees no audio files are retained on the filesystem, not forensic
 * multi-pass block wiping.
 */

export type AudioRetention =
  /** Default: nothing is retained, and deletion is strictly verified. */
  | "none"
  /**
   * Retains recordings for diagnostic purposes.
   * Never enabled by default.
   */
  | "diagnostic";

export class AudioNotDeletedError extends AppError {
  readonly code = "AUDIO_NOT_DELETED";
  readonly httpStatus = 500;

  constructor(path: string) {
    super({
      message: `recording could not be deleted: ${path}`,
      userMessage:
        "NEXUS could not delete a temporary recording. Dictation is stopped as a precaution.",
      context: { path },
    });
  }
}

export interface AudioScratchOptions {
  files: FilePort;
  /** Directory for temporary recordings. */
  directory: string;
  retention?: AudioRetention;
  /** Unique name generator, replaceable in tests. */
  newName?: () => string;
  /** Invoked when "diagnostic" retention keeps a file. */
  onRetained?: (path: string) => void;
}

export class AudioScratch {
  readonly #files: FilePort;
  readonly #directory: string;
  readonly #retention: AudioRetention;
  readonly #newName: () => string;
  readonly #onRetained: ((path: string) => void) | undefined;
  #counter = 0;

  constructor(options: AudioScratchOptions) {
    this.#files = options.files;
    this.#directory = options.directory;
    this.#retention = options.retention ?? "none";
    this.#newName =
      options.newName ??
      (() => {
        this.#counter += 1;
        return `dictation-${String(Date.now())}-${String(this.#counter)}.wav`;
      });
    this.#onRetained = options.onRetained;
  }

  get retention(): AudioRetention {
    return this.#retention;
  }

  get directory(): string {
    return this.#directory;
  }

  /**
   * Allocates a temporary audio path, executes the operation, and guarantees cleanup.
   */
  async withAudio<T>(operation: (path: string) => Promise<T>): Promise<T> {
    await this.#files.mkdir(this.#directory);
    const path = `${this.#directory}/${this.#newName()}`;
    try {
      return await operation(path);
    } finally {
      await this.#release(path);
    }
  }

  /** Clears leftover files. Called at startup and after abnormal termination. */
  async purge(names: readonly string[]): Promise<number> {
    let removed = 0;
    for (const name of names) {
      const path = `${this.#directory}/${name}`;
      if (!(await this.#files.exists(path))) continue;
      await this.#files.remove(path);
      if (await this.#files.exists(path)) throw new AudioNotDeletedError(path);
      removed += 1;
    }
    return removed;
  }

  async #release(path: string): Promise<void> {
    if (this.#retention === "diagnostic") {
      if (await this.#files.exists(path)) this.#onRetained?.(path);
      return;
    }
    if (!(await this.#files.exists(path))) return;
    await this.#files.remove(path);
    if (await this.#files.exists(path)) throw new AudioNotDeletedError(path);
  }
}
