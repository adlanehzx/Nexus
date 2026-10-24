import type { Advisory, RollbackResult } from "./types.js";
import { McpSecurityError } from "../errors.js";

export class AdvisoryManager {
  private advisories = new Map<string, Advisory>();
  private quarantinedItems = new Set<string>();
  private revokedItems = new Map<string, { reason: string; affectedVersions: string[] }>();
  private installationHistory = new Map<string, string[]>(); // itemId -> [v1, v2, v3...]

  publishAdvisory(advisory: Advisory): void {
    this.advisories.set(advisory.advisoryId, advisory);

    for (const itemId of advisory.affectedItemIds) {
      if (advisory.action === "QUARANTINE") {
        this.quarantinedItems.add(itemId);
      } else if (advisory.action === "REVOKE") {
        this.revokedItems.set(itemId, {
          reason: advisory.description,
          affectedVersions: advisory.affectedVersions,
        });
        this.quarantinedItems.add(itemId);
      }
    }
  }

  isQuarantined(itemId: string): boolean {
    return this.quarantinedItems.has(itemId);
  }

  isRevoked(itemId: string, version: string): { revoked: boolean; reason?: string } {
    const rev = this.revokedItems.get(itemId);
    if (!rev) return { revoked: false };
    if (rev.affectedVersions.includes(version) || rev.affectedVersions.includes("*")) {
      return { revoked: true, reason: rev.reason };
    }
    return { revoked: false };
  }

  recordInstallation(itemId: string, version: string): void {
    const history = this.installationHistory.get(itemId) ?? [];
    if (history[history.length - 1] !== version) {
      history.push(version);
      this.installationHistory.set(itemId, history);
    }
  }

  canRollback(itemId: string): boolean {
    const history = this.installationHistory.get(itemId) ?? [];
    return history.length >= 2;
  }

  rollback(itemId: string): RollbackResult {
    const history = this.installationHistory.get(itemId);
    if (!history || history.length < 2) {
      throw new McpSecurityError(itemId, "No previous verified version available for rollback");
    }

    const currentVersion = history.pop()!;
    const previousVersion = history[history.length - 1];
    if (!previousVersion) {
      throw new McpSecurityError(itemId, "No previous verified version available for rollback");
    }

    // Check if the previous version is also revoked
    const check = this.isRevoked(itemId, previousVersion);
    if (check.revoked) {
      throw new McpSecurityError(
        itemId,
        `Cannot rollback to version ${previousVersion}: version is revoked (${check.reason})`,
      );
    }

    return {
      success: true,
      itemId,
      restoredVersion: previousVersion,
      previousVersion: currentVersion,
    };
  }

  listAdvisories(): Advisory[] {
    return Array.from(this.advisories.values());
  }
}
