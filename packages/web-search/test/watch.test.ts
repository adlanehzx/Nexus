import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryWatchSnapshotStore,
  JsonFileWatchSnapshotStore,
  WebWatchService,
  type WebDocument,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function doc(content: string, time: string): WebDocument {
  return {
    requestedUrl: "https://example.org/news",
    finalUrl: "https://example.org/news",
    canonicalUrl: "https://example.org/news",
    contentType: "text/html",
    fetchedAt: time,
    sha256: createHash("sha256").update(content).digest("hex"),
    byteLength: content.length,
    wordCount: content.split(/\s+/).length,
    content,
    metadata: {
      title: "Actualité",
      description: null,
      author: null,
      publishedAt: null,
      language: "fr",
    },
    provenance: { redirectChain: [], untrustedExternalContent: true },
  };
}

describe("veille web", () => {
  it("distingue première vue, contenu inchangé et changement significatif", async () => {
    const versions = [
      doc("alpha beta gamma delta epsilon", "2026-10-20T10:00:00Z"),
      doc("alpha beta gamma delta epsilon", "2026-10-20T11:00:00Z"),
      doc("nouvelle information complètement différente publiée", "2026-10-20T12:00:00Z"),
    ];
    const fetcher = { fetch: () => Promise.resolve(versions.shift()!) };
    const service = new WebWatchService({ fetcher, store: new InMemoryWatchSnapshotStore() });

    await expect(
      service.check({ watchId: "news", url: "https://example.org/news" }),
    ).resolves.toMatchObject({ status: "first_seen", similarity: null });
    await expect(
      service.check({ watchId: "news", url: "https://example.org/news" }),
    ).resolves.toMatchObject({ status: "unchanged", similarity: 1 });
    await expect(
      service.check({ watchId: "news", url: "https://example.org/news" }),
    ).resolves.toMatchObject({ status: "changed", similarity: 0 });
  });

  it("persiste un snapshot atomique sans utiliser watchId comme chemin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nexus-watch-"));
    temporaryDirectories.push(directory);
    const store = new JsonFileWatchSnapshotStore(directory);
    const snapshot = {
      watchId: "../../outside",
      url: "https://example.org",
      canonicalUrl: "https://example.org",
      title: "Titre",
      contentHash: "a".repeat(64),
      signature: ["abc"],
      capturedAt: "2026-10-20T12:00:00Z",
    };
    await store.save(snapshot);

    await expect(store.load("../../outside")).resolves.toEqual(snapshot);
    const expectedName = `${createHash("sha256").update("../../outside").digest("hex")}.json`;
    expect(await readFile(join(directory, expectedName), "utf8")).toContain(
      '"watchId": "../../outside"',
    );
  });
});
