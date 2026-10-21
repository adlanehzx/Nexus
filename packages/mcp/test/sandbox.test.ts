import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseMcpServerConfig } from "../src/config.js";
import { McpSecurityError } from "../src/errors.js";
import {
  McpSandboxManager,
  generateSbom,
  validateBinary,
  verifyPackageChecksum,
} from "../src/sandbox.js";

const execFileAsync = promisify(execFile);

describe("Isolation et Sécurité MCP (Chantier 15)", () => {
  it("valide les binaires autorisés et rejette les commandes non autorisées", () => {
    const allowed = ["node", "python3", "uv", "uvx", "docker"];
    expect(validateBinary("node", allowed)).toBe(true);
    expect(validateBinary("/usr/bin/node", allowed)).toBe(true);
    expect(validateBinary("python3", allowed)).toBe(true);
    expect(validateBinary("/bin/bash", allowed)).toBe(false);
    expect(validateBinary("/tmp/malicious-binary", allowed)).toBe(false);
    expect(validateBinary("curl", allowed)).toBe(false);
  });

  it("génère les arguments bwrap sécurisés (ro-root, tmpfs, unshare-net, mounts)", async () => {
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

    if (config.transport !== "stdio") throw new Error("Doit être stdio");

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

  it("génère les options Docker avec limites de ressources et isolation réseau", async () => {
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

    if (config.transport !== "stdio") throw new Error("Doit être stdio");

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

  it("lève une erreur de sécurité McpSecurityError si la commande n'est pas autorisée", async () => {
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

    if (config.transport !== "stdio") throw new Error("Doit être stdio");

    await expect(McpSandboxManager.prepareStdio(config, {})).rejects.toThrow(McpSecurityError);
  });

  it("vérifie l'intégrité SHA-256 des paquets", () => {
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

  it("génère un SBOM conforme avec runtime, provenance et empreinte", () => {
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

  it("exécute réellement une commande dans Bubblewrap en environnement isolé", async () => {
    const config = parseMcpServerConfig({
      name: "live-bwrap-test",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "console.log(process.env.TEST_SECRET)"],
      sandbox: {
        enabled: true,
        engine: "bwrap",
        readOnlyRoot: true,
        allowNetwork: false,
        allowedBinaries: ["node"],
      },
    });

    if (config.transport !== "stdio") throw new Error("Doit être stdio");

    const prepared = await McpSandboxManager.prepareStdio(config, {
      TEST_SECRET: "NEXUS_SANDBOX_OK",
    });

    // Exécution réelle de bwrap sur Linux
    const { stdout } = await execFileAsync(prepared.command, prepared.args);
    expect(stdout.trim()).toBe("NEXUS_SANDBOX_OK");
  });
});
