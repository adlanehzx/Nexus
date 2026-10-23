import { describe, expect, it } from "vitest";
import {
  compileManifestToServerConfig,
  type McpManifestInput,
  validateManifest,
} from "../src/manifest.js";
import { McpSecurityError } from "../src/errors.js";

describe("MCP Manifest and Installation", () => {
  it("accepts valid third-party npm manifest and compiles to sandboxed config", () => {
    const manifest: McpManifestInput = {
      name: "custom-tool",
      version: "1.2.0",
      displayName: "Custom Tool",
      description: "A custom MCP server published on npm",
      runtime: "npm",
      package: "@custom/mcp-server",
      args: ["--mode", "safe"],
      provenance: {
        publisher: "Acme Corp",
        verified: true,
        license: "MIT",
        checksum: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      },
      declaredTools: [
        {
          name: "query",
          description: "Read queries",
          risk: "SAFE",
          permissions: ["custom.read"],
          requiresConfirmation: false,
        },
        {
          name: "mutate",
          description: "Write mutation",
          risk: "HIGH",
          permissions: ["custom.write"],
          requiresConfirmation: true,
        },
      ],
      secretRefs: {
        API_KEY: "vault:mcp:custom:key",
      },
    };

    const validated = validateManifest(manifest);
    expect(validated.name).toBe("custom-tool");

    const config = compileManifestToServerConfig(validated);
    expect(config.transport).toBe("stdio");
    if (config.transport === "stdio") {
      expect(config.command).toBe("npx");
      expect(config.args).toEqual(["-y", "@custom/mcp-server", "--mode", "safe"]);
      expect(config.envRefs).toEqual({ API_KEY: "vault:mcp:custom:key" });
      expect(config.sandbox.enabled).toBe(true);
      expect(config.sandbox.readOnlyRoot).toBe(true);
      expect(config.sandbox.allowNetwork).toBe(false);
      expect(config.sbom?.runtime).toBe("npm");
      expect(config.toolPolicies.query?.risk).toBe("SAFE");
      expect(config.toolPolicies.mutate?.risk).toBe("HIGH");
      expect(config.toolPolicies.mutate?.requiresConfirmation).toBe(true);
    }
  });

  it("accepts valid remote manifest and compiles to http config", () => {
    const manifest: McpManifestInput = {
      name: "remote-mcp",
      version: "1.0.0",
      displayName: "Remote MCP",
      description: "Remote cloud server",
      runtime: "remote",
      url: "https://remote.example.com/mcp",
      provenance: {
        publisher: "Cloud Provider",
        verified: true,
      },
      declaredTools: [
        {
          name: "cloud_search",
          risk: "SAFE",
          permissions: ["search.read"],
          requiresConfirmation: false,
        },
      ],
    };

    const config = compileManifestToServerConfig(manifest);
    expect(config.transport).toBe("http");
    if (config.transport === "http") {
      expect(config.url).toBe("https://remote.example.com/mcp");
      expect(config.toolPolicies.cloud_search?.risk).toBe("SAFE");
    }
  });

  it("rejects unsupported runtimes and invalid manifest combinations", () => {
    // Unsupported runtime
    expect(() =>
      validateManifest({
        name: "shell-mcp",
        displayName: "Shell",
        description: "Dangerous",
        runtime: "bash",
        provenance: { publisher: "attacker" },
      }),
    ).toThrow();

    // npm runtime missing package
    expect(() =>
      validateManifest({
        name: "bad-npm",
        displayName: "Bad",
        description: "Missing package",
        runtime: "npm",
        provenance: { publisher: "test" },
      }),
    ).toThrow(McpSecurityError);

    // npm runtime with remote url
    expect(() =>
      validateManifest({
        name: "bad-mix",
        displayName: "Mix",
        description: "Confusing",
        runtime: "npm",
        package: "some-pkg",
        url: "https://evil.com",
        provenance: { publisher: "test" },
      }),
    ).toThrow(McpSecurityError);

    // remote runtime missing url
    expect(() =>
      validateManifest({
        name: "bad-remote",
        displayName: "Bad Remote",
        description: "No URL",
        runtime: "remote",
        provenance: { publisher: "test" },
      }),
    ).toThrow(McpSecurityError);
  });
});
