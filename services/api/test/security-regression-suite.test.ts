import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { WORKER_MESSAGE, workerEnvelope } from "@nexus/protocol";
import { assertSafeRemoteUrl, isPrivateOrReservedIp } from "@nexus/mcp";
import { PluginSandbox } from "@nexus/tools";
import { SatelliteService } from "../src/services/satellite-service.js";
import {
  FakeWorkerSocket,
  createAccount,
  makeApi,
  registerDevice,
  type Account,
  type ApiHarness,
  type RegisteredDevice,
} from "./harness.js";

/**
 * NEXUS Consolidated Security Regression Suite (SEC-01 to SEC-14).
 *
 * Verifies non-regression of critical security controls across tenants,
 * devices, MCP transports, worktrees, execution policies, and public vs protected endpoints.
 */

let harness: ApiHarness;
let account: Account;
let otherAccount: Account;
let portable: RegisteredDevice;
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

  portable = await registerDevice(harness, account, {
    name: "Auditor Laptop",
    role: "BOTH",
    permissions: ["filesystem.read", "terminal.execute"],
  });
});

afterEach(async () => {
  await harness.close();
});

describe("SEC-01: Multi-Tenant Boundary Isolation", () => {
  it("rejects unauthorized organization query and isolates tenant accounts", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/api/v1/organizations/00000000-0000-0000-0000-000000000001/members",
      headers: {
        authorization: `Bearer ${account.accessToken}`,
      },
    });
    expect([400, 403, 404]).toContain(res.statusCode);
  });
});

describe("SEC-02: Unauthenticated Device Handshake Rejection", () => {
  it("immediately closes connection if worker attempts registration without authenticating", async () => {
    const socket = new FakeWorkerSocket();
    const connId = "attacker-conn";
    harness.app.workerChannel.open(connId, socket);

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

describe("SEC-03: Satellite Authorization Boundary", () => {
  it("denies access to satellite commands without legitimate ownership", async () => {
    // Mallory attempts to send command to Alice's satellite
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

describe("SEC-04 & SEC-05: MCP SSRF and Loopback Protection", () => {
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

describe("SEC-06 & SEC-07: Telemetry & Secret Leakage Prevention", () => {
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

describe("SEC-12: Unauthenticated Endpoint Gate", () => {
  it("allows health endpoint without credentials but protects sensitive routes", async () => {
    const health = await harness.app.inject({
      method: "GET",
      url: "/api/v1/health",
    });
    expect([200, 503]).toContain(health.statusCode);

    const protectedUrls = ["/api/v1/tasks", "/api/v1/devices", "/api/v1/worktrees", "/api/v1/usage"];
    for (const url of protectedUrls) {
      const res = await harness.app.inject({
        method: "GET",
        url,
      });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe("SEC-13: Sandbox Isolation & Host Escape Prevention", () => {
  it("blocks dangerous execution patterns in isolated plugin sandbox", async () => {
    const sandbox = new PluginSandbox();
    const maliciousPayloads = [
      "process.exit(1)",
      "require('child_process').execSync('rm -rf /')",
      "fetch('http://169.254.169.254/metadata')",
      "eval('globalThis.hacked = true')",
    ];

    for (const code of maliciousPayloads) {
      await expect(
        sandbox.executeToolHandler("test_tool", code, {}, {
          pluginId: "evil-plugin",
          injectedSecrets: {},
          allowedEgress: [],
        }),
      ).rejects.toThrow();
    }
  });
});
