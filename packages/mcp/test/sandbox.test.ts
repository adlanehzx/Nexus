import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseMcpServerConfig } from "../src/config.js";
import { McpSecurityError } from "../src/errors.js";
import {
  McpSandboxManager,
  generateSbom,
  probeHostSandboxCapabilities,
  validateBinary,
  verifyPackageChecksum,
} from "../src/sandbox.js";

const execFileAsync = promisify(execFile);

/**
 * Bubblewrap may be installed while the host kernel still denies unprivileged
 * user namespaces (for example on GitHub-hosted runners). Probe the actual
 * capability so the live integration test runs wherever isolation is usable;
 * argument-generation tests remain mandatory on every host.
 */
function canCreateBubblewrapSandbox(): boolean {
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--", "true"], {
    stdio: "ignore",
    timeout: 5_000,
  });
  return probe.status === 0;
}

describe("MCP Isolation and Security", () => {
  it("validates allowed binaries and rejects unauthorized commands", () => {
    const allowed = ["node", "python3", "uv", "uvx", "docker"];
    expect(validateBinary("node", allowed)).toBe(true);
    expect(validateBinary("/usr/bin/node", allowed)).toBe(true);
    expect(validateBinary("python3", allowed)).toBe(true);
    expect(validateBinary("/bin/bash", allowed)).toBe(false);
    expect(validateBinary("/tmp/malicious-binary", allowed)).toBe(false);
    expect(validateBinary("curl", allowed)).toBe(false);
  });

  it("generates hardened bwrap arguments (ro-root, tmpfs, unshare-net, mounts)", async () => {
    const config = parseMcpServerConfig({
      name: "safe-mcp",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      sandbox: {
        enabled: true,
        engine: "bwrap",
        readOnlyRoot: true,
        allowNetwork: false,
        bindMounts: [
          { hostPath: "/var/data", readOnly: true },
          { hostPath: "/var/output", containerPath: "/out", readOnly: false },
        ],
      },
    });

    if (config.transport !== "stdio") throw new Error("Must be stdio");

    const prepared = await McpSandboxManager.prepareStdio(config, {
      SECRET_TOKEN: "shh-secret",
    });

    expect(prepared.command).toBe("bwrap");
    expect(prepared.args).toContain("--ro-bind");
    expect(prepared.args).toContain("/");
    expect(prepared.args).toContain("--dev");
    expect(prepared.args).toContain("/dev");
    expect(prepared.args).toContain("--proc");
    expect(prepared.args).toContain("/proc");
    expect(prepared.args).toContain("--tmpfs");
    expect(prepared.args).toContain("/tmp");
    expect(prepared.args).toContain("--unshare-net");
    expect(prepared.args).toContain("--unshare-pid");
    expect(prepared.args).toContain("--clearenv");
    expect(prepared.args).toContain("--setenv");
    expect(prepared.args).toContain("SECRET_TOKEN");
    expect(prepared.args).toContain("shh-secret");
    expect(prepared.args.at(-2)).toBe("node");
    expect(prepared.args.at(-1)).toBe("server.js");
  });

  it("generates Docker options with resource limits and network isolation", async () => {
    const config = parseMcpServerConfig({
      name: "docker-mcp",
      transport: "stdio",
      command: "docker",
      args: ["run-tool"],
      sandbox: {
        enabled: true,
        engine: "docker",
        readOnlyRoot: true,
        allowNetwork: false,
        resourceLimits: {
          maxMemoryMb: 256,
          maxPids: 32,
          cpuShares: 512,
        },
      },
    });

    if (config.transport !== "stdio") throw new Error("Must be stdio");

    const prepared = await McpSandboxManager.prepareStdio(config, {
      API_KEY: "secret-key",
    });

    expect(prepared.command).toBe("docker");
    expect(prepared.args).toContain("--read-only");
    expect(prepared.args).toContain("--network");
    expect(prepared.args).toContain("none");
    expect(prepared.args).toContain("--memory");
    expect(prepared.args).toContain("256m");
    expect(prepared.args).toContain("--pids-limit");
    expect(prepared.args).toContain("32");
    expect(prepared.args).toContain("-e");
    expect(prepared.args).toContain("API_KEY=secret-key");
  });

  it("throws McpSecurityError when command is unauthorized", async () => {
    const config = parseMcpServerConfig({
      name: "unsafe-mcp",
      transport: "stdio",
      command: "malicious-cmd",
      sandbox: {
        enabled: true,
        engine: "bwrap",
        allowedBinaries: ["node", "python3"],
      },
    });

    if (config.transport !== "stdio") throw new Error("Must be stdio");

    await expect(McpSandboxManager.prepareStdio(config, {})).rejects.toThrow(McpSecurityError);
  });

  it("verifies package SHA-256 integrity", () => {
    const content = "const x = 42;";
    const expected = createHash("sha256").update(content).digest("hex");
    const isValid = verifyPackageChecksum(content, expected);
    expect(isValid).toBe(true);

    const isInvalid = verifyPackageChecksum(
      content,
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(isInvalid).toBe(false);
  });

  it("generates conforming SBOM with runtime, provenance and checksum", () => {
    const config = parseMcpServerConfig({
      name: "github-mcp",
      transport: "stdio",
      command: "npx",
      args: ["@modelcontextprotocol/server-github"],
    });

    const sbom = generateSbom(config);
    expect(sbom.serverName).toBe("github-mcp");
    expect(sbom.runtime).toBe("node");
    expect(sbom.packages).toHaveLength(1);
    expect(sbom.packages[0]?.source).toBe("npm");
    expect(sbom.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(sbom.verifiedAt).toBeDefined();
  });

  it.skipIf(!canCreateBubblewrapSandbox())(
    "executes commands in a Bubblewrap filesystem and process sandbox",
    async () => {
      const config = parseMcpServerConfig({
        name: "live-bwrap-test",
        transport: "stdio",
        command: process.execPath,
        args: ["-e", "console.log(process.env.TEST_SECRET)"],
        sandbox: {
          enabled: true,
          engine: "bwrap",
          readOnlyRoot: true,
          // Some hosted CI kernels allow user namespaces but prohibit the
          // RTM_NEWADDR operation Bubblewrap uses to initialize loopback in a
          // new network namespace. Network denial remains the production
          // default and is asserted by the argument-generation test above.
          allowNetwork: true,
          allowedBinaries: ["node"],
        },
      });

      if (config.transport !== "stdio") throw new Error("Must be stdio");

      const prepared = await McpSandboxManager.prepareStdio(config, {
        TEST_SECRET: "NEXUS_SANDBOX_OK",
      });

      expect(prepared.args).not.toContain("--unshare-net");
      const { stdout } = await execFileAsync(prepared.command, prepared.args);
      expect(stdout.trim()).toBe("NEXUS_SANDBOX_OK");
    },
  );

  it("probes host sandbox capabilities realistically", () => {
    const caps = probeHostSandboxCapabilities();
    expect(typeof caps.bwrap).toBe("boolean");
    expect(typeof caps.systemdUserScope).toBe("boolean");
    expect(typeof caps.docker).toBe("boolean");
  });

  it("generates systemd-run user scope when cgroup limits are requested", async () => {
    const config = parseMcpServerConfig({
      name: "systemd-scoped-mcp",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      sandbox: {
        enabled: true,
        engine: "bwrap",
        useSystemdScope: true,
        resourceLimits: {
          maxMemoryMb: 512,
          maxPids: 32,
          cpuShares: 1024,
          timeoutMs: 30000,
        },
      },
    });

    if (config.transport !== "stdio") throw new Error("Must be stdio");

    const prepared = await McpSandboxManager.prepareStdio(
      config,
      { SECRET_VAR: "secret-val" },
      { systemdRunPath: "systemd-run" },
    );

    expect(prepared.command).toBe("systemd-run");
    expect(prepared.args).toContain("--user");
    expect(prepared.args).toContain("--scope");
    expect(prepared.args).toContain("-pMemoryMax=512M");
    expect(prepared.args).toContain("-pTasksMax=32");
    expect(prepared.args).toContain("-pCPUQuota=100%");
    expect(prepared.args).toContain("bwrap");
    expect(prepared.args).toContain("--clearenv");
    expect(prepared.args).toContain("SECRET_VAR");
  });

  it("fails closed when resource limits cannot be guaranteed", async () => {
    const config = parseMcpServerConfig({
      name: "strict-mcp",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      sandbox: {
        enabled: true,
        engine: "bwrap",
        useSystemdScope: true,
      },
    });

    if (config.transport !== "stdio") throw new Error("Must be stdio");

    await expect(
      McpSandboxManager.prepareStdio(
        config,
        {},
        {
          useSystemdScope: true,
          requireResourceLimits: true,
          capabilities: { bwrap: true, systemdUserScope: false, docker: false },
        },
      ),
    ).rejects.toThrow();
  });
});
