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
const forbiddenFragments = [
  ["/home", "adlane"].join("/"),
  ["Documents", "Codex"].join("/"),
  ["nexus", "audit"].join("-"),
];
const failures = [];

for (const file of tracked) {
  if (forbiddenFiles.has(basename(file))) failures.push(`${file}: brouillon interdit`);
  if (file === "scripts/check-release-hygiene.mjs") continue;
  let contents;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const fragment of forbiddenFragments) {
    if (contents.includes(fragment)) failures.push(`${file}: chemin local "${fragment}"`);
  }
}

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.license !== "AGPL-3.0-or-later") {
  failures.push("package.json: licence AGPL-3.0-or-later absente");
}
for (const required of [
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "THIRD_PARTY_NOTICES.md",
]) {
  if (!tracked.includes(required)) failures.push(`${required}: fichier de publication absent`);
}

if (failures.length > 0) {
  console.error(`Hygiène de publication refusée :\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`Hygiène de publication valide (${tracked.length} fichiers suivis).`);
