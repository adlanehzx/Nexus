export const MCP_PRESETS = [
  {
    name: "filesystem",
    label: "Filesystem",
    description: "Read & write access to workspace files",
    transport: "stdio" as const,
    target: "npx",
    args: "-y\n@modelcontextprotocol/server-filesystem\n/workspace",
    secretRefs: "",
  },
  {
    name: "memory-graph",
    label: "Memory Graph",
    description: "Knowledge graph persistent memory",
    transport: "stdio" as const,
    target: "npx",
    args: "-y\n@modelcontextprotocol/server-memory",
    secretRefs: "",
  },
  {
    name: "github",
    label: "GitHub",
    description: "Repositories, issues, and PR management",
    transport: "stdio" as const,
    target: "npx",
    args: "-y\n@modelcontextprotocol/server-github",
    secretRefs: '{"GITHUB_PERSONAL_ACCESS_TOKEN":"vault://nexus/github-pat"}',
  },
  {
    name: "postgres",
    label: "PostgreSQL",
    description: "Read-only schema queries",
    transport: "stdio" as const,
    target: "npx",
    args: "-y\n@modelcontextprotocol/server-postgres\npostgresql://user:pass@localhost:5432/db",
    secretRefs: "",
  },
  {
    name: "brave-search",
    label: "Brave Search",
    description: "Web and entity search API",
    transport: "stdio" as const,
    target: "npx",
    args: "-y\n@modelcontextprotocol/server-brave-search",
    secretRefs: '{"BRAVE_API_KEY":"vault://nexus/brave-key"}',
  },
] as const;

export function isForbiddenRemoteUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "169.254.169.254" ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
    );
  } catch {
    return false;
  }
}
