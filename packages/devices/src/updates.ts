/**
 * Worker version tracking.
 *
 * The Core observes and verifies worker versions; it does not perform remote updates.
 * Remote push update capabilities would equate to arbitrary remote code execution,
 * violating local host isolation invariants.
 *
 * Updates are performed locally via package managers, installers, or git commands.
 * This module compares reported versions against expected releases to provide update advice.
 */

export type WorkerUpdateStatus =
  /** Matches expected version. */
  | "a-jour"
  /** Behind: a newer release is expected. */
  | "en-retard"
  /** Ahead: local development or staged rollout. */
  | "en-avance"
  /** Version absent, unparseable, or no expected version configured. */
  | "inconnu";

export { compareVersions, parseVersion, type SemanticVersion } from "@nexus/shared";

import { compareVersions, parseVersion } from "@nexus/shared";

export interface UpdateAdvice {
  status: WorkerUpdateStatus;
  current: string | null;
  expected: string | null;
  /** Actionable guidance for administrators, or `null` if no action needed. */
  action: string | null;
}

/**
 * Evaluates version difference between reported worker version and expected version.
 */
export function updateAdvice(
  current: string | null | undefined,
  expected: string | null | undefined,
): UpdateAdvice {
  const currentVersion = parseVersion(current);
  const expectedVersion = parseVersion(expected);
  const shown = { current: current ?? null, expected: expected ?? null };

  if (currentVersion === undefined || expectedVersion === undefined) {
    return {
      ...shown,
      status: "inconnu",
      action:
        expectedVersion === undefined
          ? null
          : "Worker version unknown: verify that it boots and registers.",
    };
  }

  const order = compareVersions(currentVersion, expectedVersion);
  if (order === 0) return { ...shown, status: "a-jour", action: null };
  if (order > 0) {
    return {
      ...shown,
      status: "en-avance",
      action: "This worker is newer than the expected version configured on Core.",
    };
  }
  return {
    ...shown,
    status: "en-retard",
    action: `Update this worker on its host machine (expected version ${expected ?? "?"}), then restart its service.`,
  };
}
