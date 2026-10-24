import { z } from "zod";
import { riskLevelSchema } from "../risk.js";

export const pluginToolDeclarationSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  riskLevel: riskLevelSchema.default("MEDIUM"),
  requiredPermissions: z.array(z.string()).default([]),
  requiresConfirmation: z.boolean().default(true),
  handlerCode: z.string().default(""), // Pure declarative script or JSON transformation
});
export type PluginToolDeclaration = z.infer<typeof pluginToolDeclarationSchema>;

export const pluginManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  author: z.string().min(1),
  description: z.string().default(""),
  requiredPermissions: z.array(z.string()).default([]),
  declaredTools: z.array(pluginToolDeclarationSchema).min(1),
  allowedEgress: z.array(z.string()).default([]),
  tenantId: z.string().optional(),
  secretRefs: z.record(z.string(), z.string()).default({}),
  provenance: z.object({
    publisher: z.string().min(1),
    signature: z.string().min(1),
    verified: z.boolean().default(false),
  }),
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export type PluginState =
  "INSTALLED_DISABLED" | "POLICY_VALIDATED" | "ACTIVE" | "SUSPENDED" | "REVOKED";

export interface PluginPolicyApproval {
  approvedPermissions: string[];
  approvedEgress: string[];
  tenantId?: string | undefined;
  approvedBy: string;
  approvedAt: string;
}

export interface PluginExecutionResult {
  success: boolean;
  pluginId: string;
  toolName: string;
  output: unknown;
  durationMs: number;
}
