import type { McpServerConfig } from "./config.js";
import { parseMcpServerConfig } from "./config.js";

export interface McpOAuthProviderPreset {
  id: string;
  name: string;
  description: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  defaultScopes: string[];
  supportsPkce: boolean;
  package: string;
  command: string;
  args: string[];
  envTokenKey: string;
  secretName: string;
  vaultRef: string;
  icon: string;
  docUrl: string;
  createServerConfig: (vaultRef?: string) => McpServerConfig;
}

export const MCP_OAUTH_PRESETS: readonly McpOAuthProviderPreset[] = [
  {
    id: "github",
    name: "GitHub",
    description:
      "Access repositories, pull requests, issues, and code search with OAuth authentication.",
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    defaultScopes: ["repo", "read:user", "user:email"],
    supportsPkce: true,
    package: "@modelcontextprotocol/server-github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envTokenKey: "GITHUB_PERSONAL_ACCESS_TOKEN",
    secretName: "mcp-github-token",
    vaultRef: "vault://nexus/mcp-github-token",
    icon: "github",
    docUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    createServerConfig: (vaultRef = "vault://nexus/mcp-github-token") =>
      parseMcpServerConfig({
        name: "github",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        envRefs: { GITHUB_PERSONAL_ACCESS_TOKEN: vaultRef },
        defaultPermissions: ["github.read"],
        defaultRisk: "MEDIUM",
        toolPolicies: {
          search_repositories: { risk: "SAFE", permissions: ["github.read"] },
          get_file_contents: { risk: "SAFE", permissions: ["github.read"] },
          list_issues: { risk: "SAFE", permissions: ["github.read"] },
          get_issue: { risk: "SAFE", permissions: ["github.read"] },
          list_pull_requests: { risk: "SAFE", permissions: ["github.read"] },
          get_pull_request: { risk: "SAFE", permissions: ["github.read"] },
          create_issue: { risk: "MEDIUM", permissions: ["github.write"] },
          create_pull_request: { risk: "HIGH", permissions: ["github.write"] },
        },
      }),
  },
  {
    id: "slack",
    name: "Slack",
    description:
      "Collaborative channels, thread discussions, message posting, and automated notifications.",
    authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
    tokenEndpoint: "https://slack.com/api/oauth.v2.access",
    defaultScopes: ["channels:read", "channels:history", "chat:write", "users:read"],
    supportsPkce: true,
    package: "@modelcontextprotocol/server-slack",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    envTokenKey: "SLACK_BOT_TOKEN",
    secretName: "mcp-slack-token",
    vaultRef: "vault://nexus/mcp-slack-token",
    icon: "slack",
    docUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    createServerConfig: (vaultRef = "vault://nexus/mcp-slack-token") =>
      parseMcpServerConfig({
        name: "slack",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-slack"],
        envRefs: { SLACK_BOT_TOKEN: vaultRef },
        defaultPermissions: ["slack.read"],
        defaultRisk: "MEDIUM",
        toolPolicies: {
          list_channels: { risk: "SAFE", permissions: ["slack.read"] },
          get_channel_history: { risk: "SAFE", permissions: ["slack.read"] },
          post_message: { risk: "MEDIUM", permissions: ["slack.write"] },
        },
      }),
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Search documents, sheets, presentations, and team files in Google Workspace.",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    defaultScopes: ["https://www.googleapis.com/auth/drive.readonly"],
    supportsPkce: true,
    package: "@modelcontextprotocol/server-gdrive",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-gdrive"],
    envTokenKey: "GOOGLE_DRIVE_OAUTH_TOKEN",
    secretName: "mcp-gdrive-token",
    vaultRef: "vault://nexus/mcp-gdrive-token",
    icon: "google",
    docUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive",
    createServerConfig: (vaultRef = "vault://nexus/mcp-gdrive-token") =>
      parseMcpServerConfig({
        name: "google-drive",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-gdrive"],
        envRefs: { GOOGLE_DRIVE_OAUTH_TOKEN: vaultRef },
        defaultPermissions: ["google.read"],
        defaultRisk: "SAFE",
        toolPolicies: {
          search_files: { risk: "SAFE", permissions: ["google.read"] },
          read_file: { risk: "SAFE", permissions: ["google.read"] },
        },
      }),
  },
  {
    id: "linear",
    name: "Linear",
    description: "Track issues, manage sprints, synchronize tickets, and query project roadmaps.",
    authorizationEndpoint: "https://linear.app/oauth/authorize",
    tokenEndpoint: "https://api.linear.app/oauth/token",
    defaultScopes: ["read", "write", "issues:create"],
    supportsPkce: true,
    package: "mcp-server-linear",
    command: "npx",
    args: ["-y", "mcp-server-linear"],
    envTokenKey: "LINEAR_API_KEY",
    secretName: "mcp-linear-token",
    vaultRef: "vault://nexus/mcp-linear-token",
    icon: "linear",
    docUrl: "https://linear.app/docs/oauth",
    createServerConfig: (vaultRef = "vault://nexus/mcp-linear-token") =>
      parseMcpServerConfig({
        name: "linear",
        transport: "stdio",
        command: "npx",
        args: ["-y", "mcp-server-linear"],
        envRefs: { LINEAR_API_KEY: vaultRef },
        defaultPermissions: ["linear.read"],
        defaultRisk: "MEDIUM",
        toolPolicies: {
          list_issues: { risk: "SAFE", permissions: ["linear.read"] },
          get_issue: { risk: "SAFE", permissions: ["linear.read"] },
          create_issue: { risk: "MEDIUM", permissions: ["linear.write"] },
        },
      }),
  },
  {
    id: "notion",
    name: "Notion",
    description:
      "Connect documentation workspaces, team wikis, knowledge databases, and page trees.",
    authorizationEndpoint: "https://api.notion.com/v1/oauth/authorize",
    tokenEndpoint: "https://api.notion.com/v1/oauth/token",
    defaultScopes: [],
    supportsPkce: false,
    package: "@modelcontextprotocol/server-notion",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-notion"],
    envTokenKey: "NOTION_API_KEY",
    secretName: "mcp-notion-token",
    vaultRef: "vault://nexus/mcp-notion-token",
    icon: "notion",
    docUrl: "https://developers.notion.com/docs/authorization",
    createServerConfig: (vaultRef = "vault://nexus/mcp-notion-token") =>
      parseMcpServerConfig({
        name: "notion",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-notion"],
        envRefs: { NOTION_API_KEY: vaultRef },
        defaultPermissions: ["notion.read"],
        defaultRisk: "MEDIUM",
        toolPolicies: {
          search_by_title: { risk: "SAFE", permissions: ["notion.read"] },
          get_page: { risk: "SAFE", permissions: ["notion.read"] },
        },
      }),
  },
];

export function findMcpOAuthPreset(id: string): McpOAuthProviderPreset | undefined {
  return MCP_OAUTH_PRESETS.find((p) => p.id === id);
}
