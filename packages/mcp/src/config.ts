import { z } from "zod";
import { riskLevelSchema } from "@nexus/tools";

/**
 * Configuration d'un serveur MCP.
 *
 * Elle vit en base (table `McpServer`) et se modifie depuis l'application :
 * ajouter un serveur ne redémarre pas le backend et ne touche pas au cœur agent
 * (cf. ADR-005).
 */

export const mcpTransportSchema = z.enum(["stdio", "http", "sse"]);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

/**
 * Politique de permission appliquée aux outils d'un serveur.
 *
 * Deux niveaux : un défaut pour tout le serveur, et des surcharges par outil.
 * C'est **la seule** façon d'abaisser le risque d'un outil MCP — jamais une
 * annotation renvoyée par le serveur lui-même (voir `tool-adapter.ts`).
 */
export const mcpToolPolicySchema = z.object({
  permissions: z.array(z.string()).optional(),
  risk: riskLevelSchema.optional(),
  requiresConfirmation: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** Exclut l'outil du registre sans désactiver tout le serveur. */
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
  verifyChecksum: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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
  /** Identifiant court et stable ; il préfixe les outils : `mcp.<name>.<outil>`. */
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "minuscules, chiffres et tirets uniquement"),
  enabled: z.boolean().default(true),

  /** Permissions exigées par défaut pour tout outil de ce serveur. */
  defaultPermissions: z.array(z.string()).default([]),
  /**
   * Risque par défaut des outils découverts.
   *
   * `MEDIUM` — donc confirmation — parce qu'un serveur MCP tiers est du code
   * non audité dont on ne sait pas ce qu'il fait. L'abaisser est une décision
   * humaine, prise outil par outil.
   */
  defaultRisk: riskLevelSchema.default("MEDIUM"),
  toolPolicies: z.record(z.string(), mcpToolPolicySchema).default({}),

  /** Délai d'établissement de la connexion et du handshake. */
  connectTimeoutMs: z.number().int().positive().default(15_000),
  /** Délai d'un appel d'outil. */
  requestTimeoutMs: z.number().int().positive().default(60_000),

  /** Reconnexion automatique après une chute. */
  autoReconnect: z.boolean().default(true),
  maxReconnectAttempts: z.number().int().min(0).default(5),
  reconnectInitialDelayMs: z.number().int().positive().default(500),
  reconnectMaxDelayMs: z.number().int().positive().default(30_000),
  /**
   * Nombre d'échecs consécutifs avant ouverture du circuit. Les outils du
   * serveur disparaissent alors du registre : un serveur défaillant ne doit pas
   * dégrader tout l'assistant.
   */
  circuitBreakerThreshold: z.number().int().min(1).default(5),
  circuitBreakerResetMs: z.number().int().positive().default(60_000),

  /** Expose aussi les ressources du serveur comme outils de lecture. */
  exposeResources: z.boolean().default(true),

  /** Politique de bac à sable conteneurisé (bwrap / docker / none). */
  sandbox: mcpSandboxPolicySchema.default(DEFAULT_MCP_SANDBOX_POLICY),
  /** Software Bill of Materials (SBOM) et provenance auditée. */
  sbom: mcpSbomSchema.optional(),
});

const stdioConfig = baseConfig.extend({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /**
   * Variables d'environnement du processus enfant.
   *
   * Rien n'est hérité du backend : un serveur MCP ne doit voir que ce qu'on lui
   * donne explicitement. Les valeurs sensibles arrivent par `envRefs`, résolues
   * au lancement depuis le coffre — elles ne sont ni stockées ici, ni
   * journalisées.
   */
  env: z.record(z.string(), z.string()).default({}),
  envRefs: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
});

const httpConfig = baseConfig.extend({
  transport: z.union([z.literal("http"), z.literal("sse")]),
  url: z.string().refine((value) => URL.canParse(value), "URL invalide"),
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
 * Valide une configuration brute (fichier, base, interface).
 * Une configuration invalide est refusée à l'entrée, jamais à l'usage.
 */
export function parseMcpServerConfig(input: unknown): McpServerConfig {
  return mcpServerConfigSchema.parse(input);
}

/**
 * Représentation sûre à journaliser.
 *
 * Les valeurs d'environnement et d'en-têtes sont remplacées par leurs seules
 * clés : savoir qu'une variable existe est utile au diagnostic, connaître sa
 * valeur ne l'est jamais.
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
