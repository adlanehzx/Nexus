import type { RiskLevel } from "@nexus/tools";
import { PolicyViolationError } from "../errors.js";

/**
 * Git policy.
 *
 * Separates read vs mutating operations and verifies remote URLs.
 */

export type GitOperation = "status" | "diff" | "branch" | "pull" | "checkout" | "clone" | "commit";

export const GIT_READ_OPERATIONS: readonly GitOperation[] = ["status", "diff", "branch"];

export const GIT_RISK: Record<GitOperation, RiskLevel> = {
  status: "SAFE",
  diff: "SAFE",
  branch: "SAFE",
  pull: "MEDIUM",
  clone: "MEDIUM",
  commit: "MEDIUM",
  checkout: "HIGH",
};

export function isReadOperation(operation: GitOperation): boolean {
  return GIT_READ_OPERATIONS.includes(operation);
}

export interface GitPolicyOptions {
  allowWrite?: boolean;
  allowedRemoteHosts?: readonly string[];
}

export const DEFAULT_REMOTE_HOSTS = ["github.com", "gitlab.com"] as const;

export class GitPolicy {
  readonly #allowWrite: boolean;
  readonly #allowedHosts: Set<string>;

  constructor(options: GitPolicyOptions = {}) {
    this.#allowWrite = options.allowWrite ?? false;
    const hosts =
      options.allowedRemoteHosts && options.allowedRemoteHosts.length > 0
        ? options.allowedRemoteHosts
        : DEFAULT_REMOTE_HOSTS;
    this.#allowedHosts = new Set(hosts.map((host) => host.toLowerCase()));
  }

  get allowsWrite(): boolean {
    return this.#allowWrite;
  }

  riskFor(operation: GitOperation): RiskLevel {
    return GIT_RISK[operation];
  }

  assertAllowed(operation: GitOperation): void {
    if (isReadOperation(operation)) return;
    if (this.#allowWrite) return;

    throw new PolicyViolationError({
      rule: "git.readOnly",
      message: `Modifying Git operation prohibited: ${operation}`,
      userMessage: `This device is read-only for Git; "${operation}" is refused.`,
      context: { operation },
    });
  }

  assertRemoteAllowed(url: string): void {
    const raw = url.trim();

    if (/^(ext|fd|file)::/i.test(raw) || raw.toLowerCase().startsWith("file://")) {
      throw new PolicyViolationError({
        rule: "git.remoteScheme",
        message: `Repository scheme prohibited: ${raw.slice(0, 32)}`,
        userMessage: "That kind of repository address is not allowed.",
      });
    }

    let host: string;
    try {
      const sshMatch = /^[^@]+@([^:]+):/.exec(raw);
      host = sshMatch?.[1] ?? new URL(raw).hostname;
    } catch {
      throw new PolicyViolationError({
        rule: "git.remoteUrl",
        message: "Unreadable repository address",
        userMessage: "The repository address is invalid.",
      });
    }

    if (!this.#allowedHosts.has(host.toLowerCase())) {
      throw new PolicyViolationError({
        rule: "git.remoteHost",
        message: `Repository host not allowed: ${host}`,
        userMessage: `Repositories hosted on "${host}" are not allowed.`,
        context: { host, allowed: [...this.#allowedHosts] },
      });
    }
  }
}
