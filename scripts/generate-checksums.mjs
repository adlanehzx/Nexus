#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(__dirname, "..");

export function generateChecksums(dir = join(root, "release")) {
  if (!existsSync(dir)) {
    console.error(`Target directory does not exist: ${dir}`);
    return;
  }

  const files = readdirSync(dir)
    .filter((f) => !f.endsWith("SUMS"))
    .filter((f) => statSync(join(dir, f)).isFile());

  const sha256Lines = [];
  const sha512Lines = [];

  for (const file of files) {
    const filePath = join(dir, file);
    const content = readFileSync(filePath);

    const sha256 = createHash("sha256").update(content).digest("hex");
    const sha512 = createHash("sha512").update(content).digest("hex");

    sha256Lines.push(`${sha256}  ${file}`);
    sha512Lines.push(`${sha512}  ${file}`);
  }

  if (sha256Lines.length > 0) {
    const sha256Path = join(dir, "SHA256SUMS");
    const sha512Path = join(dir, "SHA512SUMS");

    writeFileSync(sha256Path, sha256Lines.join("\n") + "\n", "utf8");
    writeFileSync(sha512Path, sha512Lines.join("\n") + "\n", "utf8");

    console.log(`Generated SHA256SUMS and SHA512SUMS for ${files.length} release artifact(s) in: ${dir}`);
  } else {
    console.log(`No files found to checksum in: ${dir}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("generate-checksums.mjs")) {
  generateChecksums();
}
