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
  /** Path rules to apply. Defaults to the machine this process runs on. */
  platform?: PathPlatform;
}

export type PathPlatform = "win32" | "posix";

function hostPlatform(): PathPlatform {
  return process.platform === "win32" ? "win32" : "posix";
}

export const ALWAYS_DENIED = [
  "C:\\Windows\\System32\\config",
  "C:\\Windows\\System32\\drivers\\etc",
  "C:\\Windows\\repair",
  "C:\\ProgramData\\Microsoft\\Crypto",
] as const;

/** What a worker never touches on Linux and macOS, whatever its roots say. */
export const ALWAYS_DENIED_POSIX = [
  "/etc/shadow",
  "/etc/gshadow",
  "/etc/sudoers",
  "/etc/sudoers.d",
  "/etc/ssl/private",
  "/proc",
  "/sys",
  "/dev",
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
  readonly #platform: PathPlatform;

  constructor(options: PathPolicyOptions) {
    this.#platform = options.platform ?? hostPlatform();
    const normalizeOwn = (candidate: string) => normalize(candidate, this.#platform);
    const inherent = this.#platform === "win32" ? ALWAYS_DENIED : ALWAYS_DENIED_POSIX;
    this.#roots = options.allowedRoots.map(normalizeOwn);
    this.#denied = [...inherent, ...(options.deniedPaths ?? [])].map(normalizeOwn);
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

    const windows = this.#platform === "win32";
    const isAbsolute = windows
      ? path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw)
      : path.posix.isAbsolute(raw);
    if (!isAbsolute) {
      throw new PathNotAllowedError(requested, "relative path");
    }

    const absolute = normalize(raw, this.#platform);

    // Colons and names like NUL are special only to Windows; on POSIX they are ordinary.
    if (windows) {
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
    }

    const resolved = normalize(await this.#realpath(absolute), this.#platform);

    for (const denied of this.#denied) {
      // Case-insensitive on every platform: macOS volumes usually are, and refusing too
      // much here is the safe mistake.
      if (isWithin(resolved, denied, { sensitive: false, separator: windows ? "\\" : "/" })) {
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

    // Exact on POSIX: on a case-sensitive disk, /Workspace is not inside /workspace.
    const rootMatch = { sensitive: !windows, separator: windows ? "\\" : "/" };
    if (!this.#roots.some((root) => isWithin(resolved, root, rootMatch))) {
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

function normalize(candidate: string, platform: PathPlatform): string {
  return platform === "win32"
    ? path.win32.resolve(candidate.replace(/\//g, "\\"))
    : path.posix.resolve(candidate);
}

function isWithin(
  child: string,
  root: string,
  match: { sensitive: boolean; separator: string },
): boolean {
  const a = match.sensitive ? child : child.toLowerCase();
  const b = match.sensitive ? root : root.toLowerCase();
  if (a === b) return true;
  return a.startsWith(b.endsWith(match.separator) ? b : `${b}${match.separator}`);
}
