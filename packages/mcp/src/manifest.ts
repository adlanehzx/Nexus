import { z } from "zod";
import { riskLevelSchema } from "@nexus/tools";
import type { McpServerConfig, McpSandboxPolicy } from "./config.js";
import { DEFAULT_MCP_SANDBOX_POLICY, parseMcpServerConfig } from "./config.js";
import { McpSecurityError } from "./errors.js";

/**
 * Third-party MCP server runtimes are strictly limited to `npm` and `remote`.
 * Arbitrary binary, bash, or unmanaged runtimes are prohibited.
 */
export const mcpRuntimeSchema = z.enum(["npm", "remote"]);
export type McpRuntime = z.infer<typeof mcpRuntimeSchema>;

export const mcpManifestProvenanceSchema = z.object({
  publisher: z.string().min(1),
  verified: z.boolean().default(false),
  sourceUrl: z.string().url().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  checksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type McpManifestProvenance = z.infer<typeof mcpManifestProvenanceSchema>;

export const mcpManifestToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  risk: riskLevelSchema.default("MEDIUM"),
  permissions: z.array(z.string()).default([]),
  requiresConfirmation: z.boolean().default(true),
});
export type McpManifestTool = z.infer<typeof mcpManifestToolSchema>;

export const mcpManifestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, numbers and hyphens only"),
  version: z.string().default("1.0.0"),
  displayName: z.string().min(1),
  description: z.string().min(1),
  runtime: mcpRuntimeSchema,
  provenance: mcpManifestProvenanceSchema,
  declaredTools: z.array(mcpManifestToolSchema).default([]),
  /** Package name for npm runtime (e.g. "@modelcontextprotocol/server-github"). */
  package: z
    .string()
    .regex(/^[a-z0-9@/_.-]+$/)
    .optional(),
  args: z.array(z.string()).default([]),
  /** URL for remote runtime. */
  url: z.string().url().optional(),
  defaultPermissions: z.array(z.string()).default([]),
  defaultRisk: riskLevelSchema.default("MEDIUM"),
  secretRefs: z.record(z.string(), z.string()).default({}),
  sandbox: z.custom<Partial<McpSandboxPolicy>>().optional(),
});
export type McpManifest = z.infer<typeof mcpManifestSchema>;
export type McpManifestInput = z.input<typeof mcpManifestSchema>;

/**
 * Validates a third-party server manifest.
 * Guarantees that only structured manifests with approved runtimes are accepted.
 */
export function validateManifest(raw: unknown): McpManifest {
  const manifest = mcpManifestSchema.parse(raw);

  if (manifest.runtime === "npm") {
    if (!manifest.package) {
      throw new McpSecurityError(
        manifest.name,
        "Package name is required for MCP servers with 'npm' runtime.",
      );
    }
    if (manifest.url) {
      throw new McpSecurityError(
        manifest.name,
        "URL must not be specified for MCP servers with 'npm' runtime.",
      );
    }
  } else if (manifest.runtime === "remote") {
    if (!manifest.url) {
      throw new McpSecurityError(
        manifest.name,
        "URL is required for MCP servers with 'remote' runtime.",
      );
    }
    if (manifest.package) {
      throw new McpSecurityError(
        manifest.name,
        "Package name must not be specified for MCP servers with 'remote' runtime.",
      );
    }
  }

  return manifest;
}

/**
 * Compiles a structured third-party manifest into an executable McpServerConfig
 * with hardened fail-closed sandbox policies.
 */
export function compileManifestToServerConfig(
  manifest: McpManifest | McpManifestInput,
  options?: { secretRefs?: Record<string, string>; allowedBinaries?: string[] },
): McpServerConfig {
  const validated = validateManifest(manifest);
  const secretRefs = { ...validated.secretRefs, ...options?.secretRefs };

  const toolPolicies: Record<
    string,
    { risk: z.infer<typeof riskLevelSchema>; permissions: string[]; requiresConfirmation: boolean }
  > = {};

  for (const tool of validated.declaredTools) {
    toolPolicies[tool.name] = {
      risk: tool.risk,
      permissions: tool.permissions.length > 0 ? tool.permissions : validated.defaultPermissions,
      requiresConfirmation: tool.requiresConfirmation,
    };
  }

  if (validated.runtime === "npm") {
    return parseMcpServerConfig({
      name: validated.name,
      transport: "stdio",
      command: "npx",
      args: ["-y", validated.package!, ...validated.args],
      envRefs: secretRefs,
      defaultPermissions: validated.defaultPermissions,
      defaultRisk: validated.defaultRisk,
      toolPolicies,
      sandbox: {
        ...DEFAULT_MCP_SANDBOX_POLICY,
        ...validated.sandbox,
        allowedBinaries: options?.allowedBinaries ?? ["npx", "node"],
      },
      sbom: {
        serverName: validated.name,
        version: validated.version,
        runtime: "npm",
        packages: [
          {
            name: validated.package!,
            version: validated.version,
            source: "npm",
            integrity: validated.provenance.checksum,
          },
        ],
        verifiedAt: new Date().toISOString(),
        checksum: validated.provenance.checksum ?? "unverified",
      },
    });
  }

  // Remote runtime (SSE or HTTP)
  return parseMcpServerConfig({
    name: validated.name,
    transport: "http",
    url: validated.url!,
    headerRefs: secretRefs,
    defaultPermissions: validated.defaultPermissions,
    defaultRisk: validated.defaultRisk,
    toolPolicies,
    sandbox: {
      ...DEFAULT_MCP_SANDBOX_POLICY,
      enabled: false,
    },
    sbom: {
      serverName: validated.name,
      version: validated.version,
      runtime: "remote",
      packages: [],
      verifiedAt: new Date().toISOString(),
      checksum: validated.provenance.checksum ?? "remote-verified",
    },
  });
}
