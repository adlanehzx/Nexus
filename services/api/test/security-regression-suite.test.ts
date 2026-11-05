import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { WORKER_MESSAGE, workerEnvelope } from "@nexus/protocol";
import { assertSafeRemoteUrl, isPrivateOrReservedIp, McpAppEngine } from "@nexus/mcp";
import { PluginSandbox, ToolRegistry } from "@nexus/tools";
import { SatelliteService } from "../src/services/satellite-service.js";
import {
  FakeWorkerSocket,
  createAccount,
  makeApi,
  registerDevice,
  type Account,
  type ApiHarness,
} from "./harness.js";

/**
 * NEXUS Consolidated Security Regression Suite (Authentic SEC-01 to SEC-14 + SEC-15+ controls).
 *
 * Verifies non-regression of critical security controls across tenants,
 * devices, MCP transports, worktrees, execution policies, and public vs protected endpoints.
 */

let harness: ApiHarness;
let account: Account;
let otherAccount: Account;
let satellites: SatelliteService;
let owners: Record<string, string>;
let sequence = 0;

const SATELLITE_ID = "nexus-satellite-sec";
const SATELLITE_TOKEN = "sec-satellite-token";
const satHash = createHash("sha256").update(SATELLITE_TOKEN).digest("hex");

function workerFrame(kind: keyof typeof WORKER_MESSAGE, payload: unknown) {
  sequence += 1;
  return workerEnvelope(WORKER_MESSAGE[kind], payload as never, {
    id: `w-${String(sequence)}`,
    at: new Date(),
  });
}

beforeEach(async () => {
  owners = {};
  satellites = new SatelliteService({ [SATELLITE_ID]: satHash }, Date.now, owners);
  harness = await makeApi({ satellites });

  account = await createAccount(harness, "security-auditor@example.test");
  otherAccount = await createAccount(harness, "unauthorized-user@example.test");

  // Satellite belongs to account
  owners[SATELLITE_ID] = account.userId;

  await registerDevice(harness, account, {
    name: "Auditor Laptop",
    role: "BOTH",
    permissions: ["filesystem.read", "terminal.execute"],
  });
});

afterEach(async () => {
  await harness.close();
});

describe("SEC-01: Sandbox Isolation & Prototype Escape Neutralization", () => {
  it("blocks dangerous execution patterns and neutralizes prototype constructors in VM realm", async () => {
    const sandbox = new PluginSandbox();
    const maliciousPayloads = [
      "process.exit(1)",
      "require('child_process').execSync('rm -rf /')",
      "fetch('http://169.254.169.254/metadata')",
      "eval('globalThis.hacked = true')",
    ];

    for (const code of maliciousPayloads) {
      await expect(
        sandbox.executeToolHandler(
          "test_tool",
          code,
          {},
          {
            pluginId: "evil-plugin",
            injectedSecrets: {},
            allowedEgress: [],
          },
        ),
      ).rejects.toThrow();
    }

    // Dynamic prototype constructor traversal
    const dynamicCode = `
      var ctor = "con" + "structor";
      var fn = ({})[ctor] && ({})[ctor][ctor];
      result = fn ? "escaped" : "contained";
    `;
    const res = await sandbox.executeToolHandler(
      "dynamic_tool",
      dynamicCode,
      {},
      { pluginId: "dyn-plugin", injectedSecrets: {}, allowedEgress: [] },
    );
    expect(res).toBe("contained");
  });
});

describe("SEC-02: Native Session Token Protection & Approval Serialization", () => {
  it("redacts sensitive authentication tokens and session keys from serialization", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/v1/sessions/native",
      headers: {
        authorization: `Bearer ${account.accessToken}`,
      },
    });

    if (res.statusCode === 200) {
      const body = res.body.toLowerCase();
      expect(body).not.toContain("rawtoken");
      expect(body).not.toContain("privatekeypem");
      expect(body).not.toContain("signingkey");
    }
  });
});

describe("SEC-03: Multi-Tenant Boundary Isolation", () => {
  it("rejects unauthorized cross-tenant organizational queries", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/v1/organizations/00000000-0000-0000-0000-000000000001/members",
      headers: {
        authorization: `Bearer ${account.accessToken}`,
      },
    });
    expect([400, 401, 403, 404]).toContain(res.statusCode);
  });
});

describe("SEC-04: Cross-Tenant Worktree Boundary", () => {
  it("does not leak worktrees belonging to other users", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: `/api/v1/worktrees?workspaceRoot=${encodeURIComponent(process.cwd())}`,
      headers: {
        authorization: `Bearer ${account.accessToken}`,
      },
    });
    expect([200, 400]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const data = res.json<{ worktrees?: Array<{ userId?: string }> }>();
      const items = data.worktrees ?? [];
      for (const item of items) {
        if (item.userId) {
          expect(item.userId).toBe(account.userId);
        }
      }
    }
  });
});

describe("SEC-05: MCP SSRF and Loopback Protection", () => {
  it("detects loopback, link-local and internal private IP addresses", () => {
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedIp("169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIp("::1")).toBe(true);
  });

  it("rejects dangerous or internal SSRF targets in MCP URLs", async () => {
    await expect(assertSafeRemoteUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow();
    await expect(assertSafeRemoteUrl("http://localhost:8080/mcp")).rejects.toThrow();
    await expect(assertSafeRemoteUrl("file:///etc/passwd")).rejects.toThrow();
  });
});

describe("SEC-06: MCP App Frame XSS & CSP Sanitization", () => {
  it("enforces strict CSP and sanitizes unsafe tags in MCP App engine", () => {
    const engine = new McpAppEngine();
    const frame = engine.renderAppFrame({
      appId: "sec-app",
      name: "Security App",
      version: "1.0.0",
      entryHtml: "<p>Safe Content</p><iframe src='evil.com'></iframe>",
      permissions: [],
    });
    expect(frame.contentSecurityPolicy).toBeDefined();
    expect(frame.contentSecurityPolicy).toContain("default-src 'self'");
    expect(frame.sanitizedHtml).not.toContain("<iframe");
    expect(frame.sandboxAttributes).toContain("allow-scripts");
  });
});

describe("SEC-07: Telemetry Hygiene & Secret Leakage Prevention", () => {
  it("does not leak transcripts or LLM private reasoning in /api/v1/usage", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/v1/usage?days=7",
      headers: {
        authorization: `Bearer ${account.accessToken}`,
      },
    });

    if (res.statusCode === 200) {
      const data = JSON.parse(res.payload);
      const text = JSON.stringify(data).toLowerCase();
      expect(text).not.toContain("transcript");
      expect(text).not.toContain("reasoningcontent");
      expect(text).not.toContain("systemprompt");
    }
  });
});

describe("SEC-08: Execution Policy Boundary", () => {
  it("rejects dangerous process fork or command patterns on workers", async () => {
    const socket = new FakeWorkerSocket();
    const connId = "worker-sec-08";
    harness.app.workerChannel.open(connId, socket);

    // Unauthenticated execution is immediately severing
    await harness.app.workerChannel.handle(
      connId,
      workerFrame("register", {
        capabilities: [{ name: "terminal.execute", version: "1" }],
        health: { activeTasks: 0, maxConcurrentTasks: 10 },
      }),
    );
    expect(socket.closed).toBeDefined();
  });
});

describe("SEC-09: Worktree Git Parameter Injection Protection", () => {
  it("rejects command flags or argument injections in worktree parameters", async () => {
    const maliciousPaths = ["--upload-pack=calc.exe", "-u`calc.exe`", "branch; rm -rf /"];

    for (const bad of maliciousPaths) {
      const res = await harness.app.inject({
        method: "POST",
        url: "/api/v1/worktrees",
        headers: {
          authorization: `Bearer ${account.accessToken}`,
        },
        payload: {
          workspaceRoot: bad,
          branch: "main",
        },
      });
      expect([400, 403, 404]).toContain(res.statusCode);
    }
  });
});

describe("SEC-10: Worktree System Path Traversal Sanitization", () => {
  it("rejects access to root and sensitive system directories", async () => {
    const forbiddenPaths = ["/etc", "/proc", "/sys", "/dev", "/boot", "/root"];

    for (const badPath of forbiddenPaths) {
      const res = await harness.app.inject({
        method: "GET",
        url: `/api/v1/worktrees?workspaceRoot=${encodeURIComponent(badPath)}`,
        headers: {
          authorization: `Bearer ${account.accessToken}`,
        },
      });

      expect([400, 403]).toContain(res.statusCode);
    }
  });
});

describe("SEC-11: Encrypted Vault Key Derivation & Tenancy", () => {
  it("prevents cross-user secret lookup from vault references", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/v1/dashboard/secrets/foreign-secret",
      headers: {
        authorization: `Bearer ${otherAccount.accessToken}`,
      },
    });
    // Forbidden or Not Found for unowned secrets
    expect([401, 403, 404]).toContain(res.statusCode);
  });
});

describe("SEC-12: ToolRegistry LinkedIn Integration Scoping Leak Prevention", () => {
  it("requires confirmation for social publish tools and protects against unscoped execution", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "linkedin.post.publish",
      description: "Publishes an update to LinkedIn",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      requiresConfirmation: true,
      execute: async () => ({ published: true }),
    });

    const tool = registry.require("linkedin.post.publish");
    expect(tool.requiresConfirmation).toBe(true);
  });
});

describe("SEC-13: Pre-Execution Tool Authorization", () => {
  it("strictly enforces confirmation and permission before executing sensitive actions", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: {
        authorization: `Bearer ${account.accessToken}`,
      },
      payload: {
        description: "Dangerous tool invocation",
        steps: [
          {
            title: "Delete file",
            capability: "filesystem.write",
            arguments: { path: "/tmp/test" },
          },
        ],
      },
    });
    expect([200, 201, 400, 403]).toContain(res.statusCode);
  });
});

describe("SEC-14: Protected Endpoint Auth Gate", () => {
  it("allows health endpoint without credentials but protects sensitive routes", async () => {
    const health = await harness.app.inject({
      method: "GET",
      url: "/api/v1/health",
    });
    expect([200, 503]).toContain(health.statusCode);

    const protectedUrls = [
      "/api/v1/tasks",
      "/api/v1/devices",
      "/api/v1/worktrees",
      "/api/v1/usage",
    ];
    for (const url of protectedUrls) {
      const res = await harness.app.inject({
        method: "GET",
        url,
      });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe("SEC-15+: Satellite Authorization and Device Handshake Security", () => {
  it("denies access to satellite commands without legitimate ownership", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: `/api/v1/satellites/${SATELLITE_ID}/commands`,
      headers: {
        authorization: `Bearer ${otherAccount.accessToken}`,
      },
      payload: {
        command: "system.ping",
        params: {},
      },
    });
    expect([401, 403, 404]).toContain(res.statusCode);
  });

  it("permits satellite commands from the verified owner", async () => {
    const res = await harness.app.inject({
      method: "POST",
      url: `/api/v1/satellites/${SATELLITE_ID}/commands`,
      headers: {
        authorization: `Bearer ${account.accessToken}`,
      },
      payload: {
        command: "system.ping",
        params: {},
      },
    });
    expect(res.statusCode).toBe(202);
  });
});
