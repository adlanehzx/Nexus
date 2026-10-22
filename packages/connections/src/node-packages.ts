import { stat } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import type { PackageResolverPort } from "./ports.js";

/**
 * Finds an installed npm package by walking `node_modules` upwards.
 *
 * ## Why not `require.resolve`
 *
 * Three reasons, in order of how much they matter. A package's `exports` map
 * can refuse `./package.json`, which makes a perfectly present adapter look
 * absent. `require.resolve` on a bare specifier needs a resolvable entry point,
 * so a package with a broken `main` reads as missing when it is installed.
 * And resolving loads module metadata to answer a question that a directory
 * listing answers — presence is a filesystem fact.
 *
 * The walk is the same one Node performs: from a starting directory up to the
 * filesystem root, looking for `node_modules/<name>/package.json`. Scoped names
 * work unchanged, since `@scope/name` is just two path segments.
 */
export class NodePackageResolver implements PackageResolverPort {
  readonly #from: string;
  readonly #roots: readonly string[];

  constructor(options: { from?: string; extraRoots?: readonly string[] } = {}) {
    this.#from = options.from ?? process.cwd();
    // Additional `node_modules` directories to consult, for global installs
    // and pnpm stores that do not sit above the working directory.
    this.#roots = options.extraRoots ?? [];
  }

  async resolve(packageName: string): Promise<string | undefined> {
    // A specifier that is not a plain package name is refused rather than
    // joined into a path: `..` segments would walk out of `node_modules`, and
    // nothing in this package needs that.
    if (!isPlainPackageName(packageName)) return undefined;

    for (const directory of this.#candidates()) {
      const candidate = join(directory, packageName);
      if (await isPackageDirectory(candidate)) return candidate;
    }
    return undefined;
  }

  *#candidates(): Generator<string> {
    let current = this.#from;
    const root = parse(current).root;
    for (;;) {
      yield join(current, "node_modules");
      if (current === root) break;
      const next = dirname(current);
      if (next === current) break;
      current = next;
    }
    for (const extra of this.#roots) yield extra;
  }
}

/**
 * Accepts `name` and `@scope/name`, and nothing else.
 *
 * The exclusions are the point: no absolute paths, no `..`, no backslashes, no
 * empty segments. A package name reaches this from a provider definition, which
 * is code — but a validated name costs nothing and removes the question.
 */
export function isPlainPackageName(value: string): boolean {
  if (value.length === 0 || value.length > 214) return false;
  if (value.includes("\\") || value.includes("..")) return false;
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
}

async function isPackageDirectory(candidate: string): Promise<boolean> {
  try {
    // `package.json` rather than the directory itself: an empty leftover
    // directory is not an installed package, and pnpm leaves those behind.
    const stats = await stat(join(candidate, "package.json"));
    return stats.isFile();
  } catch {
    return false;
  }
}
