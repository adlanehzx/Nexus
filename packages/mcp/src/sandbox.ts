import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { McpServerConfig, McpSbom, McpStdioConfig } from "./config.js";
import { isStdioConfig } from "./config.js";
import { McpSecurityError } from "./errors.js";

/**
 * Valide que le binaire exécuté fait partie de la liste blanche autorisée.
 */
export function validateBinary(command: string, allowedBinaries: string[]): boolean {
  const binaryName = basename(command);
  return allowedBinaries.some((allowed) => {
    return binaryName === allowed || command === allowed || binaryName.startsWith(`${allowed}-`);
  });
}

/**
 * Vérifie l'intégrité d'un contenu ou paquet par rapport à son hachage SHA-256 attendu.
 */
export function verifyPackageChecksum(content: Buffer | string, expectedSha256: string): boolean {
  const buffer = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  const digest = createHash("sha256").update(buffer).digest("hex");
  return digest.toLowerCase() === expectedSha256.toLowerCase();
}

/**
 * Vérifie l'intégrité d'un fichier sur disque par rapport à son empreinte SHA-256 attendue.
 */
export async function verifyFileChecksum(filePath: string, expectedSha256: string): Promise<boolean> {
  try {
    const content = await readFile(filePath);
    return verifyPackageChecksum(content, expectedSha256);
  } catch {
    return false;
  }
}

/**
 * Génère un Software Bill of Materials (SBOM) léger attestant de la provenance et
 * de la configuration scellée du serveur MCP.
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
 * Gestionnaire du bac à sable conteneurisé (Bubblewrap / Docker / None)
 * pour les serveurs MCP stdio.
 */
export class McpSandboxManager {
  /**
   * Prépare les paramètres d'exécution en appliquant l'isolation en bac à sable.
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

    // 1. Validation de la commande / binaire
    if (!validateBinary(config.command, sandbox.allowedBinaries)) {
      throw new McpSecurityError(
        config.name,
        `La commande « ${config.command} » n'est pas autorisée par la politique de bac à sable.`,
      );
    }

    // 2. Vérification de l'empreinte cryptographique si spécifiée
    if (sandbox.verifyChecksum) {
      const verified = await verifyFileChecksum(config.command, sandbox.verifyChecksum);
      if (!verified) {
        throw new McpSecurityError(
          config.name,
          `L'empreinte SHA-256 du fichier « ${config.command} » ne correspond pas à la somme attendue.`,
        );
      }
    }

    // 3. Moteur Bubblewrap (unprivileged Linux user namespace)
    if (sandbox.engine === "bwrap") {
      const bwrapCmd = options?.bwrapPath ?? "bwrap";
      const bwrapArgs: string[] = [];

      // Système de fichiers : lecture seule sur la racine
      if (sandbox.readOnlyRoot) {
        bwrapArgs.push("--ro-bind", "/", "/");
      } else {
        bwrapArgs.push("--bind", "/", "/");
      }

      // Pseudo-fichiers système essentiels
      bwrapArgs.push("--dev", "/dev");
      bwrapArgs.push("--proc", "/proc");
      bwrapArgs.push("--tmpfs", "/tmp");

      // Isolation réseau stricte si allowNetwork est faux
      if (!sandbox.allowNetwork) {
        bwrapArgs.push("--unshare-net");
      }

      // Isolation des espaces de noms (PIDs, IPC, UTS)
      bwrapArgs.push("--unshare-pid", "--unshare-ipc", "--unshare-uts");

      // Montages explicites
      for (const mount of sandbox.bindMounts) {
        const host = resolve(mount.hostPath);
        const target = mount.containerPath ? resolve(mount.containerPath) : host;
        if (mount.readOnly) {
          bwrapArgs.push("--ro-bind", host, target);
        } else {
          bwrapArgs.push("--bind", host, target);
        }
      }

      // Répertoire courant
      if (config.cwd) {
        bwrapArgs.push("--chdir", resolve(config.cwd));
      }

      // Environnement scellé (aucun héritage de l'hôte, seules les variables explicites)
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

      // Délimiteur de fin d'options bwrap
      bwrapArgs.push("--", config.command, ...config.args);

      return {
        command: bwrapCmd,
        args: bwrapArgs,
        env: {}, // Les variables sont injectées via --setenv
      };
    }

    // 3. Moteur Docker
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
