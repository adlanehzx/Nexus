import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { WebDocument, WebDocumentFetcher } from "./types.js";

const watchSnapshotSchema = z.object({
  watchId: z.string().min(1).max(200),
  url: z.string().url(),
  canonicalUrl: z.string().url(),
  title: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.array(z.string()).max(5_000),
  capturedAt: z.string(),
});

export type WatchSnapshot = z.infer<typeof watchSnapshotSchema>;

export interface WatchSnapshotStore {
  load(watchId: string): Promise<WatchSnapshot | null>;
  save(snapshot: WatchSnapshot): Promise<void>;
}

export interface WatchCheckResult {
  status: "first_seen" | "unchanged" | "changed";
  similarity: number | null;
  previous: WatchSnapshot | null;
  current: WatchSnapshot;
  document: WebDocument;
}

export class InMemoryWatchSnapshotStore implements WatchSnapshotStore {
  readonly #snapshots = new Map<string, WatchSnapshot>();

  load(watchId: string): Promise<WatchSnapshot | null> {
    return Promise.resolve(this.#snapshots.get(watchId) ?? null);
  }

  save(snapshot: WatchSnapshot): Promise<void> {
    this.#snapshots.set(snapshot.watchId, structuredClone(snapshot));
    return Promise.resolve();
  }
}

/** Stockage atomique, un fichier par veille. Aucun contenu complet n'est conservé. */
export class JsonFileWatchSnapshotStore implements WatchSnapshotStore {
  readonly #directory: string;

  constructor(directory: string) {
    if (!directory.trim()) throw new TypeError("watch snapshot directory must not be empty");
    this.#directory = directory;
  }

  async load(watchId: string): Promise<WatchSnapshot | null> {
    const path = this.#path(watchId);
    try {
      const raw = await readFile(path, "utf8");
      return watchSnapshotSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async save(snapshot: WatchSnapshot): Promise<void> {
    const validated = watchSnapshotSchema.parse(snapshot);
    const path = this.#path(validated.watchId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  }

  #path(watchId: string): string {
    if (!watchId.trim() || watchId.length > 200) throw new TypeError("invalid watchId");
    const digest = createHash("sha256").update(watchId).digest("hex");
    return join(this.#directory, `${digest}.json`);
  }
}

export class WebWatchService {
  readonly #fetcher: WebDocumentFetcher;
  readonly #store: WatchSnapshotStore;

  constructor(options: { fetcher: WebDocumentFetcher; store: WatchSnapshotStore }) {
    this.#fetcher = options.fetcher;
    this.#store = options.store;
  }

  async check(
    request: { watchId: string; url: string; changeThreshold?: number },
    signal?: AbortSignal,
  ): Promise<WatchCheckResult> {
    const threshold = request.changeThreshold ?? 0.98;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new TypeError("changeThreshold must be between 0 and 1");
    }
    const previous = await this.#store.load(request.watchId);
    const document = await this.#fetcher.fetch({ url: request.url }, signal);
    const current = snapshot(request.watchId, document);
    const similarity = previous === null ? null : jaccard(previous.signature, current.signature);
    const status =
      previous === null
        ? "first_seen"
        : previous.contentHash === current.contentHash || (similarity ?? 0) >= threshold
          ? "unchanged"
          : "changed";
    await this.#store.save(current);
    return { status, similarity, previous, current, document };
  }
}

function snapshot(watchId: string, document: WebDocument): WatchSnapshot {
  return {
    watchId,
    url: document.finalUrl,
    canonicalUrl: document.canonicalUrl,
    title: document.metadata.title,
    contentHash: document.sha256,
    signature: shingles(document.content),
    capturedAt: document.fetchedAt,
  };
}

function shingles(content: string): string[] {
  const tokens =
    content
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/[a-z0-9]{2,}/g) ?? [];
  const hashes = new Set<string>();
  for (let index = 0; index < tokens.length - 2 && hashes.size < 5_000; index += 1) {
    hashes.add(
      createHash("sha256")
        .update(`${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`)
        .digest("hex")
        .slice(0, 16),
    );
  }
  if (!hashes.size && tokens.length) {
    hashes.add(createHash("sha256").update(tokens.join(" ")).digest("hex").slice(0, 16));
  }
  return [...hashes].sort();
}

function jaccard(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return Number((intersection / (a.size + b.size - intersection)).toFixed(4));
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
