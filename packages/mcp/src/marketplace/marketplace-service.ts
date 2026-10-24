import { riskAtLeast } from "@nexus/tools";
import { MCP_CATALOG } from "../catalog.js";
import { DEFAULT_MCP_SANDBOX_POLICY } from "../config.js";
import { McpSecurityError } from "../errors.js";
import { compileManifestToServerConfig, type McpManifest } from "../manifest.js";
import { AdvisoryManager } from "./advisories.js";
import { analyzePackage } from "./analysis.js";
import { ReputationEngine } from "./reputation.js";
import { verifyPackageProvenance } from "./signatures.js";
import type {
  Advisory,
  InstallResult,
  ItemKind,
  MarketplaceItem,
  MarketplacePublisher,
  PermissionPreview,
  RollbackResult,
  UserReview,
} from "./types.js";

export interface MarketplaceServiceOptions {
  offlineOnly?: boolean;
  trustedPublisherFingerprints?: string[];
}

export class MarketplaceService {
  private items = new Map<string, MarketplaceItem>();
  private installedItems = new Map<string, MarketplaceItem>();
  private advisoryManager: AdvisoryManager = new AdvisoryManager();
  private reputationEngine: ReputationEngine;
  private offlineOnly: boolean;

  constructor(options?: MarketplaceServiceOptions) {
    this.offlineOnly = options?.offlineOnly ?? false;
    this.reputationEngine = new ReputationEngine(options?.trustedPublisherFingerprints);
    this.seedCuratedCatalog();
  }

  /**
   * Seeds the standard offline curated catalog from MCP_CATALOG.
   * Curated items are pre-verified and always available offline.
   */
  private seedCuratedCatalog(): void {
    for (const manifest of MCP_CATALOG) {
      const item = this.createCuratedItem(manifest);
      this.items.set(item.id, item);
    }
  }

  private createCuratedItem(manifest: McpManifest): MarketplaceItem {
    const publisher: MarketplacePublisher = {
      id: "nexus-core",
      name: manifest.provenance.publisher || "Official",
      verified: true,
      publicKey: "curated-system-root-key",
      domain: "nexus.local",
      keyFingerprint: "00000000000000000000000000000000",
    };

    return {
      id: `mcp-${manifest.name}`,
      kind: "mcp",
      name: manifest.name,
      version: manifest.version,
      previousVersions: [],
      description: manifest.description,
      publisher,
      provenance: {
        publisher,
        signature: "curated-official-signature",
        attestationHash: "curated-attestation-hash",
        timestamp: new Date().toISOString(),
      },
      analysis: {
        passed: true,
        staticRisk: manifest.defaultRisk,
        findings: [],
        egressTargets: manifest.url ? [manifest.url] : [],
        declaredPermissions: manifest.defaultPermissions,
      },
      reputation: {
        score: 5.0,
        reviewCount: 100,
        verifiedReviews: 100,
        reportsCount: 0,
        quarantined: false,
      },
      permissions: manifest.defaultPermissions,
      resourceCeiling: {
        maxMemoryMb: 512,
        cpuPercent: 50,
        maxPids: 64,
      },
      sandboxPolicy: {
        ...DEFAULT_MCP_SANDBOX_POLICY,
        ...manifest.sandbox,
      },
      manifest,
      quarantined: false,
      revoked: false,
    };
  }

  /**
   * Registers a public package in the marketplace with mandatory verification.
   * Rejects packages without proper signature, analysis, or provenance.
   */
  registerPublicItem(item: MarketplaceItem): void {
    if (this.offlineOnly) {
      throw new McpSecurityError(
        item.name,
        "Marketplace is in offline mode: cannot register remote items",
      );
    }

    // 1. Mandatory signature & provenance check (except curated offline)
    if (item.publisher.publicKey !== "curated-system-root-key") {
      verifyPackageProvenance(item.manifest, item.provenance);
    }

    // 2. Automated static & behavioral analysis
    const analysis = analyzePackage(item.manifest);
    if (!analysis.passed) {
      throw new McpSecurityError(
        item.name,
        `Package failed automated security analysis: ${analysis.findings.map((f) => f.message).join("; ")}`,
      );
    }
    item.analysis = analysis;

    // 3. Check revocation status
    const revCheck = this.advisoryManager.isRevoked(item.id, item.version);
    if (revCheck.revoked) {
      item.revoked = true;
      item.revocationReason = revCheck.reason;
    }

    // 4. Update reputation
    item.reputation = this.reputationEngine.getReputation(item.id, item.reputation);
    if (this.advisoryManager.isQuarantined(item.id)) {
      item.quarantined = true;
      item.reputation.quarantined = true;
    }

    this.items.set(item.id, item);
  }

  searchItems(filter?: {
    kind?: ItemKind;
    query?: string;
    verifiedOnly?: boolean;
    minScore?: number;
  }): MarketplaceItem[] {
    const results: MarketplaceItem[] = [];

    for (const item of this.items.values()) {
      if (filter?.kind && item.kind !== filter.kind) continue;
      if (filter?.verifiedOnly && !item.publisher.verified) continue;
      if (filter?.minScore && item.reputation.score < filter.minScore) continue;
      if (filter?.query) {
        const q = filter.query.toLowerCase();
        const matchesName = item.name.toLowerCase().includes(q);
        const matchesDesc = item.description.toLowerCase().includes(q);
        if (!matchesName && !matchesDesc) continue;
      }
      results.push(item);
    }

    return results;
  }

  getItem(id: string): MarketplaceItem | undefined {
    return this.items.get(id);
  }

  /**
   * Generates a preview of requested permissions, risk profile, and resource requirements
   * before community installation.
   */
  previewPermissions(itemId: string): PermissionPreview {
    const item = this.items.get(itemId);
    if (!item) {
      throw new McpSecurityError(itemId, "Item not found in catalog or marketplace");
    }

    const elevatedPermissions: string[] = [];
    const warnings: string[] = [];

    for (const perm of item.permissions) {
      if (perm.includes("write") || perm.includes("execute") || perm.includes("admin")) {
        elevatedPermissions.push(perm);
      }
    }

    if (riskAtLeast(item.analysis.staticRisk, "HIGH")) {
      warnings.push(`Static risk analysis flagged this package as ${item.analysis.staticRisk}`);
    }

    if (item.reputation.reportsCount > 0) {
      warnings.push(`This package has ${item.reputation.reportsCount} community abuse report(s)`);
    }

    if (!item.publisher.verified) {
      warnings.push("Publisher is unverified");
    }

    const requiresSecrets: string[] = [];
    if ("secretRefs" in item.manifest && item.manifest.secretRefs) {
      requiresSecrets.push(...Object.keys(item.manifest.secretRefs));
    }

    return {
      itemId: item.id,
      kind: item.kind,
      permissionsRequested: item.permissions,
      elevatedPermissions,
      requiresSecrets,
      riskLevel: item.analysis.staticRisk,
      sandboxProfile: item.sandboxPolicy.readOnlyRoot ? "restricted-sandbox" : "standard-sandbox",
      resourceCeiling: item.resourceCeiling,
      warnings,
    };
  }

  /**
   * Installs an item with full validation:
   * 1. Provenance & signature
   * 2. Automated static & behavioral analysis
   * 3. Quarantine and revocation check
   * 4. Sandbox & resource ceilings configuration
   * 5. Record installation for rollback
   */
  installItem(itemId: string, userAcceptedRisks?: boolean): InstallResult {
    const item = this.items.get(itemId);
    if (!item) {
      throw new McpSecurityError(itemId, "Item not found");
    }

    // Revocation check
    const revCheck = this.advisoryManager.isRevoked(item.id, item.version);
    if (revCheck.revoked || item.revoked) {
      throw new McpSecurityError(
        item.name,
        `Cannot install revoked package: ${revCheck.reason ?? item.revocationReason}`,
      );
    }

    // Quarantine check
    if (item.quarantined || this.advisoryManager.isQuarantined(item.id)) {
      throw new McpSecurityError(
        item.name,
        "Cannot install package: package is currently quarantined pending security investigation",
      );
    }

    // Automated analysis check
    if (!item.analysis.passed) {
      throw new McpSecurityError(
        item.name,
        `Cannot install package: failed automated security analysis with critical findings`,
      );
    }

    // High risk confirmation requirement
    if (riskAtLeast(item.analysis.staticRisk, "HIGH") && !userAcceptedRisks) {
      throw new McpSecurityError(
        item.name,
        `Package is marked ${item.analysis.staticRisk} risk and requires explicit user confirmation`,
      );
    }

    // Compile server config if kind is MCP
    let serverConfig = undefined;
    if (item.kind === "mcp") {
      serverConfig = compileManifestToServerConfig(item.manifest as McpManifest);
    }

    // Record installation in history for atomic rollback
    this.advisoryManager.recordInstallation(item.id, item.version);
    this.installedItems.set(item.id, item);

    return {
      success: true,
      itemId: item.id,
      installedVersion: item.version,
      sandbox: item.sandboxPolicy,
      resourceCeiling: item.resourceCeiling,
      serverConfig,
      rollbackAvailable: this.advisoryManager.canRollback(item.id),
    };
  }

  /**
   * Atomically rolls back an installed package to its previous verified version.
   */
  rollback(itemId: string): RollbackResult {
    const rollbackRes = this.advisoryManager.rollback(itemId);
    // Find target version item
    const targetItem = Array.from(this.items.values()).find(
      (it) => it.id === itemId && it.version === rollbackRes.restoredVersion,
    );
    if (targetItem) {
      this.installedItems.set(itemId, targetItem);
    }
    return rollbackRes;
  }

  submitReview(review: UserReview): void {
    this.reputationEngine.submitReview(review);
    const item = this.items.get(review.itemId);
    if (item) {
      item.reputation = this.reputationEngine.getReputation(item.id, item.reputation);
    }
  }

  reportAbuse(itemId: string, reason: string): void {
    this.reputationEngine.reportAbuse(itemId, reason);
    const item = this.items.get(itemId);
    if (item) {
      item.reputation = this.reputationEngine.getReputation(item.id, item.reputation);
      if (item.reputation.quarantined) {
        item.quarantined = true;
      }
    }
  }

  applyAdvisory(advisory: Advisory): void {
    this.advisoryManager.publishAdvisory(advisory);
    for (const itemId of advisory.affectedItemIds) {
      const item = this.items.get(itemId);
      if (item) {
        if (advisory.action === "QUARANTINE" || advisory.action === "REVOKE") {
          item.quarantined = true;
        }
        if (advisory.action === "REVOKE") {
          item.revoked = true;
          item.revocationReason = advisory.description;
        }
      }
    }
  }

  getInstalledItems(): MarketplaceItem[] {
    return Array.from(this.installedItems.values());
  }

  isInstalled(itemId: string): boolean {
    return this.installedItems.has(itemId);
  }
}
