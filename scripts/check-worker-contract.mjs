import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Fails when the worker protocol changes without a version bump.
 *
 * Four workers share one envelope — Windows, Android, the browser host, and the
 * future ESP32 satellites — and none of them is covered end to end yet. An
 * unversioned change to that envelope breaks all four at once, in a way that
 * shows up as a device that silently stops pairing rather than as a test
 * failure. Version it, support both, or do not touch it.
 */

const GUARDED = ["packages/protocol/src/envelope.ts", "packages/protocol/src/worker.ts"];
const base = process.argv[2] ?? process.env.BASE_REF ?? "origin/master";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

let mergeBase;
try {
  mergeBase = git("merge-base", base, "HEAD");
} catch {
  console.log(`Worker contract check skipped: no merge base with ${base}.`);
  process.exit(0);
}

const changed = git("diff", "--name-only", `${mergeBase}..HEAD`).split("\n").filter(Boolean);
const touched = GUARDED.filter((file) => changed.includes(file));

if (touched.length === 0) {
  console.log("Worker contract check passed (protocol untouched).");
  process.exit(0);
}

/** PROTOCOL_VERSION is the single number every worker negotiates on. */
function versionOf(source) {
  return /export const PROTOCOL_VERSION\s*=\s*(\d+)/.exec(source)?.[1];
}

const before = versionOf(git("show", `${mergeBase}:packages/protocol/src/envelope.ts`));
const after = versionOf(readFileSync("packages/protocol/src/envelope.ts", "utf8"));

if (after === undefined) {
  console.error("Worker contract check failed:\n- PROTOCOL_VERSION not found in envelope.ts");
  process.exit(1);
}

if (before === after) {
  console.error(
    `Worker contract check failed:\n- ${touched.join(", ")} changed with PROTOCOL_VERSION ` +
      `still at ${after}.\n  Four workers negotiate on that number. Bump it and keep the ` +
      `previous version accepted, or revert the change.`,
  );
  process.exit(1);
}

console.log(
  `Worker contract check passed (PROTOCOL_VERSION ${before} -> ${after} for ${touched.join(", ")}).`,
);
