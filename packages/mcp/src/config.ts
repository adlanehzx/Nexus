import { z } from "zod";
import { riskLevelSchema } from "@nexus/tools";

/**
 * MCP server configuration.
 *
 * Stored in the database (`McpServer` table) and dynamically updatable:
 * adding an MCP server does not restart the backend or alter the agent core
 * (cf. ADR-005).
 */

export const mcpTransportSchema = z.enum(["stdio", "http", "sse"]);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

/**
 * Permission policy applied to tools provided by an MCP server.
 *
 * Two levels: server default, and tool-level overrides.
 */
export const mcpToolPolicySchema = z.object({
  permissions: z.array(z.string()).optional(),
  risk: riskLevelSchema.optional(),
  requiresConfirmation: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** Excludes the tool from the registry without disabling the whole server. */
  disabled: z.boolean().optional(),
});
export type McpToolPolicy = z.infer<typeof mcpToolPolicySchema>;

export const mcpBindMountSchema = z.object({
  hostPath: z.string().min(1),
  containerPath: z.string().optional(),
  readOnly: z.boolean().default(true),
});
export type McpBindMount = z.infer<typeof mcpBindMountSchema>;

export const DEFAULT_MCP_RESOURCE_LIMITS = {
  maxMemoryMb: 512,
  cpuShares: 1024,
  maxPids: 64,
  timeoutMs: 60_000,
} as const;

export const mcpResourceLimitsSchema = z.object({
  maxMemoryMb: z.number().int().positive().default(DEFAULT_MCP_RESOURCE_LIMITS.maxMemoryMb),
  cpuShares: z.number().int().positive().default(DEFAULT_MCP_RESOURCE_LIMITS.cpuShares),
  maxPids: z.number().int().positive().default(DEFAULT_MCP_RESOURCE_LIMITS.maxPids),
  timeoutMs: z.number().int().positive().default(DEFAULT_MCP_RESOURCE_LIMITS.timeoutMs),
});
export type McpResourceLimits = z.infer<typeof mcpResourceLimitsSchema>;

export const DEFAULT_MCP_ALLOWED_BINARIES = [
  "node",
  "npx",
  "python",
  "python3",
  "uv",
  "uvx",
  "docker",
  "bwrap",
] as const;

export const DEFAULT_MCP_SANDBOX_POLICY = {
  enabled: true,
  engine: "bwrap" as const,
  readOnlyRoot: true,
  bindMounts: [] as McpBindMount[],
  allowNetwork: false,
  resourceLimits: DEFAULT_MCP_RESOURCE_LIMITS,
  allowedBinaries: [...DEFAULT_MCP_ALLOWED_BINARIES] as string[],
};

export const mcpSandboxPolicySchema = z.object({
  enabled: z.boolean().default(DEFAULT_MCP_SANDBOX_POLICY.enabled),
  engine: z.enum(["bwrap", "docker", "none"]).default(DEFAULT_MCP_SANDBOX_POLICY.engine),
  readOnlyRoot: z.boolean().default(DEFAULT_MCP_SANDBOX_POLICY.readOnlyRoot),
  bindMounts: z.array(mcpBindMountSchema).default(DEFAULT_MCP_SANDBOX_POLICY.bindMounts),
  allowNetwork: z.boolean().default(DEFAULT_MCP_SANDBOX_POLICY.allowNetwork),
  resourceLimits: mcpResourceLimitsSchema.default(DEFAULT_MCP_RESOURCE_LIMITS),
  allowedBinaries: z.array(z.string()).default([...DEFAULT_MCP_ALLOWED_BINARIES]),
  verifyChecksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type McpSandboxPolicy = z.infer<typeof mcpSandboxPolicySchema>;

export const mcpSbomPackageSchema = z.object({
  name: z.string(),
  version: z.string(),
  integrity: z.string().optional(),
  license: z.string().optional(),
  source: z.string().optional(),
});

export const mcpSbomSchema = z.object({
  serverName: z.string(),
  version: z.string().default("1.0.0"),
  runtime: z.string().default("node"),
  packages: z.array(mcpSbomPackageSchema).default([]),
  verifiedAt: z.string().datetime(),
  checksum: z.string(),
});
export type McpSbom = z.infer<typeof mcpSbomSchema>;

const baseConfig = z.object({
  /** Short stable identifier prefixing tools: `mcp.<name>.<tool>`. */
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, numbers and hyphens only"),
  enabled: z.boolean().default(true),

  /** Default permissions required for any tool on this server. */
  defaultPermissions: z.array(z.string()).default([]),
  /**
   * Default risk level for discovered tools.
   * `MEDIUM` by default requiring confirmation.
   */
  defaultRisk: riskLevelSchema.default("MEDIUM"),
  toolPolicies: z.record(z.string(), mcpToolPolicySchema).default({}),

  /** Connection and handshake timeout in ms. */
  connectTimeoutMs: z.number().int().positive().default(15_000),
  /** Tool execution timeout in ms. */
  requestTimeoutMs: z.number().int().positive().default(60_000),

  /** Automatic reconnection. */
  autoReconnect: z.boolean().default(true),
  maxReconnectAttempts: z.number().int().min(0).default(5),
  reconnectInitialDelayMs: z.number().int().positive().default(500),
  reconnectMaxDelayMs: z.number().int().positive().default(30_000),
  /** Consecutive failures before opening circuit breaker. */
  circuitBreakerThreshold: z.number().int().min(1).default(5),
  circuitBreakerResetMs: z.number().int().positive().default(60_000),

  /** Expose server resources as read tools. */
  exposeResources: z.boolean().default(true),

  /** Container sandbox policy (bwrap / docker / none). */
  sandbox: mcpSandboxPolicySchema.default(DEFAULT_MCP_SANDBOX_POLICY),
  /** Software Bill of Materials (SBOM) and verified provenance. */
  sbom: mcpSbomSchema.optional(),
});

const stdioConfig = baseConfig.extend({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Child process environment variables. */
  env: z.record(z.string(), z.string()).default({}),
  envRefs: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
});

const httpConfig = baseConfig.extend({
  transport: z.union([z.literal("http"), z.literal("sse")]),
  url: z.string().refine((value) => URL.canParse(value), "invalid URL"),
  headers: z.record(z.string(), z.string()).default({}),
  headerRefs: z.record(z.string(), z.string()).default({}),
});

export const mcpServerConfigSchema = z.discriminatedUnion("transport", [stdioConfig, httpConfig]);

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpStdioConfig = z.infer<typeof stdioConfig>;
export type McpHttpConfig = z.infer<typeof httpConfig>;

export function isStdioConfig(config: McpServerConfig): config is McpStdioConfig {
  return config.transport === "stdio";
}

/**
 * Validates raw configuration (file, DB, UI).
 */
export function parseMcpServerConfig(input: unknown): McpServerConfig {
  return mcpServerConfigSchema.parse(input);
}

/**
 * Safe representation for logging.
 * Environment and header values are redacted, keeping only keys.
 */
export function describeConfig(config: McpServerConfig): Record<string, unknown> {
  const common = {
    name: config.name,
    transport: config.transport,
    enabled: config.enabled,
    defaultRisk: config.defaultRisk,
  };

  return isStdioConfig(config)
    ? {
        ...common,
        command: config.command,
        args: config.args,
        envKeys: Object.keys(config.env),
        envRefKeys: Object.keys(config.envRefs),
      }
    : {
        ...common,
        url: config.url,
        headerKeys: Object.keys(config.headers),
        headerRefKeys: Object.keys(config.headerRefs),
      };
}
