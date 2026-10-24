import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The shape of the package's own source tree.
 *
 * ## Why a test exists for something this obvious
 *
 * Because commit 2520608 committed twenty-one duplicated source files under
 * `src/src`, `src/src/src` and `src/src/src/src`, and every gate in the
 * repository passed. Prettier found them formatted, ESLint found them clean,
 * TypeScript compiled all four copies without complaint — they were valid,
 * identical modules — the tests passed because nothing imported them, and
 * release hygiene does not look for duplicates. The whole verification suite
 * had no notion that the file tree could be the wrong shape.
 *
 * The cause was a backup-and-restore helper used for mutation testing:
 * `cp -r src /tmp/backup` means "become /tmp/backup" the first time and "go
 * inside /tmp/backup" every time after, so reusing one backup path across
 * batches nested the tree one level deeper per batch. The helper was an ad-hoc
 * shell function, not a file in this repository, so there is nothing to patch
 * — which is exactly why the invariant belongs here, where it is checked on
 * every run rather than remembered.
 *
 * This reads the real directory, not a manifest. A list of expected modules
 * compared against another list of expected modules would prove nothing.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** The modules this package is supposed to contain. */
const CANONICAL_MODULES = [
  "admin.ts",
  "auth.ts",
  "cli.ts",
  "client.ts",
  "config.ts",
  "http.ts",
  "index.ts",
  "nonce-log.ts",
  "protocol.ts",
  "security.ts",
  "server.ts",
  "socket.ts",
];

describe("source tree layout", () => {
  it("has no nested src directory", () => {
    expect(() => statSync(join(SRC_DIR, "src"))).toThrow();
  });

  it("contains no directories at all", () => {
    // Stronger than checking for `src` by name: the failure mode was a
    // directory appearing where only modules belong, and the next instance may
    // be called something else.
    const directories = readdirSync(SRC_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(directories).toEqual([]);
  });

  it("contains exactly the canonical modules", () => {
    const files = readdirSync(SRC_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .toSorted();

    // Catches a stray copy and a forgotten module in the same assertion, so
    // adding a real module is a deliberate edit here rather than a silent
    // change in tree shape.
    expect(files).toEqual(CANONICAL_MODULES.toSorted());
  });
});
