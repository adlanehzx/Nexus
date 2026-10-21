import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const forbiddenFiles = new Set([
  "fix_test.cjs",
  "fix_test.js",
  "mark_migration.sql",
  "prefs.xml",
  "response.txt",
  "test2.js",
  "test_p0.cjs",
  "test_schema.cjs",
]);
const forbiddenFragments = [["Documents", "Codex"].join("/"), ["nexus", "audit"].join("-")];
const forbiddenTrackedRuntimeFiles = new Set([
  "services/agent/config/profiles.production.json",
  "services/mission-engine/config/profiles.production.json",
  "services/mission-engine/config/runtime-settings.json",
]);
const suspiciousHomePath =
  /\/home\/(?!example(?:\/|\b)|someone(?:\/|\b)|alice(?:\/|\b)|nexus(?:\/|\b)|node(?:\/|\b))[^/\s"'`]+/;
const privateTailnetName =
  /\b(?!nexus-core\.example-tailnet\.ts\.net)[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net\b/i;
const failures = [];

for (const file of tracked) {
  if (forbiddenFiles.has(basename(file))) failures.push(`${file}: forbidden scratch file`);
  if (forbiddenTrackedRuntimeFiles.has(file)) {
    failures.push(`${file}: local runtime configuration must not be tracked`);
  }
  if (file === "scripts/check-release-hygiene.mjs") continue;
  let contents;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const fragment of forbiddenFragments) {
    if (contents.includes(fragment)) failures.push(`${file}: local path fragment "${fragment}"`);
  }
  const home = suspiciousHomePath.exec(contents)?.[0];
  if (home !== undefined) failures.push(`${file}: suspicious user-specific path "${home}"`);
  const tailnet = privateTailnetName.exec(contents)?.[0];
  if (tailnet !== undefined) failures.push(`${file}: private tailnet hostname "${tailnet}"`);
}

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.license !== "AGPL-3.0-or-later") {
  failures.push("package.json: missing AGPL-3.0-or-later license");
}
for (const required of [
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "THIRD_PARTY_NOTICES.md",
]) {
  if (!tracked.includes(required)) failures.push(`${required}: missing publication file`);
}

if (failures.length > 0) {
  console.error(`Release hygiene failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`Release hygiene passed (${tracked.length} tracked files).`);
