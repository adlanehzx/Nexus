import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { NexusPaths } from "./environment.js";
import { readEnvFile } from "./environment.js";
import {
  backupName,
  buildArchive,
  extractEntries,
  readArchive,
  rotationVictims,
  type Manifest,
} from "./archive.js";

const run = promisify(execFile);

/**
 * Backup and restoration management for a NEXUS instance.
 */

export interface BackupOptions {
  paths: NexusPaths;
  /** Encrypts the archive. When omitted, written unencrypted and flagged in manifest. */
  passphrase?: string;
  includeSecrets: boolean;
  keep: number;
  now?: () => Date;
}

export interface BackupOutcome {
  path: string;
  manifest: Manifest;
  rotated: string[];
  warnings: string[];
}

const RESTORE_STEPS = [
  "nexus restore <archive>  — restores PostgreSQL, SQLite, and configuration files",
  "AUTH_SIGNING_KEY is NOT in the archive: copy it into .env from your",
  "  secure storage, or generate a new key with `nexus setup`.",
  "Vault credentials (OAuth tokens, provider keys) are not saved:",
  "  re-enter them via the dashboard.",
  "nexus doctor — verifies restored installation health",
];

export async function createBackup(options: BackupOptions): Promise<BackupOutcome> {
  const { paths } = options;
  const at = (options.now ?? (() => new Date()))();
  const env = readEnvFile(paths.envFile);
  const warnings: string[] = [];
  const entries: { name: string; description: string; content: Buffer }[] = [];

  // ── PostgreSQL ──────────────────────────────────────────────────────────
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    warnings.push("DATABASE_URL missing: PostgreSQL was not backed up");
  } else {
    entries.push({
      name: "postgres.dump",
      description:
        "pg_dump custom format: accounts, conversations, messages, memory, tasks, runs, and assertions",
      content: await dumpPostgres(databaseUrl),
    });
  }

  // ── Engine SQLite ────────────────────────────────────────────────────────
  if (!existsSync(paths.missionEngineDatabase)) {
    warnings.push("Mission Engine SQLite missing: no missions backed up");
  } else {
    entries.push({
      name: "mission-engine.db",
      description: "consistent SQLite snapshot: missions, tasks, attempts",
      content: snapshotSqlite(paths),
    });
  }

  // ── Configurations ──────────────────────────────────────────────────────
  for (const [name, path, description] of configurationFiles(paths)) {
    if (!existsSync(path)) continue;
    entries.push({ name, description, content: readFileSync(path) });
  }

  // ── Public key ───────────────────────────────────────────────────────────
  if (existsSync(paths.publicKeyFile)) {
    entries.push({
      name: "public/api-public.pem",
      description: "API public key for Mission Engine verification",
      content: readFileSync(paths.publicKeyFile),
    });
  }

  // ── Secrets, only on explicit request ────────────────────────────────────
  if (options.includeSecrets) {
    if (existsSync(paths.envFile)) {
      entries.push({
        name: "secrets/.env",
        description: "SECRETS FILE — signing key and database credentials",
        content: readFileSync(paths.envFile),
      });
    }
    warnings.push("archive contains .env: treat archive as confidential");
    if (options.passphrase === undefined) {
      warnings.push("secrets included WITHOUT encryption: provide --passphrase");
    }
  }

  entries.push({
    name: "RESTORE.md",
    description: "restoration instructions, readable without decrypting archive",
    content: Buffer.from(restoreDocument(at, options), "utf8"),
  });

  const archive = buildArchive({
    entries,
    nexusVersion: readVersion(paths.root),
    origin: paths.root,
    createdAt: at,
    includesSecrets: options.includeSecrets,
    restore: RESTORE_STEPS,
    ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
  });

  mkdirSync(paths.backupsDir, { recursive: true, mode: 0o700 });
  const path = join(paths.backupsDir, backupName(at));
  writeFileSync(path, archive, { mode: 0o600 });

  // ── Rotation ────────────────────────────────────────────────────────────
  const victims = rotationVictims(readdirSync(paths.backupsDir), options.keep);
  for (const victim of victims) rmSync(join(paths.backupsDir, victim));

  if (options.passphrase === undefined) {
    warnings.push("unencrypted archive: use --passphrase to protect sensitive data");
  }

  return { path, manifest: readArchive(archive).manifest, rotated: victims, warnings };
}

/**
 * Verifies that an archive is restorable without altering current installation.
 */
export async function verifyBackup(
  archivePath: string,
  options: { databaseUrl: string; passphrase?: string },
): Promise<{ checks: { name: string; detail: string; ok: boolean }[] }> {
  const read = readArchive(readFileSync(archivePath));
  const entries = extractEntries(read, options.passphrase);
  const checks: { name: string; detail: string; ok: boolean }[] = [];

  checks.push({
    name: "manifest and checksums",
    detail: `${read.manifest.entries.length} entry/entries verified`,
    ok: true,
  });

  const workspace = mkdtempSync(join(tmpdir(), "nexus-verify-"));
  try {
    const dump = entries.get("postgres.dump");
    if (dump === undefined) {
      checks.push({ name: "PostgreSQL", detail: "missing from archive", ok: false });
    } else {
      const dumpPath = join(workspace, "postgres.dump");
      writeFileSync(dumpPath, dump);
      const probe = `nexus_verify_${Date.now()}`;
      await psql(options.databaseUrl, `CREATE DATABASE "${probe}"`);
      try {
        await run("pg_restore", [
          "--no-owner",
          "--dbname",
          replaceDatabase(options.databaseUrl, probe),
          dumpPath,
        ]);
        const tables = await psql(
          replaceDatabase(options.databaseUrl, probe),
          "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'",
        );
        checks.push({
          name: "PostgreSQL restore",
          detail: `${tables.trim()} tables restored into transient database`,
          ok: Number(tables.trim()) > 0,
        });
      } finally {
        await psql(options.databaseUrl, `DROP DATABASE IF EXISTS "${probe}"`);
      }
    }

    const sqlite = entries.get("mission-engine.db");
    if (sqlite === undefined) {
      checks.push({ name: "Engine SQLite", detail: "missing from archive", ok: true });
    } else {
      const path = join(workspace, "mission-engine.db");
      writeFileSync(path, sqlite);
      const integrity = await run("sqlite3", [path, "PRAGMA integrity_check;"]).then(
        (result) => result.stdout.trim(),
        () => "unavailable",
      );
      const missions = await run("sqlite3", [path, "SELECT count(*) FROM missions;"]).then(
        (result) => result.stdout.trim(),
        () => "?",
      );
      checks.push({
        name: "SQLite restore",
        detail: `integrity_check: ${integrity} · ${missions} mission(s)`,
        ok: integrity === "ok",
      });
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  return { checks };
}

export interface RestoreOutcome {
  applied: string[];
  skipped: string[];
  warnings: string[];
}

/**
 * Restores an archive onto current installation.
 */
export async function restoreBackup(
  archivePath: string,
  options: { paths: NexusPaths; passphrase?: string },
): Promise<RestoreOutcome> {
  const { paths } = options;
  const read = readArchive(readFileSync(archivePath));
  const entries = extractEntries(read, options.passphrase);
  const applied: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  const env = readEnvFile(paths.envFile);
  const databaseUrl = env.DATABASE_URL;
  const dump = entries.get("postgres.dump");

  if (dump === undefined) {
    skipped.push("PostgreSQL (missing from archive)");
  } else if (databaseUrl === undefined) {
    warnings.push("DATABASE_URL missing: PostgreSQL not restored");
  } else {
    const workspace = mkdtempSync(join(tmpdir(), "nexus-restore-"));
    try {
      const dumpPath = join(workspace, "postgres.dump");
      writeFileSync(dumpPath, dump);
      await run("pg_restore", [
        "--clean",
        "--if-exists",
        "--no-owner",
        "--dbname",
        libpqUrl(databaseUrl),
        dumpPath,
      ]);
      applied.push("PostgreSQL");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  const sqlite = entries.get("mission-engine.db");
  if (sqlite !== undefined) {
    mkdirSync(join(paths.missionEngine, "var"), { recursive: true });
    writeFileSync(paths.missionEngineDatabase, sqlite, { mode: 0o600 });
    applied.push("Engine SQLite");
    warnings.push(
      "engine must be restarted to reload database: systemctl --user restart nexus-mission-engine",
    );
  }

  for (const [name, path] of configurationFiles(paths)) {
    const content = entries.get(name);
    if (content === undefined) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: 0o600 });
    applied.push(name);
  }

  const publicKey = entries.get("public/api-public.pem");
  if (publicKey !== undefined) {
    mkdirSync(dirname(paths.publicKeyFile), { recursive: true, mode: 0o700 });
    writeFileSync(paths.publicKeyFile, publicKey, { mode: 0o644 });
    applied.push("API public key");
  }

  if (!read.manifest.includesSecrets) {
    warnings.push(
      "archive contains no secrets: copy AUTH_SIGNING_KEY into .env, otherwise in-flight missions cannot be resumed",
    );
  }

  return { applied, skipped, warnings };
}

/** Saved configuration files with descriptions. */
export function configurationFiles(paths: NexusPaths): [string, string, string][] {
  return [
    [
      "config/mission-engine/runtime-settings.json",
      paths.engineRuntimeSettings,
      "engine settings: timeouts, retries, routing priorities",
    ],
    [
      "config/mission-engine/profiles.production.json",
      paths.engineProfiles,
      "registered agent profiles for mission engine",
    ],
    [
      "config/agent/profiles.production.json",
      paths.agentRegistry,
      "ACP runtime profiles: commands, models, policies",
    ],
    [
      "config/api/browser.json",
      join(paths.root, "services", "api", "config", "browser.json"),
      "Browser Use configuration",
    ],
    [
      "config/api/mcp.json",
      join(paths.root, "services", "api", "config", "mcp.json"),
      "registered MCP servers",
    ],
  ];
}

/**
 * Sanitizes Prisma database URL for libpq compatibility.
 */
export function libpqUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const allowed = new Set([
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "application_name",
    "connect_timeout",
    "options",
  ]);
  for (const key of [...url.searchParams.keys()]) {
    if (!allowed.has(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

/**
 * Checks if pg_dump failed due to client/server version mismatch.
 */
export function isVersionMismatch(message: string): boolean {
  return /server version mismatch|server version: \d+/.test(message);
}

/**
 * Discovers container name publishing given port from docker ps output.
 */
export function containerPublishing(dockerPs: string, port: number): string | undefined {
  for (const line of dockerPs.split("\n")) {
    const [name = "", ports = ""] = line.split("\t");
    if (name.length === 0) continue;
    if (new RegExp(`:${port}->`).test(ports)) return name;
  }
  return undefined;
}

async function dumpPostgres(databaseUrl: string): Promise<Buffer> {
  const workspace = mkdtempSync(join(tmpdir(), "nexus-dump-"));
  try {
    const path = join(workspace, "postgres.dump");
    const url = libpqUrl(databaseUrl);
    try {
      await run("pg_dump", ["--format", "custom", "--file", path, url], {
        maxBuffer: 1024 * 1024 * 64,
      });
      return readFileSync(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isVersionMismatch(message)) throw error;

      const dumped = await dumpThroughContainer(url);
      if (dumped === undefined) {
        throw new Error(
          "Local pg_dump client is older than the database server, and no container publishing this port was found.\n" +
            "Install a client matching the server version, or run PostgreSQL via `pnpm docker:up`.",
          { cause: error },
        );
      }
      return dumped;
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function dumpThroughContainer(url: string): Promise<Buffer | undefined> {
  const parsed = new URL(url);
  const port = Number(parsed.port.length > 0 ? parsed.port : 5432);
  const listing = await run("docker", ["ps", "--format", "{{.Names}}\\t{{.Ports}}"]).then(
    (result) => result.stdout,
    () => undefined,
  );
  if (listing === undefined) return undefined;

  const container = containerPublishing(listing, port);
  if (container === undefined) return undefined;

  const internal = new URL(url);
  internal.hostname = "127.0.0.1";
  internal.port = "5432";

  const { stdout } = await run(
    "docker",
    ["exec", container, "pg_dump", "--format", "custom", internal.toString()],
    { maxBuffer: 1024 * 1024 * 256, encoding: "buffer" },
  );
  return Buffer.from(stdout);
}

export function snapshotCommands(
  venvBin: string,
  source: string,
  target: string,
): { file: string; args: string[] }[] {
  const script = [
    "import sqlite3, sys",
    "source = sqlite3.connect(f'file:{sys.argv[1]}?mode=ro', uri=True)",
    "target = sqlite3.connect(sys.argv[2])",
    "source.backup(target)",
    "target.close(); source.close()",
  ].join("\n");

  return [
    { file: join(venvBin, "python"), args: ["-c", script, source, target] },
    { file: "sqlite3", args: [source, `.backup '${target}'`] },
    { file: "python3", args: ["-c", script, source, target] },
  ];
}

function snapshotSqlite(paths: NexusPaths): Buffer {
  const workspace = mkdtempSync(join(tmpdir(), "nexus-sqlite-"));
  try {
    const target = join(workspace, "snapshot.db");
    const attempts: string[] = [];

    for (const candidate of snapshotCommands(
      paths.missionEngineVenvBin,
      paths.missionEngineDatabase,
      target,
    )) {
      try {
        execFileSync(candidate.file, candidate.args, { stdio: "pipe" });
        return readFileSync(target);
      } catch (error) {
        attempts.push(
          `${candidate.file}: ${error instanceof Error ? error.message.split("\n")[0] : "failed"}`,
        );
      }
    }

    throw new Error(
      `no tool available for consistent SQLite snapshot.\n${attempts.join("\n")}\n` +
        "Install `sqlite3` or set up the engine Python virtualenv.",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function psql(databaseUrl: string, statement: string): Promise<string> {
  const { stdout } = await run("psql", [libpqUrl(databaseUrl), "-t", "-A", "-c", statement]);
  return stdout;
}

function replaceDatabase(databaseUrl: string, database: string): string {
  const url = new URL(libpqUrl(databaseUrl));
  url.pathname = `/${database}`;
  return url.toString();
}

function readVersion(root: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

function restoreDocument(at: Date, options: BackupOptions): string {
  return `# Restoring a NEXUS Backup

Archive created on ${at.toISOString()} from ${options.paths.root}.
Secrets included: ${options.includeSecrets ? "YES — treat archive as confidential" : "no"}.
Encryption: ${options.passphrase === undefined ? "none" : "AES-256-GCM, key derived with scrypt"}.

## On a Blank Machine

1. Install prerequisites: Node (see \`.nvmrc\`), pnpm, Docker, uv.
2. Clone repository, \`pnpm install\`, \`pnpm build\`.
3. \`pnpm docker:up\` for PostgreSQL, Redis, and SearXNG.
4. \`nexus setup\` for configuration and signing keys.
5. \`nexus restore <archive>\` for data restoration.
6. \`nexus doctor\` to verify installation state.

## What the Archive Does Not Contain

${
  options.includeSecrets
    ? "All secrets are included."
    : `The signing key (\`AUTH_SIGNING_KEY\`) and vault credentials.

Without the original signing key, active in-flight missions cannot be resumed
because their ownership assertions are signed with it. Completed missions,
conversations, memory, and agent profiles remain intact.`
}

## Verify Archive Integrity Without Restoring

    nexus backup --verify <archive>

PostgreSQL is restored into a transient probe database, the SQLite database
is inspected for integrity, and entries are verified against the manifest.
`;
}
