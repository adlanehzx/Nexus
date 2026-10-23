import type { McpServerConfig } from "./config.js";
import { type McpManifest, compileManifestToServerConfig, validateManifest } from "./manifest.js";
import { McpSecurityError } from "./errors.js";

/**
 * Curated catalog of standard official MCP servers.
 * Provenance is established and verified.
 */
export const MCP_CATALOG: readonly McpManifest[] = [
  validateManifest({
    name: "github",
    version: "0.6.2",
    displayName: "GitHub",
    description: "Official GitHub Model Context Protocol server for repositories, issues, and PRs.",
    runtime: "npm",
    package: "@modelcontextprotocol/server-github",
    args: [],
    provenance: {
      publisher: "Model Context Protocol",
      verified: true,
      repository: "https://github.com/modelcontextprotocol/servers",
      license: "MIT",
    },
    defaultPermissions: ["github.read"],
    defaultRisk: "MEDIUM",
    declaredTools: [
      {
        name: "search_repositories",
        risk: "SAFE",
        permissions: ["github.read"],
        requiresConfirmation: false,
      },
      {
        name: "get_file_contents",
        risk: "SAFE",
        permissions: ["github.read"],
        requiresConfirmation: false,
      },
      {
        name: "list_issues",
        risk: "SAFE",
        permissions: ["github.read"],
        requiresConfirmation: false,
      },
      {
        name: "get_issue",
        risk: "SAFE",
        permissions: ["github.read"],
        requiresConfirmation: false,
      },
      {
        name: "create_issue",
        risk: "MEDIUM",
        permissions: ["github.write"],
        requiresConfirmation: true,
      },
      {
        name: "create_pull_request",
        risk: "HIGH",
        permissions: ["github.write"],
        requiresConfirmation: true,
      },
    ],
    secretRefs: {
      GITHUB_PERSONAL_ACCESS_TOKEN: "vault:mcp:github:token",
    },
  }),
  validateManifest({
    name: "filesystem",
    version: "0.6.2",
    displayName: "Filesystem",
    description: "Official Model Context Protocol filesystem server with sandboxed folder access.",
    runtime: "npm",
    package: "@modelcontextprotocol/server-filesystem",
    args: [],
    provenance: {
      publisher: "Model Context Protocol",
      verified: true,
      repository: "https://github.com/modelcontextprotocol/servers",
      license: "MIT",
    },
    defaultPermissions: ["filesystem.read"],
    defaultRisk: "MEDIUM",
    declaredTools: [
      {
        name: "read_file",
        risk: "SAFE",
        permissions: ["filesystem.read"],
        requiresConfirmation: false,
      },
      {
        name: "list_directory",
        risk: "SAFE",
        permissions: ["filesystem.read"],
        requiresConfirmation: false,
      },
      {
        name: "write_file",
        risk: "MEDIUM",
        permissions: ["filesystem.write"],
        requiresConfirmation: true,
      },
      {
        name: "edit_file",
        risk: "MEDIUM",
        permissions: ["filesystem.write"],
        requiresConfirmation: true,
      },
    ],
    secretRefs: {},
  }),
  validateManifest({
    name: "memory",
    version: "0.6.2",
    displayName: "Knowledge Graph Memory",
    description: "Local knowledge graph memory server using SQLite.",
    runtime: "npm",
    package: "@modelcontextprotocol/server-memory",
    args: [],
    provenance: {
      publisher: "Model Context Protocol",
      verified: true,
      repository: "https://github.com/modelcontextprotocol/servers",
      license: "MIT",
    },
    defaultPermissions: ["memory.read"],
    defaultRisk: "LOW",
    declaredTools: [
      {
        name: "create_entities",
        risk: "LOW",
        permissions: ["memory.write"],
        requiresConfirmation: false,
      },
      {
        name: "read_graph",
        risk: "SAFE",
        permissions: ["memory.read"],
        requiresConfirmation: false,
      },
      {
        name: "search_nodes",
        risk: "SAFE",
        permissions: ["memory.read"],
        requiresConfirmation: false,
      },
    ],
    secretRefs: {},
  }),
  validateManifest({
    name: "brave-search",
    version: "0.6.2",
    displayName: "Brave Web Search",
    description: "Brave Search API integration via MCP.",
    runtime: "npm",
    package: "@modelcontextprotocol/server-brave-search",
    args: [],
    provenance: {
      publisher: "Model Context Protocol",
      verified: true,
      repository: "https://github.com/modelcontextprotocol/servers",
      license: "MIT",
    },
    defaultPermissions: ["search.web"],
    defaultRisk: "LOW",
    declaredTools: [
      {
        name: "brave_web_search",
        risk: "SAFE",
        permissions: ["search.web"],
        requiresConfirmation: false,
      },
      {
        name: "brave_local_search",
        risk: "SAFE",
        permissions: ["search.web"],
        requiresConfirmation: false,
      },
    ],
    secretRefs: {
      BRAVE_API_KEY: "vault:mcp:brave-search:key",
    },
  }),
];

/**
 * Returns the immutable list of catalog manifests.
 */
export function listMcpCatalog(): readonly McpManifest[] {
  return MCP_CATALOG;
}

/**
 * Finds a catalog manifest by its server name.
 */
export function findCatalogManifest(name: string): McpManifest | undefined {
  return MCP_CATALOG.find((entry) => entry.name === name);
}

export interface CatalogInstallOptions {
  secretRefs?: Record<string, string>;
  args?: string[];
  allowedBinaries?: string[];
}

/**
 * Installs a server from the curated catalog.
 */
export function installCatalogServer(
  name: string,
  options?: CatalogInstallOptions,
): McpServerConfig {
  const manifest = findCatalogManifest(name);
  if (!manifest) {
    throw new McpSecurityError(name, `Server "${name}" is not in the curated MCP catalog.`);
  }

  const mergedManifest: McpManifest = {
    ...manifest,
    args: options?.args ? [...manifest.args, ...options.args] : manifest.args,
    secretRefs: { ...manifest.secretRefs, ...options?.secretRefs },
  };

  return compileManifestToServerConfig(mergedManifest, {
    ...(options?.allowedBinaries !== undefined ? { allowedBinaries: options.allowedBinaries } : {}),
  });
}

/**
 * Installs a third-party server by structured manifest.
 */
export function installManifestServer(
  manifest: unknown,
  options?: CatalogInstallOptions,
): McpServerConfig {
  const validated = validateManifest(manifest);
  return compileManifestToServerConfig(validated, options);
}
