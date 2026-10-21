import { compareVersionStrings, parseVersion } from "@nexus/shared";

/**
 * Auto-update policy: decide, never apply.
 *
 * ## Separation of Concerns
 *
 * This module inspects a release feed and determines whether an update is available.
 * It does not download, install, or execute anything. Installation is the responsibility
 * of the application runtime (Tauri for desktop, app store for mobile), which holds
 * the public verification keys.
 *
 * ## Rejection Rules
 *
 * Automated updates execute code; these security guards are central:
 *
 *  - **No unsigned updates.** An unsigned feed is treated as untrusted.
 *  - **No downgrades.** Older versions could reintroduce resolved vulnerabilities.
 *  - **No silent channel transitions.** Stable installations must not switch to beta
 *    without explicit user choice.
 *  - **No major version bumps without explicit consent.** Major updates may alter
 *    configuration or require manual migrations.
 */

export type UpdateChannel = "stable" | "beta";

export interface ReleaseEntry {
  version: string;
  channel: UpdateChannel;
  /** Package signature. Its absence renders the release unusable. */
  signature: string | null;
  url: string;
  notes?: string;
  /** Publication timestamp in milliseconds. */
  publishedAt: number;
}

export type UpdateDecision =
  | { kind: "none"; reason: string }
  | { kind: "available"; release: ReleaseEntry }
  /** Available, but requires explicit consent — major version bump. */
  | { kind: "consent-required"; release: ReleaseEntry; reason: string }
  | { kind: "rejected"; reason: string };

export interface UpdatePolicyOptions {
  currentVersion: string;
  channel?: UpdateChannel;
  /**
   * Allow major version upgrades without prompting.
   *
   * Defaults to false to prevent unexpected breaking changes.
   */
  allowMajor?: boolean;
}

export class UpdatePolicy {
  readonly #current: string;
  readonly #channel: UpdateChannel;
  readonly #allowMajor: boolean;

  constructor(options: UpdatePolicyOptions) {
    this.#current = options.currentVersion;
    this.#channel = options.channel ?? "stable";
    this.#allowMajor = options.allowMajor ?? false;
  }

  /**
   * Selects the applicable update from a release feed.
   *
   * Feed data is treated as untrusted network input. Individual entries are validated,
   * and malformed entries are ignored so a corrupt feed item does not block valid updates.
   */
  decide(feed: readonly ReleaseEntry[]): UpdateDecision {
    const current = parseVersion(this.#current);
    if (current === undefined) {
      return { kind: "rejected", reason: "installed version is unparseable" };
    }

    const candidates = feed
      .filter((entry) => parseVersion(entry.version) !== undefined)
      .filter((entry) => entry.channel === this.#channel)
      .filter((entry) => {
        const order = compareVersionStrings(entry.version, this.#current);
        return order !== undefined && order > 0;
      })
      .sort((left, right) => compareVersionStrings(right.version, left.version) ?? 0);

    const best = candidates[0];
    if (best === undefined) return { kind: "none", reason: "already up to date" };

    if (best.signature === null || best.signature.length === 0) {
      return { kind: "rejected", reason: "unsigned release" };
    }

    const bestVersion = parseVersion(best.version);
    if (bestVersion !== undefined && bestVersion.major > current.major && !this.#allowMajor) {
      return {
        kind: "consent-required",
        release: best,
        reason: `major version ${best.version}: migration may be required`,
      };
    }

    return { kind: "available", release: best };
  }
}
