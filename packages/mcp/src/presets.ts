import { parseMcpServerConfig, type McpServerConfig } from "./config.js";

/**
 * Turnkey configurations for common MCP servers.
 *
 * Each preset establishes an explicit per-tool permission policy.
 */

export interface GithubPresetOptions {
  /** Vault secret reference for the token, never its literal value. */
  tokenRef: string;
  /** Enables write actions (issues, PRs, commits). */
  allowWrite?: boolean;
}

/**
 * Official GitHub MCP server.
 * Read actions are `SAFE`, write actions remain at default `MEDIUM` requiring confirmation.
 */
export function githubPreset(options: GithubPresetOptions): McpServerConfig {
  const readTools = [
    "search_repositories",
    "get_file_contents",
    "list_issues",
    "get_issue",
    "list_pull_requests",
    "get_pull_request",
  ];

  const writeTools = ["create_issue", "add_issue_comment", "create_pull_request", "create_branch"];

  return parseMcpServerConfig({
    name: "github",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envRefs: { GITHUB_PERSONAL_ACCESS_TOKEN: options.tokenRef },
    defaultPermissions: ["github.read"],
    defaultRisk: "MEDIUM",
    toolPolicies: {
      ...Object.fromEntries(
        readTools.map((name) => [name, { risk: "SAFE", permissions: ["github.read"] }]),
      ),
      ...Object.fromEntries(
        writeTools.map((name) => [
          name,
          options.allowWrite === true
            ? { risk: "MEDIUM", permissions: ["github.write"] }
            : { disabled: true },
        ]),
      ),
    },
  });
}

export interface FilesystemPresetOptions {
  /** Root directory paths the server has access to. */
  roots: string[];
  allowWrite?: boolean;
}

/**
 * Official filesystem MCP server.
 */
export function filesystemPreset(options: FilesystemPresetOptions): McpServerConfig {
  return parseMcpServerConfig({
    name: "filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", ...options.roots],
    defaultPermissions: ["filesystem.read"],
    defaultRisk: "MEDIUM",
    toolPolicies: {
      read_file: { risk: "SAFE", permissions: ["filesystem.read"] },
      read_multiple_files: { risk: "SAFE", permissions: ["filesystem.read"] },
      list_directory: { risk: "SAFE", permissions: ["filesystem.read"] },
      directory_tree: { risk: "SAFE", permissions: ["filesystem.read"] },
      search_files: { risk: "SAFE", permissions: ["filesystem.read"] },
      get_file_info: { risk: "SAFE", permissions: ["filesystem.read"] },
      write_file:
        options.allowWrite === true
          ? { risk: "MEDIUM", permissions: ["filesystem.write"] }
          : { disabled: true },
      edit_file:
        options.allowWrite === true
          ? { risk: "MEDIUM", permissions: ["filesystem.write"] }
          : { disabled: true },
      create_directory:
        options.allowWrite === true
          ? { risk: "LOW", permissions: ["filesystem.write"] }
          : { disabled: true },
      // File move/delete can be irreversible: higher risk level
      move_file: { risk: "HIGH", permissions: ["filesystem.write"] },
    },
  });
}
