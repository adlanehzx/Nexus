import { z } from "zod";
import { riskLevelSchema, type RiskLevel } from "@nexus/tools";
import type { McpServerConfig, McpSandboxPolicy } from "../config.js";
import { mcpManifestSchema } from "../manifest.js";

export const itemKindSchema = z.enum(["mcp", "acp", "worker", "workflow"]);
export type ItemKind = z.infer<typeof itemKindSchema>;

export const marketplacePublisherSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  verified: z.boolean().default(false),
  publicKey: z.string().min(1), // Base64-encoded Ed25519 public key or PEM
  domain: z.string().optional(),
  keyFingerprint: z.string().min(1),
});
export type MarketplacePublisher = z.infer<typeof marketplacePublisherSchema>;

export const packageProvenanceSchema = z.object({
  publisher: marketplacePublisherSchema,
  signature: z.string().min(1), // Ed25519 signature over canonical manifest payload
  attestationHash: z.string().min(1), // SHA-256 hash of attestation
  timestamp: z.string(),
  sourceUrl: z.string().url().optional(),
});
export type PackageProvenance = z.infer<typeof packageProvenanceSchema>;

export const packageFindingSchema = z.object({
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  code: z.string(),
  message: z.string(),
});
export type PackageFinding = z.infer<typeof packageFindingSchema>;

export const packageAnalysisResultSchema = z.object({
  passed: z.boolean(),
  staticRisk: riskLevelSchema,
  findings: z.array(packageFindingSchema),
  egressTargets: z.array(z.string()),
  declaredPermissions: z.array(z.string()),
});
export type PackageAnalysisResult = z.infer<typeof packageAnalysisResultSchema>;

export const itemReputationSchema = z.object({
  score: z.number().min(0).max(5), // 0 to 5 score
  reviewCount: z.number().nonnegative(),
  verifiedReviews: z.number().nonnegative(),
  reportsCount: z.number().nonnegative(),
  quarantined: z.boolean().default(false),
});
export type ItemReputation = z.infer<typeof itemReputationSchema>;

export const resourceCeilingSchema = z.object({
  maxMemoryMb: z.number().positive(),
  cpuPercent: z.number().positive().max(100),
  maxPids: z.number().positive(),
});
export type ResourceCeiling = z.infer<typeof resourceCeilingSchema>;

export const acpAgentManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  acpEndpoint: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  requiredPermissions: z.array(z.string()).default([]),
});
export type AcpAgentManifest = z.infer<typeof acpAgentManifestSchema>;

export const workerCatalogManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  platform: z.enum(["linux", "darwin", "windows", "android", "cloud"]),
  capabilities: z.array(z.string()).default([]),
  hardwareRequirements: z.record(z.string(), z.string()).optional(),
  networkPolicy: z.enum(["isolated", "lan_only", "egress_allowlist", "full"]).default("lan_only"),
});
export type WorkerCatalogManifest = z.infer<typeof workerCatalogManifestSchema>;

export const workflowCatalogManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  stepsCount: z.number().positive(),
  inputs: z.record(z.string(), z.string()).default({}),
  outputs: z.record(z.string(), z.string()).default({}),
  requiredTools: z.array(z.string()).default([]),
  requiredPermissions: z.array(z.string()).default([]),
});
export type WorkflowCatalogManifest = z.infer<typeof workflowCatalogManifestSchema>;

export const marketplaceItemSchema = z.object({
  id: z.string().min(1),
  kind: itemKindSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  previousVersions: z.array(z.string()).default([]),
  description: z.string().min(1),
  publisher: marketplacePublisherSchema,
  provenance: packageProvenanceSchema,
  analysis: packageAnalysisResultSchema,
  reputation: itemReputationSchema,
  permissions: z.array(z.string()).default([]),
  resourceCeiling: resourceCeilingSchema,
  sandboxPolicy: z.custom<McpSandboxPolicy>(),
  manifest: z.union([
    mcpManifestSchema,
    acpAgentManifestSchema,
    workerCatalogManifestSchema,
    workflowCatalogManifestSchema,
  ]),
  quarantined: z.boolean().default(false),
  revoked: z.boolean().default(false),
  revocationReason: z.string().optional(),
});
export type MarketplaceItem = z.infer<typeof marketplaceItemSchema>;

export interface PermissionPreview {
  itemId: string;
  kind: ItemKind;
  permissionsRequested: string[];
  elevatedPermissions: string[];
  requiresSecrets: string[];
  riskLevel: RiskLevel;
  sandboxProfile: string;
  resourceCeiling: ResourceCeiling;
  warnings: string[];
}

export interface InstallResult {
  success: boolean;
  itemId: string;
  installedVersion: string;
  sandbox: McpSandboxPolicy;
  resourceCeiling: ResourceCeiling;
  serverConfig?: McpServerConfig | undefined;
  rollbackAvailable: boolean;
}

export interface RollbackResult {
  success: boolean;
  itemId: string;
  restoredVersion: string;
  previousVersion: string;
}

export const advisorySchema = z.object({
  advisoryId: z.string().min(1),
  affectedItemIds: z.array(z.string()).min(1),
  affectedVersions: z.array(z.string()).min(1),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  title: z.string().min(1),
  description: z.string().min(1),
  publishedAt: z.string(),
  action: z.enum(["QUARANTINE", "REVOKE", "WARN"]),
});
export type Advisory = z.infer<typeof advisorySchema>;

export interface UserReview {
  reviewId: string;
  userId: string;
  itemId: string;
  version: string;
  rating: number; // 1 to 5
  comment: string;
  verifiedInstall: boolean;
  createdAt: string;
}
