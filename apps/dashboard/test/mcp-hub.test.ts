import { describe, expect, it } from "vitest";
import { MCP_PRESETS, isForbiddenRemoteUrl } from "../src/ui/sections/mcp.js";

describe("MCP Management Hub Contracts (Mission C)", () => {
  it("blocks dangerous local and metadata destinations via SSRF filter", () => {
    expect(isForbiddenRemoteUrl("http://localhost:8080")).toBe(true);
    expect(isForbiddenRemoteUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isForbiddenRemoteUrl("http://169.254.169.254/latest/meta-data")).toBe(true);
    expect(isForbiddenRemoteUrl("http://10.0.0.5:8000")).toBe(true);
    expect(isForbiddenRemoteUrl("http://192.168.1.254")).toBe(true);
    expect(isForbiddenRemoteUrl("http://172.16.0.10:9000")).toBe(true);
  });

  it("permits valid public remote MCP endpoints", () => {
    expect(isForbiddenRemoteUrl("https://api.github.com/mcp")).toBe(false);
    expect(isForbiddenRemoteUrl("https://mcp.company.internal.example.com")).toBe(false);
  });

  it("provides comprehensive one-click curated presets", () => {
    const names = MCP_PRESETS.map((p) => p.name);
    expect(names).toContain("filesystem");
    expect(names).toContain("memory-graph");
    expect(names).toContain("github");
    expect(names).toContain("postgres");
    expect(names).toContain("brave-search");
  });
});
