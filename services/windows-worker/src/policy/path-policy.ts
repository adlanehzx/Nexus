import path from "node:path";
import { PathNotAllowedError } from "../errors.js";

/**
 * Path policy.
 *
 * Enforces boundary checks on file operations to ensure they stay within allowed roots.
 */

export type RealPathResolver = (candidate: string) => Promise<string>;

export interface PathPolicyOptions {
  allowedRoots: readonly string[];
  deniedPaths?: readonly string[];
  deniedSegments?: readonly string[];
  deniedNames?: readonly string[];
  realpath?: RealPathResolver;
}

export const ALWAYS_DENIED = [
  "C:\\Windows\\System32\\config",
  "C:\\Windows\\System32\\drivers\\etc",
  "C:\\Windows\\repair",
  "C:\\ProgramData\\Microsoft\\Crypto",
] as const;

const DENIED_SEGMENTS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".npmrc",
  ".git-credentials",
  "credentials",
  "id_rsa",
  "id_ed25519",
];

const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(\.[^.]*)?$/i;

export class PathPolicy {
  readonly #roots: string[];
  readonly #denied: string[];
  readonly #deniedSegments: string[];
  readonly #deniedNames: string[];
  readonly #realpath: RealPathResolver;

  constructor(options: PathPolicyOptions) {
    this.#roots = options.allowedRoots.map(normalize);
    this.#denied = [...ALWAYS_DENIED, ...(options.deniedPaths ?? [])].map(normalize);
    this.#deniedSegments = [
      ...DENIED_SEGMENTS,
      ...(options.deniedSegments ?? []).map((segment) => segment.toLowerCase()),
    ];
    this.#deniedNames = (options.deniedNames ?? []).map((name) => name.toLowerCase());
    this.#realpath = options.realpath ?? ((candidate) => Promise.resolve(candidate));
  }

  get roots(): readonly string[] {
    return this.#roots;
  }

  async resolve(requested: string): Promise<string> {
    const raw = requested.trim();
    if (raw.length === 0) throw new PathNotAllowedError(requested, "empty path");

    if (raw.includes("\0")) throw new PathNotAllowedError(requested, "null character");

    if (raw.startsWith("\\\\?\\") || raw.startsWith("\\\\.\\")) {
      throw new PathNotAllowedError(requested, "extended path prefix");
    }
    if (raw.startsWith("\\\\") || raw.startsWith("//")) {
      throw new PathNotAllowedError(requested, "UNC network path");
    }

    if (this.#roots.length === 0) {
      throw new PathNotAllowedError(requested, "no allowed roots configured");
    }

    if (!path.win32.isAbsolute(raw) && !path.posix.isAbsolute(raw)) {
      throw new PathNotAllowedError(requested, "relative path");
    }

    const absolute = normalize(raw);

    for (const segment of absolute.split(/[\\/]/)) {
      if (segment.includes(":")) {
        if (segment !== absolute.split(/[\\/]/)[0]) {
          throw new PathNotAllowedError(requested, "alternate data stream");
        }
      }
      if (RESERVED_NAMES.test(segment)) {
        throw new PathNotAllowedError(requested, "reserved device name");
      }
    }

    const resolved = normalize(await this.#realpath(absolute));

    for (const denied of this.#denied) {
      if (isWithin(resolved, denied)) {
        throw new PathNotAllowedError(requested, "protected system location");
      }
    }

    const lowered = resolved.toLowerCase();
    const segments = lowered.split(/[\\/]/);
    for (const segment of this.#deniedSegments) {
      if (segments.includes(segment)) {
        throw new PathNotAllowedError(requested, "location containing secrets");
      }
    }

    const name = segments.at(-1) ?? "";
    for (const pattern of this.#deniedNames) {
      const matches = pattern.endsWith("*")
        ? name.startsWith(pattern.slice(0, -1))
        : name === pattern;
      if (matches) {
        throw new PathNotAllowedError(requested, `name denied by local policy (${pattern})`);
      }
    }

    if (!this.#roots.some((root) => isWithin(resolved, root))) {
      throw new PathNotAllowedError(requested, "outside allowed roots");
    }

    return resolved;
  }

  async allows(requested: string): Promise<boolean> {
    try {
      await this.resolve(requested);
      return true;
    } catch {
      return false;
    }
  }
}

function normalize(candidate: string): string {
  return path.win32.resolve(candidate.replace(/\//g, "\\"));
}

function isWithin(child: string, root: string): boolean {
  const a = child.toLowerCase();
  const b = root.toLowerCase();
  if (a === b) return true;
  return a.startsWith(b.endsWith("\\") ? b : `${b}\\`);
}
