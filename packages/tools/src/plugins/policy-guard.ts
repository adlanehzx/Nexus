import { PluginSecurityError } from "./sandbox.js";
import type { PluginManifest, PluginPolicyApproval } from "./types.js";

export interface PublicReputationAdvisory {
  score: number;
  reviewCount: number;
  publicRecommended: boolean;
  communityNotice?: string | undefined;
}

export interface LocalSecurityPolicy {
  allowedPermissions: Set<string>;
  allowedEgressDomains: Set<string>;
  requireExplicitApproval: boolean;
  blockedPublishers: Set<string>;
}

export class PluginPolicyGuard {
  private readonly localPolicy: LocalSecurityPolicy;

  constructor(localPolicy: LocalSecurityPolicy) {
    this.localPolicy = localPolicy;
  }

  /**
   * Asserts that a plugin is compliant with local security policy.
   * Invariant: Advisory public reputation CAN NEVER override local security policy.
   */
  assertLocalPolicyCompliance(
    manifest: PluginManifest,
    approval?: PluginPolicyApproval,
    reputation?: PublicReputationAdvisory,
  ): void {
    // 1. Publisher blocklist check
    if (this.localPolicy.blockedPublishers.has(manifest.provenance.publisher)) {
      throw new PluginSecurityError(
        `Plugin publisher '${manifest.provenance.publisher}' is blocked by local security policy`,
        "PUBLISHER_BLOCKED_BY_LOCAL_POLICY",
      );
    }

    // 2. Permission check: every required permission must be in local allowedPermissions
    for (const perm of manifest.requiredPermissions) {
      if (!this.localPolicy.allowedPermissions.has(perm)) {
        // Even if public reputation is 5.0 and recommended, local policy REFUSES!
        const repNote = reputation?.publicRecommended
          ? " (Public reputation cannot override local policy)"
          : "";
        throw new PluginSecurityError(
          `Permission '${perm}' is forbidden by local security policy${repNote}`,
          "PERMISSION_DENIED_BY_LOCAL_POLICY",
        );
      }
    }

    // 3. Egress check: every allowed egress domain must be in local policy
    for (const domain of manifest.allowedEgress) {
      if (!this.localPolicy.allowedEgressDomains.has(domain)) {
        throw new PluginSecurityError(
          `Egress domain '${domain}' is prohibited by local network policy`,
          "EGRESS_DENIED_BY_LOCAL_POLICY",
        );
      }
    }

    // 4. Approval check
    if (this.localPolicy.requireExplicitApproval && !approval) {
      throw new PluginSecurityError(
        "Local security policy mandates explicit administrator policy approval before activation",
        "UNAPPROVED_BY_LOCAL_POLICY",
      );
    }
  }
}
