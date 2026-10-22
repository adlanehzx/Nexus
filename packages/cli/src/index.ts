#!/usr/bin/env node
import { readEnvFile, findRepositoryRoot, resolvePaths } from "./environment.js";
import { systemProbes, unitState } from "./probes.js";
import { runDoctor } from "./doctor.js";
import { applyPlan, planSetup } from "./setup.js";
import { exitCodeFor, renderReport } from "./report.js";
import { createBackup, restoreBackup, verifyBackup } from "./backup.js";
import { policyCommand } from "./policy.js";
import { voiceCommand } from "./voice.js";
import { BROWSER_UNIT, MISSION_ENGINE_UNIT } from "./systemd.js";
import { checkPrerequisites } from "./prerequisites.js";
import { detectTailscale } from "./tailscale.js";

/**
 * `nexus` — installation, diagnostics, and management of a NEXUS instance.
 */

const USAGE = `nexus — installation, diagnostics, and management of a NEXUS instance

  nexus doctor              diagnoses the installation and reports actionable issues
  nexus setup [options]     brings installation into compliance (idempotent, safe)
  nexus start [service]     starts services (engine, browser)
  nexus stop [service]      stops services
  nexus backup [options]    complete backup with automated rotation
  nexus restore <archive>   restores a backup onto this installation
  nexus policy [init|show|check]
                            local device policy management
  nexus voice [check|dictate]
                            local voice dictation and synthesis

Common Options
  --root <path>             target installation root instead of current directory

Setup Options
  --mode <docker|dev>       target environment (default: docker)
  --dry-run                 preview execution plan without writing changes
  --rotate-keys             regenerate existing persistent signing key
  --api-url <url>           API base URL configured in systemd unit and .env
  --tailscale               automatically detect and propose Tailscale IP for PUBLIC_API_URL
  --admin-email <email>     initial administrator email for onboarding guidance

Backup Options
  --passphrase <word>       encrypt archive (AES-256-GCM, scrypt)
  --include-secrets         include .env — only use with --passphrase
  --keep <n>                number of archives retained by rotation (default 7)
  --verify <archive>        verifies archive integrity without restoring

Restore Options
  --passphrase <word>       decrypts archive
  --yes                     confirms overwriting existing databases and state

Exit Codes
  0  all checks passed
  1  one or more checks failed, or operation could not be completed
`;

type Command =
  "doctor" | "setup" | "start" | "stop" | "backup" | "restore" | "policy" | "voice" | "help";

async function main(argv: string[]): Promise<number> {
  const [rawCommand = "help", ...rest] = argv;
  const command = normaliseCommand(rawCommand);

  if (command === "help") {
    process.stdout.write(USAGE);
    return rawCommand === "help" || rawCommand === "--help" || rawCommand === "-h" ? 0 : 1;
  }

  const explicitRoot = valueOf(rest, "--root");
  const root = explicitRoot ?? findRepositoryRoot(process.cwd());
  const paths = resolvePaths(root);

  switch (command) {
    case "doctor":
      return doctorCommand(paths);
    case "setup":
      return setupCommand(paths, rest);
    case "start":
      return serviceCommand("start", rest);
    case "stop":
      return serviceCommand("stop", rest);
    case "backup":
      return backupCommand(paths, rest);
    case "restore":
      return restoreCommand(paths, rest);
    case "policy":
      return policyCommand(rest);
    case "voice":
      return voiceCommand(rest);
  }
}

async function doctorCommand(paths: ReturnType<typeof resolvePaths>): Promise<number> {
  const env = readEnvFile(paths.envFile);
  process.stdout.write(`\nNEXUS — diagnostics\n  installation: ${paths.root}\n`);
  const groups = await runDoctor({ paths, probes: systemProbes, env });
  process.stdout.write(`${renderReport(groups)}\n`);
  return exitCodeFor(groups);
}

async function setupCommand(
  paths: ReturnType<typeof resolvePaths>,
  args: string[],
): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const rotateKeys = args.includes("--rotate-keys");
  const rawApiUrl = valueOf(args, "--api-url");
  const rawMode = valueOf(args, "--mode");
  const mode = rawMode === "dev" ? "dev" : "docker";
  const useTailscale = args.includes("--tailscale") || args.includes("--use-tailscale");
  const adminEmail = valueOf(args, "--admin-email");
  const adminPassword = valueOf(args, "--admin-password");

  process.stdout.write(`\nNEXUS — ${dryRun ? "setup plan" : "setup"}\n`);
  process.stdout.write(`  installation: ${paths.root}\n\n`);

  // 1. Verify prerequisites
  const prereqs = await checkPrerequisites(async (cmd, cmdArgs) => {
    const stdout = await systemProbes.command(cmd, cmdArgs);
    return { stdout: stdout ?? "", exitCode: stdout !== undefined ? 0 : 1 };
  });

  process.stdout.write("Prerequisites\n");
  process.stdout.write(
    `  ${prereqs.nodeVersion.meetsRequirement ? "✓" : "✗"} Node.js ${prereqs.nodeVersion.current} (${prereqs.nodeVersion.required})\n`,
  );
  if (!prereqs.nodeVersion.meetsRequirement) {
    process.stderr.write(
      "  Error: Node.js version >= 22.13.0 is required. Please update Node before proceeding.\n",
    );
    return 1;
  }

  if (prereqs.pnpm.installed) {
    process.stdout.write(`  ✓ pnpm ${prereqs.pnpm.version}\n`);
  }
  if (mode === "docker") {
    process.stdout.write(
      `  ${prereqs.docker.daemonRunning ? "✓" : "!"} Docker: ${prereqs.docker.details ?? "not running"}\n`,
    );
    if (!prereqs.docker.daemonRunning) {
      process.stdout.write(
        "      → Start Docker daemon or run with '--mode dev' for local process execution\n",
      );
    }
  }

  // 2. Tailscale discovery
  let tailscaleUrl: string | undefined;
  if (useTailscale || rawApiUrl === undefined) {
    const tailscaleExec = async (cmd: string, cmdArgs: string[]) => {
      const stdout = await systemProbes.command(cmd, cmdArgs);
      return { stdout: stdout ?? "", stderr: "", exitCode: stdout !== undefined ? 0 : 1 };
    };
    const tailscale = await detectTailscale(tailscaleExec);
    if (tailscale.running && tailscale.suggestedUrl) {
      if (useTailscale) {
        tailscaleUrl = tailscale.suggestedUrl;
        process.stdout.write(`  ✓ Tailscale active: using ${tailscaleUrl} for PUBLIC_API_URL\n`);
      } else {
        process.stdout.write(
          `  ! Tailscale detected (${tailscale.ip}): pass '--tailscale' to configure remote access\n`,
        );
      }
    }
  }

  const pnpmPath = (await systemProbes.command("sh", ["-c", "command -v pnpm"])) ?? "pnpm";

  const plan = planSetup({
    paths,
    dryRun,
    rotateKeys,
    pnpmPath,
    mode,
    ...(rawApiUrl !== undefined ? { apiUrl: rawApiUrl } : {}),
    ...(tailscaleUrl !== undefined ? { tailscaleUrl } : {}),
    ...(adminEmail !== undefined ? { adminEmail } : {}),
    ...(adminPassword !== undefined ? { adminPassword } : {}),
  });

  process.stdout.write("\nConfiguration and secrets\n");
  for (const action of plan.actions) {
    const mark = action.needed ? (dryRun ? "·" : "→") : "✓";
    const suffix = action.needed ? "" : " (already configured)";
    process.stdout.write(
      `  ${mark} ${action.label}${suffix}${action.detail === undefined ? "" : `\n      ${action.detail}`}\n`,
    );
  }

  if (!dryRun) {
    const { applied, skipped } = applyPlan(plan);
    process.stdout.write(`\n${applied.length} action(s) applied, ${skipped.length} unchanged\n`);
  }

  for (const warning of plan.warnings) process.stdout.write(`\n  ! ${warning}\n`);

  process.stdout.write("\nNext steps to run NEXUS:\n");
  for (const step of plan.summary.nextSteps) {
    process.stdout.write(`  • ${step}\n`);
  }
  process.stdout.write("\n");
  return 0;
}

async function backupCommand(
  paths: ReturnType<typeof resolvePaths>,
  args: string[],
): Promise<number> {
  const passphrase = valueOf(args, "--passphrase");
  const verifyTarget = valueOf(args, "--verify");

  if (verifyTarget !== undefined) {
    const databaseUrl = readEnvFile(paths.envFile).DATABASE_URL;
    if (databaseUrl === undefined) {
      process.stderr.write("DATABASE_URL missing: cannot verify restoration target.\n");
      return 1;
    }
    process.stdout.write(`\nNEXUS — verification of ${verifyTarget}\n\n`);
    const { checks } = await verifyBackup(verifyTarget, {
      databaseUrl,
      ...(passphrase === undefined ? {} : { passphrase }),
    });
    for (const check of checks) {
      process.stdout.write(`  ${check.ok ? "✓" : "✗"} ${check.name} — ${check.detail}\n`);
    }
    process.stdout.write("\n");
    return checks.every((check) => check.ok) ? 0 : 1;
  }

  const keepRaw = valueOf(args, "--keep");
  const keep = keepRaw === undefined ? 7 : Number(keepRaw);
  if (!Number.isInteger(keep) || keep < 1) {
    process.stderr.write("--keep requires an integer >= 1.\n");
    return 1;
  }

  const outcome = await createBackup({
    paths,
    includeSecrets: args.includes("--include-secrets"),
    keep,
    ...(passphrase === undefined ? {} : { passphrase }),
  });

  process.stdout.write(`\nNEXUS — backup\n  ${outcome.path}\n\n`);
  for (const entry of outcome.manifest.entries) {
    process.stdout.write(`  ✓ ${entry.name.padEnd(42)} ${formatBytes(entry.bytes)}\n`);
  }
  if (outcome.rotated.length > 0) {
    process.stdout.write(`\n  ${outcome.rotated.length} older archive(s) pruned\n`);
  }
  for (const warning of outcome.warnings) process.stdout.write(`\n  ! ${warning}\n`);
  process.stdout.write(
    `\nVerify restorable integrity with:\n  nexus backup --verify ${outcome.path}\n\n`,
  );
  return 0;
}

async function restoreCommand(
  paths: ReturnType<typeof resolvePaths>,
  args: string[],
): Promise<number> {
  const archive = args.find((arg) => !arg.startsWith("-"));
  if (archive === undefined) {
    process.stderr.write("usage: nexus restore <archive> [--passphrase <word>] --yes\n");
    return 1;
  }
  if (!args.includes("--yes")) {
    process.stderr.write(
      "Restoration overwrites the PostgreSQL database and Mission Engine database.\n" +
        "Rerun with --yes to confirm.\n",
    );
    return 1;
  }

  const passphrase = valueOf(args, "--passphrase");
  const outcome = await restoreBackup(archive, {
    paths,
    ...(passphrase === undefined ? {} : { passphrase }),
  });

  process.stdout.write(`\nNEXUS — restoring ${archive}\n\n`);
  for (const item of outcome.applied) process.stdout.write(`  ✓ ${item}\n`);
  for (const item of outcome.skipped) process.stdout.write(`  – ${item}\n`);
  for (const warning of outcome.warnings) process.stdout.write(`\n  ! ${warning}\n`);
  process.stdout.write("\nNext step:\n  nexus doctor\n\n");
  return 0;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const UNITS: Record<string, string> = {
  engine: MISSION_ENGINE_UNIT,
  moteur: MISSION_ENGINE_UNIT,
  browser: BROWSER_UNIT,
  navigateur: BROWSER_UNIT,
};

async function serviceCommand(action: "start" | "stop", args: string[]): Promise<number> {
  const requested = args.filter((arg) => !arg.startsWith("-"));
  const units =
    requested.length === 0
      ? [MISSION_ENGINE_UNIT, BROWSER_UNIT]
      : requested.map((name) => UNITS[name] ?? name);

  let failures = 0;
  for (const unit of units) {
    const result = await systemProbes.command("systemctl", ["--user", action, unit], 30_000);
    const state = await unitState(systemProbes, unit);
    const expected = action === "start" ? state.active : !state.active;

    if (result === undefined || !expected) {
      failures += 1;
      process.stdout.write(`  ✗ ${unit} — ${action} failed\n`);
      process.stdout.write(`      → journalctl --user -u ${unit} -n 30\n`);
      continue;
    }
    process.stdout.write(`  ✓ ${unit} — ${state.active ? "active" : "stopped"}\n`);
  }
  return failures > 0 ? 1 : 0;
}

function normaliseCommand(value: string): Command {
  switch (value) {
    case "doctor":
    case "setup":
    case "start":
    case "stop":
    case "backup":
    case "restore":
    case "policy":
    case "voice":
      return value;
    default:
      return "help";
  }
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
