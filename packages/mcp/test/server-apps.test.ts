import { describe, it, expect } from "vitest";
import {
  NexusMcpServer,
  McpAppEngine,
  McpSecurityError,
  type McpSecurityContext,
} from "../src/index.js";

describe("NEXUS MCP Platform Architecture (LOT G)", () => {
  describe("NexusMcpServer with Scoped RBAC", () => {
    it("filters available tools based on token scopes", () => {
      const server = new NexusMcpServer();

      const readContext: McpSecurityContext = {
        token: "tok-read-only",
        organizationId: "org-1",
        scopes: ["missions:read", "metrics:read"],
      };
      server.registerClientToken(readContext);

      const tools = server.listTools("tok-read-only");
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain("nexus_list_missions");
      expect(toolNames).toContain("nexus_get_usage_metrics");
      expect(toolNames).not.toContain("nexus_trigger_mission");
      expect(toolNames).not.toContain("nexus_list_devices");
    });

    it("executes permitted tools and denies unauthorized operations", async () => {
      const server = new NexusMcpServer();

      server.registerClientToken({
        token: "tok-admin",
        organizationId: "org-admin",
        scopes: ["*"],
      });

      server.registerClientToken({
        token: "tok-metrics-only",
        organizationId: "org-analytics",
        scopes: ["metrics:read"],
      });

      // Admin can trigger mission
      const adminResult = await server.executeTool("tok-admin", "nexus_trigger_mission", {
        goal: "Deploy staging canary",
      });
      expect(adminResult.isError).toBeUndefined();
      expect(adminResult.content[0]?.text).toContain("Deploy staging canary");

      // Metrics token is blocked from triggering mission
      await expect(
        server.executeTool("tok-metrics-only", "nexus_trigger_mission", {
          goal: "Unauthorized trigger",
        }),
      ).rejects.toThrow(McpSecurityError);
    });

    it("rejects unregistered or tampered tokens", () => {
      const server = new NexusMcpServer();

      expect(() => {
        server.listTools("invalid-token-xyz");
      }).toThrow(McpSecurityError);
    });
  });

  describe("MCP Apps Engine & Sandboxing", () => {
    it("generates strict Content-Security-Policy and sandbox directives for app UI frames", () => {
      const engine = new McpAppEngine();

      const frame = engine.renderAppFrame({
        appId: "app-postgres-explorer",
        name: "PostgreSQL Schema Explorer",
        version: "1.0.0",
        entryHtml: "<html><body><h1>Database Schema</h1></body></html>",
        permissions: ["storage:read"],
      });

      expect(frame.appId).toBe("app-postgres-explorer");
      expect(frame.sanitizedHtml).toContain("Database Schema");
      expect(frame.sandboxAttributes).toContain("allow-scripts");
      expect(frame.contentSecurityPolicy).toContain("base-uri 'none'");
      expect(frame.contentSecurityPolicy).toContain("object-src 'none'");
    });

    it("sanitizes dangerous HTML tags and rejects dangerous CSP overrides (SEC-06)", () => {
      const engine = new McpAppEngine();

      const frame = engine.renderAppFrame({
        appId: "app-malicious-frame",
        name: "Untrusted App",
        version: "1.0.0",
        entryHtml: `
          <html>
            <head>
              <base href="https://attacker.example/">
              <meta http-equiv="refresh" content="0;url=https://attacker.example/">
            </head>
            <body>
              <iframe src="https://phishing.example/"></iframe>
              <object data="evil.swf"></object>
              <embed src="evil.pdf">
              <p>Safe content</p>
            </body>
          </html>
        `,
        cspPolicies: [
          "default-src *; object-src *",
          "script-src https://cdn.example.com",
        ],
        permissions: [],
      });

      expect(frame.sanitizedHtml).not.toContain("<base");
      expect(frame.sanitizedHtml).not.toContain("<meta");
      expect(frame.sanitizedHtml).not.toContain("<iframe");
      expect(frame.sanitizedHtml).not.toContain("<object");
      expect(frame.sanitizedHtml).not.toContain("<embed");
      expect(frame.sanitizedHtml).toContain("<p>Safe content</p>");

      // Verify default-src and object-src overrides were rejected
      expect(frame.contentSecurityPolicy).toContain("object-src 'none'");
      expect(frame.contentSecurityPolicy).toContain("script-src https://cdn.example.com");
      expect(frame.contentSecurityPolicy).not.toContain("object-src *");
    });
  });
});
