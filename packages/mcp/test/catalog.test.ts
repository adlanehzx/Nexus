import { describe, expect, it } from "vitest";
import {
  findCatalogManifest,
  installCatalogServer,
  installManifestServer,
  listMcpCatalog,
} from "../src/catalog.js";
import { McpSecurityError } from "../src/errors.js";

describe("MCP Curated Catalog", () => {
  it("lists curated catalog entries with provenance", () => {
    const catalog = listMcpCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(4);
    const names = catalog.map((c) => c.name);
    expect(names).toContain("github");
    expect(names).toContain("filesystem");
    expect(names).toContain("memory");
    expect(names).toContain("brave-search");

    const github = findCatalogManifest("github");
    expect(github).toBeDefined();
    expect(github?.runtime).toBe("npm");
    expect(github?.provenance.verified).toBe(true);
    expect(github?.package).toBe("@modelcontextprotocol/server-github");
  });

  it("installs server from catalog with parameters and secret overrides", () => {
    const config = installCatalogServer("github", {
      secretRefs: {
        GITHUB_PERSONAL_ACCESS_TOKEN: "vault:custom:github:token",
      },
    });

    expect(config.name).toBe("github");
    expect(config.transport).toBe("stdio");
    if (config.transport === "stdio") {
      expect(config.command).toBe("npx");
      expect(config.args).toContain("@modelcontextprotocol/server-github");
      expect(config.envRefs.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("vault:custom:github:token");
      expect(config.toolPolicies.search_repositories?.risk).toBe("SAFE");
      expect(config.toolPolicies.create_issue?.risk).toBe("MEDIUM");
    }
  });

  it("throws McpSecurityError when installing uncatalogued server", () => {
    expect(() => installCatalogServer("unknown-random-server")).toThrow(McpSecurityError);
  });

  it("installs valid third-party manifest via installManifestServer", () => {
    const config = installManifestServer({
      name: "third-party",
      displayName: "Third Party",
      description: "Custom server",
      runtime: "npm",
      package: "@org/custom-server",
      provenance: { publisher: "trusted-org", verified: true },
    });

    expect(config.name).toBe("third-party");
    expect(config.transport).toBe("stdio");
  });
});
