import { PolicyViolationError } from "@nexus/worker-core";

/**
 * Application policy.
 */

/**
 * Android package name pattern.
 */
const PACKAGE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

/**
 * Packages denied unconditionally.
 */
export const ALWAYS_DENIED_PACKAGES = [
  "com.android.settings",
  "com.miui.securitycenter",
  "com.android.packageinstaller",
  "com.google.android.packageinstaller",
  "com.android.certinstaller",
  "com.google.android.apps.walletnfcrel",
  "com.android.vending.billing",
] as const;

/** Substrings that indicate sensitive applications. */
const DENIED_FRAGMENTS = ["keystore", "keychain", "authenticator", "password", "wallet", "banking"];

export interface AppPolicyOptions {
  allowedPackages?: readonly string[];
  deniedPackages?: readonly string[];
}

export class AppPolicy {
  readonly #allowed: Set<string> | undefined;
  readonly #denied: string[];

  constructor(options: AppPolicyOptions = {}) {
    this.#allowed =
      options.allowedPackages === undefined || options.allowedPackages.length === 0
        ? undefined
        : new Set(options.allowedPackages.map((name) => name.toLowerCase()));
    this.#denied = [...ALWAYS_DENIED_PACKAGES, ...(options.deniedPackages ?? [])].map((name) =>
      name.toLowerCase(),
    );
  }

  get hasAllowList(): boolean {
    return this.#allowed !== undefined;
  }

  /**
   * Validates package name and returns its canonical form.
   *
   * @throws {PolicyViolationError} on invalid format or denied package.
   */
  assertAllowed(packageName: string): string {
    const name = packageName.trim();

    if (!PACKAGE_NAME.test(name)) {
      throw new PolicyViolationError({
        rule: "app.packageName",
        message: `Invalid package name: ${name.slice(0, 64)}`,
        userMessage: "This application name is not valid.",
        context: { packageName: name.slice(0, 128) },
      });
    }

    const lowered = name.toLowerCase();

    for (const denied of this.#denied) {
      if (lowered === denied || lowered.startsWith(`${denied}.`)) {
        throw new PolicyViolationError({
          rule: "app.denied",
          message: `Forbidden package: ${name}`,
          userMessage: `NEXUS cannot open the app "${name}".`,
          context: { packageName: name },
        });
      }
    }

    for (const fragment of DENIED_FRAGMENTS) {
      if (lowered.includes(fragment)) {
        throw new PolicyViolationError({
          rule: "app.sensitive",
          message: `Sensitive package denied: ${name}`,
          userMessage: `NEXUS cannot open the app "${name}".`,
          context: { packageName: name, fragment },
        });
      }
    }

    if (this.#allowed !== undefined && !this.#allowed.has(lowered)) {
      throw new PolicyViolationError({
        rule: "app.notAllowed",
        message: `Package outside allowlist: ${name}`,
        userMessage: `The app "${name}" is not on the allowed list for this device.`,
        context: { packageName: name },
      });
    }

    return name;
  }

  /** Non-throwing check to filter a list. */
  allows(packageName: string): boolean {
    try {
      this.assertAllowed(packageName);
      return true;
    } catch {
      return false;
    }
  }
}
