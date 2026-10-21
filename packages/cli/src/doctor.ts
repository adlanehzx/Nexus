import { existsSync, readFileSync, statSync } from "node:fs";
import { createPublicKey } from "node:crypto";

import { parseConfig } from "@nexus/config";
import type { NexusPaths } from "./environment.js";
import { hasPersistentSigningKey } from "./environment.js";
import { hostAndPort, unitState, type Probes } from "./probes.js";
import { foreignPaths, BROWSER_UNIT, MISSION_ENGINE_UNIT } from "./systemd.js";
import { fail, ok, skip, warn, type CheckGroup, type CheckResult } from "./report.js";

/**
 * NEXUS installation diagnostics.
 *
 * Organized into functional groups: Configuration, Data and services,
 * Agents and tools, Security, and Systemd services.
 */

export interface DoctorContext {
  paths: NexusPaths;
  probes: Probes;
  env: Record<string, string>;
}

export async function runDoctor(context: DoctorContext): Promise<CheckGroup[]> {
  return [
    { title: "Configuration", results: configurationChecks(context) },
    { title: "Data and services", results: await dataChecks(context) },
    { title: "Agents and tools", results: await agentChecks(context) },
    { title: "Security", results: await securityChecks(context) },
    { title: "Systemd services", results: await systemdChecks(context) },
  ];
}

function configurationChecks({ paths, env }: DoctorContext): CheckResult[] {
  const results: CheckResult[] = [];

  if (Object.keys(env).length === 0) {
    results.push(
      fail(
        ".env",
        `missing (${paths.envFile})`,
        "nexus setup — creates file from .env.example",
      ),
    );
    return results;
  }
  results.push(ok(".env", `loaded (${Object.keys(env).length} variables)`));

  try {
    parseConfig({ ...env, NODE_ENV: env.NODE_ENV ?? "development" });
    results.push(ok("configuration schema", "all required variables are valid"));
  } catch (error) {
    results.push(
      fail(
        "configuration schema",
        firstLine(error instanceof Error ? error.message : String(error)),
        "fix .env — message above indicates invalid variable",
      ),
    );
  }

  const root = paths.root;
  const strays = Object.entries(env).filter(
    ([, value]) =>
      value.startsWith("/") && /nexus|mission-engine/.test(value) && !value.startsWith(root),
  );
  results.push(
    strays.length === 0
      ? ok(".env paths", "no paths outside this installation")
      : warn(
          ".env paths",
          `${strays.length} variable(s) point outside: ${strays.map(([key]) => key).join(", ")}`,
          "fix paths or rerun nexus setup",
        ),
  );

  return results;
}

async function dataChecks({ paths, probes, env }: DoctorContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(await reachable(probes, "PostgreSQL", env.DATABASE_URL, "pnpm docker:up"));
  results.push(await reachable(probes, "Redis", env.REDIS_URL, "pnpm docker:up"));

  const status = await probes.command(
    "pnpm",
    ["--filter", "@nexus/database", "exec", "prisma", "migrate", "status"],
    60_000,
  );
  if (status === undefined) {
    results.push(
      warn(
        "PostgreSQL migrations",
        "indeterminate status",
        "pnpm --filter @nexus/database exec prisma migrate status",
      ),
    );
  } else if (status.includes("up to date")) {
    results.push(ok("PostgreSQL migrations", "up to date"));
  } else {
    results.push(
      fail(
        "PostgreSQL migrations",
        "pending migrations unapplied",
        "pnpm --filter @nexus/database exec prisma migrate deploy",
      ),
    );
  }

  const database = paths.missionEngineDatabase;
  results.push(
    existsSync(database)
      ? ok("Mission Engine SQLite", `${(statSync(database).size / 1024).toFixed(0)} KiB`)
      : warn("Mission Engine SQLite", "missing — created on first engine startup"),
  );

  results.push(
    existsSync(paths.backupsDir)
      ? ok("backups directory", paths.backupsDir)
      : warn("backups directory", "missing", "nexus backup — creates directory if needed"),
  );

  return results;
}

async function agentChecks({ paths, probes, env }: DoctorContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const engineUrl = env.MISSION_CONTROL_URL;
  if (engineUrl === undefined || engineUrl.length === 0) {
    results.push(skip("Mission Engine", "MISSION_CONTROL_URL undefined"));
  } else {
    const health = await probes.http(`${engineUrl.replace(/\/$/, "")}/v1/health/ready`);
    if (health === undefined) {
      results.push(fail("Mission Engine", `unreachable at ${engineUrl}`, "nexus start"));
    } else {
      const profiles = readProfiles(health.body);
      results.push(
        ok(
          "Mission Engine",
          `ready — profiles: ${profiles.length > 0 ? profiles.join(", ") : "none"}`,
        ),
      );
      results.push(
        profiles.length > 0
          ? ok("configured ACP agents", `${profiles.length}`)
          : warn(
              "configured ACP agents",
              "no active profiles: ACP tasks cannot be routed",
              "register an agent profile via dashboard",
            ),
      );
    }
  }

  for (const [label, path, fix] of [
    ["ACP runner", paths.agentRunner, "pnpm --filter @nexus/agent build"],
    ["ACP registry", paths.agentRegistry, "create agent profile registry"],
  ] as const) {
    results.push(existsSync(path) ? ok(label, path) : fail(label, `missing (${path})`, fix));
  }

  const searxng = env.SEARXNG_URL;
  if (searxng === undefined || searxng.length === 0) {
    results.push(skip("SearXNG", "SEARXNG_URL undefined — web search inactive"));
  } else {
    const probe = await probes.http(searxng);
    results.push(
      probe === undefined
        ? fail("SearXNG", `unreachable at ${searxng}`, "pnpm docker:up")
        : ok("SearXNG", `reachable (HTTP ${probe.status})`),
    );
  }

  const cdp = await probes.http("http://127.0.0.1:19222/json/version");
  results.push(
    cdp === undefined
      ? warn(
          "Chromium (CDP)",
          "unreachable at 127.0.0.1:19222 — Browser Use unavailable",
          "systemctl --user start nexus-browser",
        )
      : ok("Chromium (CDP)", "reachable"),
  );

  return results;
}

async function securityChecks({ paths, probes, env }: DoctorContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const mode = permissionsOf(paths.envFile);
  results.push(
    mode === undefined
      ? skip(".env permissions", "file missing")
      : mode === "600"
        ? ok(".env permissions", "0600")
        : warn(
            ".env permissions",
            `0${mode} — readable beyond owner, contains sensitive secrets`,
            `chmod 600 ${paths.envFile}`,
          ),
  );

  if (!hasPersistentSigningKey(env)) {
    results.push(
      warn(
        "signing key",
        "ephemeral: regenerated on every API startup",
        "nexus setup — generates persistent key",
      ),
    );
    results.push(skip("API → engine authentication", "requires persistent signing key"));
    return results;
  }
  results.push(ok("signing key", "persistent"));

  if (!existsSync(paths.publicKeyFile)) {
    results.push(
      warn(
        "deployed public key",
        `missing (${paths.publicKeyFile})`,
        "nexus setup — deploys public key and enables engine authentication",
      ),
    );
  } else {
    const matches = publicKeyMatches(env.AUTH_SIGNING_KEY ?? "", paths.publicKeyFile);
    results.push(
      matches
        ? ok("deployed public key", "matches current signing key")
        : fail(
            "deployed public key",
            "mismatches current signing key",
            "nexus setup — redeploys public key",
          ),
    );
  }

  const engineUrl = env.MISSION_CONTROL_URL;
  if (engineUrl !== undefined && engineUrl.length > 0) {
    const probe = await probes.http(`${engineUrl.replace(/\/$/, "")}/v1/settings`);
    results.push(
      probe === undefined
        ? skip("API → engine authentication", "engine unreachable")
        : ok(
            "API → engine authentication",
            "engine responded; verified at service startup",
          ),
    );
  }

  return results;
}

async function systemdChecks({ paths, probes }: DoctorContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const unit of [MISSION_ENGINE_UNIT, BROWSER_UNIT]) {
    const state = await unitState(probes, unit);
    if (!state.installed) {
      results.push(warn(unit, "not installed", "nexus setup — generates and installs units"));
      continue;
    }

    const details = [
      state.active ? "active" : "stopped",
      state.enabled ? "enabled at boot" : "disabled",
    ];
    results.push(
      state.active ? ok(unit, details.join(", ")) : warn(unit, details.join(", "), "nexus start"),
    );

    if (state.fragmentPath !== undefined && existsSync(state.fragmentPath)) {
      const strays = foreignPaths(readFileSyncSafe(state.fragmentPath), paths.root);
      if (strays.length > 0) {
        results.push(
          fail(
            `${unit} (paths)`,
            `${strays.length} path(s) outside current installation: ${strays[0] ?? ""}`,
            "nexus setup — regenerates unit with current paths",
          ),
        );
      }
    }
  }

  return results;
}

async function reachable(
  probes: Probes,
  label: string,
  url: string | undefined,
  fix: string,
): Promise<CheckResult> {
  if (url === undefined || url.length === 0) return skip(label, "URL undefined");
  const target = hostAndPort(url);
  if (target === undefined) return fail(label, `Invalid URL: ${url}`);
  const open = await probes.tcp(target.host, target.port);
  return open
    ? ok(label, `reachable at ${target.host}:${target.port}`)
    : fail(label, `unreachable at ${target.host}:${target.port}`, fix);
}

export function publicKeyMatches(privateKeyPem: string, publicKeyFile: string): boolean {
  try {
    const derived = createPublicKey(privateKeyPem)
      .export({ type: "spki", format: "pem" })
      .toString();
    return normalise(derived) === normalise(readFileSync(publicKeyFile, "utf8"));
  } catch {
    return false;
  }
}

const normalise = (value: string): string => value.replace(/\s+/g, "");

function readProfiles(body: string): string[] {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return [];
    const profiles = (parsed as { profiles?: unknown }).profiles;
    return Array.isArray(profiles)
      ? profiles.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function permissionsOf(path: string): string | undefined {
  try {
    return (statSync(path).mode & 0o777).toString(8);
  } catch {
    return undefined;
  }
}

const firstLine = (value: string): string => value.split("\n").slice(0, 2).join(" ").trim();
