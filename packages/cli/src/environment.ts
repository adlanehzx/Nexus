import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Installation paths resolution.
 *
 * All CLI commands derive paths from the detected repository root, ensuring
 * zero machine-specific hardcoded paths.
 */

export interface NexusPaths {
  /** Repository root. */
  root: string;
  envFile: string;
  envExample: string;
  publicKeyFile: string;
  missionEngine: string;
  missionEngineVenvBin: string;
  missionEngineDatabase: string;
  agentRunner: string;
  agentRegistry: string;
  engineProfiles: string;
  engineRuntimeSettings: string;
  systemdUserDir: string;
  backupsDir: string;
}

/**
 * Climbs parent directories to locate repository root identified by `pnpm-workspace.yaml`.
 */
export function findRepositoryRoot(from: string): string {
  let current = resolve(from);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `NEXUS root not found from ${from}: no pnpm-workspace.yaml in parent directories`,
      );
    }
    current = parent;
  }
}

export function resolvePaths(root: string, home = homedir()): NexusPaths {
  const missionEngine = join(root, "services", "mission-engine");
  return {
    root,
    envFile: join(root, ".env"),
    envExample: join(root, ".env.example"),
    publicKeyFile: join(home, ".config", "nexus", "api-public.pem"),
    missionEngine,
    missionEngineVenvBin: join(missionEngine, ".venv", "bin"),
    missionEngineDatabase: join(missionEngine, "var", "nexus-engine-production.db"),
    agentRunner: join(root, "services", "agent", "dist", "cli.js"),
    agentRegistry: join(root, "services", "agent", "config", "profiles.production.json"),
    engineProfiles: join(missionEngine, "config", "profiles.production.json"),
    engineRuntimeSettings: join(missionEngine, "config", "runtime-settings.json"),
    systemdUserDir: join(home, ".config", "systemd", "user"),
    backupsDir: join(root, "backups"),
  };
}

/**
 * Reads a `.env` file without modifying `process.env`.
 */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};

  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1).replace(/\\n/g, "\n");
    }
    values[key] = value;
  }
  return values;
}

/**
 * Updates or adds a variable in `.env` content, returning the transformed string.
 */
export function upsertEnvValue(content: string, key: string, value: string): string {
  const serialised = `${key}=${quoteIfNeeded(value)}`;
  const lines = content.length === 0 ? [] : content.split("\n");

  const index = lines.findIndex((line) => {
    const trimmed = line.trim().replace(/^#\s*/, "");
    return trimmed.startsWith(`${key}=`);
  });

  if (index >= 0) {
    lines[index] = serialised;
    return lines.join("\n");
  }
  const body = content.endsWith("\n") || content.length === 0 ? content : `${content}\n`;
  return `${body}${serialised}\n`;
}

function quoteIfNeeded(value: string): string {
  if (!/[\s"'#\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/**
 * Checks whether persistent signing key is configured in env.
 */
export function hasPersistentSigningKey(env: Record<string, string>): boolean {
  const value = env.AUTH_SIGNING_KEY;
  return typeof value === "string" && value.includes("BEGIN PRIVATE KEY");
}
