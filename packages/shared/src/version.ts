/**
 * Semantic version parsing and comparison.
 *
 * Centralized here to ensure uniform version comparison semantics across all components
 * and avoid pitfalls like string comparison ordering or incorrect pre-release handling.
 */

export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release segment, e.g. `rc.1`. Omitted in stable releases. */
  prerelease: string | undefined;
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parses a semantic version string or returns `undefined`.
 * Does not throw: unparseable versions represent observations, not exceptions.
 */
export function parseVersion(value: string | null | undefined): SemanticVersion | undefined {
  if (value === null || value === undefined) return undefined;
  const match = VERSION.exec(value.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

/**
 * Compares two semantic versions: returns negative if `left` is older than `right`.
 * Pre-releases are considered older than the corresponding stable release (e.g. 1.2.0-rc.1 < 1.2.0).
 */
export function compareVersions(left: SemanticVersion, right: SemanticVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/** Compares two version strings. Returns `undefined` if either is invalid. */
export function compareVersionStrings(left: string, right: string): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined) return undefined;
  return compareVersions(a, b);
}
