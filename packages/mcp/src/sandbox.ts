import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { McpServerConfig, McpSbom, McpStdioConfig } from "./config.js";
import { isStdioConfig } from "./config.js";
import { McpSecurityError } from "./errors.js";

/**
 * Validates that the executed command is in the allowed binaries whitelist.
 */
export function validateBinary(command: string, allowedBinaries: string[]): boolean {
  const binaryName = basename(command);
  return allowedBinaries.some((allowed) => {
    return binaryName === allowed || command === allowed || binaryName.startsWith(`${allowed}-`);
  });
}

/**
 * Verifies package or content integrity against expected SHA-256 hash.
 */
export function verifyPackageChecksum(content: Buffer | string, expectedSha256: string): boolean {
  const buffer = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  const digest = createHash("sha256").update(buffer).digest("hex");
  return digest.toLowerCase() === expectedSha256.toLowerCase();
}

/**
 * Verifies file integrity on disk against expected SHA-256 hash.
 */
export async function verifyFileChecksum(
  filePath: string,
  expectedSha256: string,
): Promise<boolean> {
  try {
    const content = await readFile(filePath);
    return verifyPackageChecksum(content, expectedSha256);
  } catch {
    return false;
  }
}

/**
 * Generates a lightweight Software Bill of Materials (SBOM) asserting provenance
 * and sealed configuration for an MCP server.
 */
export function generateSbom(config: McpServerConfig): McpSbom {
  const now = new Date().toISOString();
  let runtime = "native";
  const packages: McpSbom["packages"] = [];

  if (isStdioConfig(config)) {
    const cmd = config.command.toLowerCase();
    if (cmd.includes("node") || cmd.includes("npx")) {
      runtime = "node";
      packages.push({
        name: config.args[0] ?? config.command,
        version: "latest",
        source: "npm",
      });
    } else if (cmd.includes("python") || cmd.includes("uv")) {
      runtime = "python";
      packages.push({
        name: config.args[0] ?? config.command,
        version: "latest",
        source: "pypi",
      });
    } else if (cmd.includes("docker") || cmd.includes("podman")) {
      runtime = "container";
      packages.push({
        name: config.args.find((a) => !a.startsWith("-")) ?? "image",
        version: "latest",
        source: "oci",
      });
    }
  } else {
    runtime = "http-remote";
  }

  const rawFingerprint = JSON.stringify({
    name: config.name,
    transport: config.transport,
    runtime,
    cmd: isStdioConfig(config) ? [config.command, ...config.args] : config.url,
    sandbox: config.sandbox,
  });

  const checksum = createHash("sha256").update(rawFingerprint).digest("hex");

  return {
    serverName: config.name,
    version: "1.0.0",
    runtime,
    packages,
    verifiedAt: now,
    checksum,
  };
}

export interface PreparedStdioExecution {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Container sandbox manager (Bubblewrap / Docker / None) for stdio MCP servers.
 */
export class McpSandboxManager {
  /**
   * Prepares execution parameters applying sandbox isolation policies.
   */
  static async prepareStdio(
    config: McpStdioConfig,
    env: Record<string, string>,
    options?: { bwrapPath?: string; dockerPath?: string },
  ): Promise<PreparedStdioExecution> {
    const sandbox = config.sandbox;

    if (!sandbox || !sandbox.enabled || sandbox.engine === "none") {
      return {
        command: config.command,
        args: config.args,
        env,
      };
    }

    // 1. Validate binary against whitelist
    if (!validateBinary(config.command, sandbox.allowedBinaries)) {
      throw new McpSecurityError(
        config.name,
        `Command "${config.command}" is not allowed by sandbox policy.`,
      );
    }

    // 2. Cryptographic checksum verification if configured
    if (sandbox.verifyChecksum) {
      const verified = await verifyFileChecksum(config.command, sandbox.verifyChecksum);
      if (!verified) {
        throw new McpSecurityError(
          config.name,
          `SHA-256 checksum for "${config.command}" does not match expected digest.`,
        );
      }
    }

    // 3. Bubblewrap engine (unprivileged Linux user namespace)
    if (sandbox.engine === "bwrap") {
      const bwrapCmd = options?.bwrapPath ?? "bwrap";
      const bwrapArgs: string[] = [];

      // Filesystem: read-only root
      if (sandbox.readOnlyRoot) {
        bwrapArgs.push("--ro-bind", "/", "/");
      } else {
        bwrapArgs.push("--bind", "/", "/");
      }

      // Essential system pseudo-filesystems
      bwrapArgs.push("--dev", "/dev");
      bwrapArgs.push("--proc", "/proc");
      bwrapArgs.push("--tmpfs", "/tmp");

      // Network isolation
      if (!sandbox.allowNetwork) {
        bwrapArgs.push("--unshare-net");
      }

      // Namespace isolation (PIDs, IPC, UTS)
      bwrapArgs.push("--unshare-pid", "--unshare-ipc", "--unshare-uts");

      // Explicit bind mounts
      for (const mount of sandbox.bindMounts) {
        const host = resolve(mount.hostPath);
        const target = mount.containerPath ? resolve(mount.containerPath) : host;
        if (mount.readOnly) {
          bwrapArgs.push("--ro-bind", host, target);
        } else {
          bwrapArgs.push("--bind", host, target);
        }
      }

      // Working directory
      if (config.cwd) {
        bwrapArgs.push("--chdir", resolve(config.cwd));
      }

      // Clean environment: no host leakage, explicit variables only
      bwrapArgs.push("--clearenv");
      const pathValue = env.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
      bwrapArgs.push("--setenv", "PATH", pathValue);
      if (!env.HOME) {
        bwrapArgs.push("--setenv", "HOME", "/tmp");
      }
      for (const [k, v] of Object.entries(env)) {
        if (k !== "PATH") {
          bwrapArgs.push("--setenv", k, v);
        }
      }

      // End of bwrap options delimiter
      bwrapArgs.push("--", config.command, ...config.args);

      return {
        command: bwrapCmd,
        args: bwrapArgs,
        env: {}, // Variables injected via --setenv
      };
    }

    // 4. Docker engine
    if (sandbox.engine === "docker") {
      const dockerCmd = options?.dockerPath ?? "docker";
      const dockerArgs: string[] = ["run", "-i", "--rm"];

      if (sandbox.readOnlyRoot) {
        dockerArgs.push("--read-only");
      }

      if (!sandbox.allowNetwork) {
        dockerArgs.push("--network", "none");
      }

      const limits = sandbox.resourceLimits;
      if (limits) {
        dockerArgs.push("--memory", `${limits.maxMemoryMb}m`);
        dockerArgs.push("--pids-limit", String(limits.maxPids));
        dockerArgs.push("--cpu-shares", String(limits.cpuShares));
      }

      for (const mount of sandbox.bindMounts) {
        const host = resolve(mount.hostPath);
        const target = mount.containerPath ? resolve(mount.containerPath) : host;
        const mode = mount.readOnly ? "ro" : "rw";
        dockerArgs.push("-v", `${host}:${target}:${mode}`);
      }

      for (const [k, v] of Object.entries(env)) {
        dockerArgs.push("-e", `${k}=${v}`);
      }

      if (config.cwd) {
        dockerArgs.push("-w", resolve(config.cwd));
      }

      dockerArgs.push(config.command, ...config.args);

      return {
        command: dockerCmd,
        args: dockerArgs,
        env: {},
      };
    }

    return {
      command: config.command,
      args: config.args,
      env,
    };
  }
}
