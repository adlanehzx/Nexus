import { parseMcpServerConfig, type McpServerConfig } from "./config.js";

/**
 * Configurations prêtes à l'emploi pour des serveurs MCP répandus.
 *
 * Elles ne sont qu'un point de départ **explicite** : chaque preset fixe une
 * politique de permission par outil, parce que le défaut sûr (`MEDIUM`, donc
 * confirmation à chaque appel) rend un serveur riche inutilisable au quotidien.
 * Abaisser le risque d'un outil est ici une décision humaine, écrite, relisible
 * — jamais une déduction faite à partir de ce que le serveur déclare de lui-même.
 */

export interface GithubPresetOptions {
  /** Référence du jeton dans le coffre, jamais sa valeur. */
  tokenRef: string;
  /** Autorise les écritures (issues, PR, commits). */
  allowWrite?: boolean;
}

/**
 * Serveur MCP GitHub officiel.
 *
 * Lecture en `SAFE`, écriture laissée au défaut `MEDIUM` — donc confirmée.
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
  /** Racines auxquelles le serveur a accès. Il n'en sort pas. */
  roots: string[];
  allowWrite?: boolean;
}

/**
 * Serveur MCP filesystem officiel.
 *
 * Le cloisonnement des chemins est assuré par le serveur lui-même, via ses
 * arguments : c'est plus sûr que de filtrer côté client, puisqu'il ne peut
 * physiquement pas répondre en dehors de ses racines.
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
      // Une suppression est irréversible : confirmation renforcée, toujours.
      move_file: { risk: "HIGH", permissions: ["filesystem.write"] },
    },
  });
}
