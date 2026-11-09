import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  confirmationRequestSchema,
  InMemoryConfirmationStore,
  type ConfirmationRequest,
  type ConfirmationStore,
} from "@nexus/tools";
import { z } from "zod";

/** Environment variable selecting a JSON file used to persist confirmation requests. */
export const CONFIRMATION_STORE_FILE_ENV = "NEXUS_CONFIRMATION_STORE_FILE";

const persistedRequestSchema = confirmationRequestSchema.extend({
  createdAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
  decidedAt: z.coerce.date().nullable(),
});

/**
 * Single-process, file-backed confirmation store.
 *
 * Pending confirmations survive an API restart. Writes are atomic (temp file +
 * rename) and serialized. It is NOT safe to share one file between several API
 * replicas: use a database-backed `ConfirmationStore` for that.
 */
export class FileConfirmationStore implements ConfirmationStore {
  readonly #path: string;
  readonly #byId = new Map<string, ConfirmationRequest>();
  #loaded: Promise<void> | undefined;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async save(request: ConfirmationRequest): Promise<void> {
    await this.#load();
    this.#byId.set(request.id, request);
    await this.#flush();
  }

  async get(id: string): Promise<ConfirmationRequest | undefined> {
    await this.#load();
    return this.#byId.get(id);
  }

  async listPending(runId: string): Promise<ConfirmationRequest[]> {
    await this.#load();
    return [...this.#byId.values()].filter((r) => r.runId === runId && r.status === "pending");
  }

  async listPendingForUser(userId: string): Promise<ConfirmationRequest[]> {
    await this.#load();
    return [...this.#byId.values()].filter((r) => r.userId === userId && r.status === "pending");
  }

  #load(): Promise<void> {
    this.#loaded ??= (async () => {
      let raw: string;
      try {
        raw = await readFile(this.#path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return;
        }
        throw error;
      }
      const parsed = z.array(persistedRequestSchema).parse(JSON.parse(raw));
      for (const request of parsed) {
        this.#byId.set(request.id, request);
      }
    })();
    return this.#loaded;
  }

  #flush(): Promise<void> {
    const snapshot = JSON.stringify([...this.#byId.values()]);
    const next = this.#writeChain.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.#path);
    });
    // Keep the chain alive after a failure so later writes are still attempted.
    this.#writeChain = next.catch(() => undefined);
    return next;
  }
}

let warnedNonPersistent = false;

/**
 * Picks the confirmation store: a file-backed one when
 * `NEXUS_CONFIRMATION_STORE_FILE` is set, otherwise the in-memory store.
 *
 * WARNING: the in-memory store loses every pending confirmation on restart, and
 * is not shared between replicas. In production a one-time process warning is
 * emitted when falling back to it.
 */
export function createConfirmationStore(env: NodeJS.ProcessEnv = process.env): ConfirmationStore {
  const path = env[CONFIRMATION_STORE_FILE_ENV]?.trim();
  if (path) {
    return new FileConfirmationStore(path);
  }
  if (env.NODE_ENV === "production" && !warnedNonPersistent) {
    warnedNonPersistent = true;
    process.emitWarning(
      `Confirmations are held in memory and will be lost on restart; set ${CONFIRMATION_STORE_FILE_ENV} or inject a persistent ConfirmationStore.`,
      { code: "NEXUS_CONFIRMATIONS_NOT_PERSISTENT" },
    );
  }
  return new InMemoryConfirmationStore();
}
