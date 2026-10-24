import { describe, expect, it } from "vitest";
import {
  generateSigningKeyPair,
  signPackagePayload,
  verifyPackageProvenance,
  canonicalizeJson,
} from "../src/marketplace/signatures.js";
import { analyzePackage } from "../src/marketplace/analysis.js";
import { ReputationEngine } from "../src/marketplace/reputation.js";
import { AdvisoryManager } from "../src/marketplace/advisories.js";
import { MarketplaceService } from "../src/marketplace/marketplace-service.js";
import type {
  MarketplacePublisher,
  MarketplaceItem,
  Advisory,
  UserReview,
} from "../src/marketplace/types.js";
import { McpSecurityError } from "../src/errors.js";
import { DEFAULT_MCP_SANDBOX_POLICY } from "../src/config.js";
import { validateManifest } from "../src/manifest.js";

describe("CLA0: Marketplace Trust, Catalogs and Provenance", () => {
  const keyPair = generateSigningKeyPair();
  const testPublisher: MarketplacePublisher = {
    id: "pub-community-1",
    name: "Verified Community Org",
    verified: true,
    publicKey: keyPair.publicKeyPem,
    domain: "community.nexus.test",
    keyFingerprint: keyPair.keyFingerprint,
  };

  describe("Cryptographic Signatures and Provenance Attestation", () => {
    it("signs and successfully verifies valid package manifest", () => {
      const manifest = {
        name: "test-calc",
        version: "1.0.0",
        displayName: "Test Calculator",
        description: "A safe calculator",
        runtime: "npm" as const,
        package: "@nexus/calc-tool",
        args: [],
        provenance: {
          publisher: "Verified Community Org",
          verified: true,
        },
      };

      const provenance = signPackagePayload(manifest, keyPair.privateKeyPem, testPublisher);
      expect(provenance.signature).toBeDefined();
      expect(provenance.attestationHash).toBeDefined();

      const isValid = verifyPackageProvenance(manifest, provenance);
      expect(isValid).toBe(true);
    });

    it("rejects tampered manifest with hash mismatch or signature failure", () => {
      const manifest = {
        name: "test-calc",
        version: "1.0.0",
        description: "Original description",
      };

      const provenance = signPackagePayload(manifest, keyPair.privateKeyPem, testPublisher);

      // Tampered payload
      const tampered = {
        ...manifest,
        description: "Maliciously modified description",
      };

      expect(() => verifyPackageProvenance(tampered, provenance)).toThrow(McpSecurityError);
    });

    it("ensures deterministic canonical JSON key sorting", () => {
      const obj1 = { b: 2, a: 1, c: { y: 20, x: 10 } };
      const obj2 = { a: 1, c: { x: 10, y: 20 }, b: 2 };
      expect(canonicalizeJson(obj1)).toBe(canonicalizeJson(obj2));
    });
  });

  describe("Automated Static & Behavioral Package Analysis", () => {
    it("flags malicious shell commands and injection in arguments as CRITICAL", () => {
      const hostileManifest = {
        name: "evil-tool",
        version: "1.0.0",
        displayName: "Evil Tool",
        description: "Tries command injection",
        runtime: "npm" as const,
        package: "@nexus/evil",
        args: ["; rm -rf /", "/bin/sh -c evil"],
        provenance: { publisher: "Attacker", verified: false },
      };

      const analysis = analyzePackage(hostileManifest);
      expect(analysis.passed).toBe(false);
      expect(analysis.staticRisk).toBe("CRITICAL");
      expect(analysis.findings.some((f) => f.code === "SHELL_INJECTION_RISK")).toBe(true);
    });

    it("flags sensitive path traversal attempts in arguments", () => {
      const traversalManifest = {
        name: "ssh-stealer",
        version: "1.0.0",
        displayName: "SSH Stealer",
        description: "Tries reading ~/.ssh",
        runtime: "npm" as const,
        package: "@nexus/stealer",
        args: ["~/.ssh/id_rsa", "/etc/passwd"],
        provenance: { publisher: "Attacker", verified: false },
      };

      const analysis = analyzePackage(traversalManifest);
      expect(analysis.findings.some((f) => f.code === "SENSITIVE_PATH_TRAVERSAL")).toBe(true);
      expect(analysis.staticRisk).toBe("HIGH");
    });

    it("flags illegal egress targets (metadata and loopback) in remote runtime", () => {
      const ssrfManifest = {
        name: "cloud-metadata-probe",
        version: "1.0.0",
        displayName: "SSRF Probe",
        description: "Reaches out to cloud metadata",
        runtime: "remote" as const,
        url: "http://169.254.169.254/latest/meta-data/",
        provenance: { publisher: "Attacker", verified: false },
      };

      const analysis = analyzePackage(ssrfManifest);
      expect(analysis.passed).toBe(false);
      expect(analysis.findings.some((f) => f.code === "ILLEGAL_REMOTE_TARGET")).toBe(true);
    });

    it("detects dynamic eval and Function constructor in source code", () => {
      const manifest = {
        name: "clean-manifest",
        version: "1.0.0",
        displayName: "Clean Manifest",
        description: "Looks safe in manifest",
        runtime: "npm" as const,
        package: "@nexus/hidden-eval",
        args: [],
        provenance: { publisher: "Attacker", verified: false },
      };

      const analysis = analyzePackage(manifest, "const f = eval('malicious()');");
      expect(analysis.passed).toBe(false);
      expect(analysis.findings.some((f) => f.code === "DYNAMIC_EVAL_USAGE")).toBe(true);
    });
  });

  describe("Abuse-Resistant Reputation & Sybil Defense", () => {
    it("rejects user review without verified installation proof", () => {
      const engine = new ReputationEngine();
      const fakeReview: UserReview = {
        reviewId: "rev-1",
        userId: "user-1",
        itemId: "mcp-test",
        version: "1.0.0",
        rating: 5,
        comment: "Great tool!",
        verifiedInstall: false,
        createdAt: new Date().toISOString(),
      };

      expect(() => engine.submitReview(fakeReview)).toThrow(/Sybil defense/);
    });

    it("calculates Bayesian score for verified reviews", () => {
      const engine = new ReputationEngine();
      const verifiedReview: UserReview = {
        reviewId: "rev-1",
        userId: "user-1",
        itemId: "mcp-calc",
        version: "1.0.0",
        rating: 5,
        comment: "Super helpful",
        verifiedInstall: true,
        createdAt: new Date().toISOString(),
      };

      engine.submitReview(verifiedReview);
      const rep = engine.getReputation("mcp-calc");
      expect(rep.verifiedReviews).toBe(1);
      // Bayesian weighted score with prior (5 * 3.5 + 5) / 6 = 3.75
      expect(rep.score).toBe(3.75);
    });

    it("triggers automatic quarantine when abuse report threshold is reached", () => {
      const engine = new ReputationEngine();
      engine.reportAbuse("mcp-calc", "Spam output");
      engine.reportAbuse("mcp-calc", "Phishing link in output");
      expect(engine.getReputation("mcp-calc").quarantined).toBe(false);

      // 3rd report triggers threshold
      engine.reportAbuse("mcp-calc", "Malicious telemetry");
      expect(engine.getReputation("mcp-calc").quarantined).toBe(true);
    });
  });

  describe("Advisories, Quarantine, Revocation, and Rollback", () => {
    it("quarantines affected items when advisory is published", () => {
      const advManager = new AdvisoryManager();
      const advisory: Advisory = {
        advisoryId: "ADV-2026-001",
        affectedItemIds: ["mcp-vulnerable"],
        affectedVersions: ["1.0.0"],
        severity: "HIGH",
        title: "Vulnerability in parser",
        description: "Buffer overflow risk",
        publishedAt: new Date().toISOString(),
        action: "QUARANTINE",
      };

      advManager.publishAdvisory(advisory);
      expect(advManager.isQuarantined("mcp-vulnerable")).toBe(true);
    });

    it("revokes specific versions and enables rollback to previous safe version", () => {
      const advManager = new AdvisoryManager();
      advManager.recordInstallation("mcp-app", "1.0.0");
      advManager.recordInstallation("mcp-app", "1.1.0");

      const advisory: Advisory = {
        advisoryId: "ADV-2026-002",
        affectedItemIds: ["mcp-app"],
        affectedVersions: ["1.1.0"],
        severity: "CRITICAL",
        title: "Malware in v1.1.0",
        description: "Credential stealer found in 1.1.0 release",
        publishedAt: new Date().toISOString(),
        action: "REVOKE",
      };

      advManager.publishAdvisory(advisory);

      const revCheck = advManager.isRevoked("mcp-app", "1.1.0");
      expect(revCheck.revoked).toBe(true);

      const rollbackRes = advManager.rollback("mcp-app");
      expect(rollbackRes.success).toBe(true);
      expect(rollbackRes.restoredVersion).toBe("1.0.0");
      expect(rollbackRes.previousVersion).toBe("1.1.0");
    });
  });

  describe("MarketplaceService End-to-End Workflow", () => {
    it("provides offline curated catalog immediately without remote access", () => {
      const service = new MarketplaceService({ offlineOnly: true });
      const items = service.searchItems();
      expect(items.length).toBeGreaterThan(0);

      // Verify curated items like github, filesystem, memory are present
      const github = service.getItem("mcp-github");
      expect(github).toBeDefined();
      expect(github?.publisher.verified).toBe(true);
      expect(github?.quarantined).toBe(false);
    });

    it("previews permissions and elevated access before installation", () => {
      const service = new MarketplaceService();
      const preview = service.previewPermissions("mcp-github");

      expect(preview.itemId).toBe("mcp-github");
      expect(preview.permissionsRequested).toContain("github.read");
      expect(preview.requiresSecrets).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
      expect(preview.resourceCeiling.maxMemoryMb).toBe(512);
    });

    it("registers and installs valid community package with resource ceilings and sandbox", () => {
      const service = new MarketplaceService();

      const manifestInput = {
        name: "math-solver",
        version: "1.0.0",
        displayName: "Math Solver",
        description: "Performs mathematical proofs",
        runtime: "npm" as const,
        package: "@community/math-solver",
        args: [],
        defaultPermissions: ["compute.basic"],
        declaredTools: [
          {
            name: "solve_equation",
            risk: "SAFE" as const,
            permissions: ["compute.basic"],
            requiresConfirmation: false,
          },
        ],
        provenance: {
          publisher: "Verified Community Org",
          verified: true,
        },
      };

      const manifest = validateManifest(manifestInput);
      const provenance = signPackagePayload(manifest, keyPair.privateKeyPem, testPublisher);

      const item: MarketplaceItem = {
        id: "mcp-math-solver",
        kind: "mcp",
        name: "math-solver",
        version: "1.0.0",
        previousVersions: [],
        description: "Performs mathematical proofs",
        publisher: testPublisher,
        provenance,
        analysis: {
          passed: true,
          staticRisk: "SAFE",
          findings: [],
          egressTargets: [],
          declaredPermissions: ["compute.basic"],
        },
        reputation: {
          score: 4.8,
          reviewCount: 15,
          verifiedReviews: 15,
          reportsCount: 0,
          quarantined: false,
        },
        permissions: ["compute.basic"],
        resourceCeiling: { maxMemoryMb: 256, cpuPercent: 30, maxPids: 32 },
        sandboxPolicy: DEFAULT_MCP_SANDBOX_POLICY,
        manifest,
        quarantined: false,
        revoked: false,
      };

      service.registerPublicItem(item);

      const installResult = service.installItem("mcp-math-solver");
      expect(installResult.success).toBe(true);
      expect(installResult.serverConfig).toBeDefined();
      if (installResult.serverConfig?.transport === "stdio") {
        expect(installResult.serverConfig.command).toBe("npx");
      }
      expect(installResult.resourceCeiling.maxMemoryMb).toBe(256);
      expect(service.isInstalled("mcp-math-solver")).toBe(true);
    });

    it("fail-closed: refuses to install quarantined or revoked packages", () => {
      const service = new MarketplaceService();
      const manifestInput = {
        name: "untrusted-helper",
        version: "1.0.0",
        displayName: "Untrusted Helper",
        description: "Flagged tool",
        runtime: "npm" as const,
        package: "@bad/tool",
        args: [],
        provenance: { publisher: testPublisher.name, verified: true },
      };
      const manifest = validateManifest(manifestInput);
      const provenance = signPackagePayload(manifest, keyPair.privateKeyPem, testPublisher);

      const item: MarketplaceItem = {
        id: "mcp-untrusted",
        kind: "mcp",
        name: "untrusted-helper",
        version: "1.0.0",
        previousVersions: [],
        description: "Flagged tool",
        publisher: testPublisher,
        provenance,
        analysis: {
          passed: true,
          staticRisk: "SAFE",
          findings: [],
          egressTargets: [],
          declaredPermissions: [],
        },
        reputation: {
          score: 1.0,
          reviewCount: 0,
          verifiedReviews: 0,
          reportsCount: 5,
          quarantined: true,
        },
        permissions: [],
        resourceCeiling: { maxMemoryMb: 256, cpuPercent: 30, maxPids: 32 },
        sandboxPolicy: DEFAULT_MCP_SANDBOX_POLICY,
        manifest,
        quarantined: true,
        revoked: false,
      };

      service.registerPublicItem(item);

      expect(() => service.installItem("mcp-untrusted")).toThrow(/quarantined/);
    });
  });
});
