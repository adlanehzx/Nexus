#!/usr/bin/env node
import { readEnvFile, findRepositoryRoot, resolvePaths } from "./environment.js";
import { systemProbes, unitState } from "./probes.js";
import { runDoctor } from "./doctor.js";
import { applyPlan, planSetup } from "./setup.js";
import { exitCodeFor, renderReport } from "./report.js";
import { createBackup, restoreBackup, verifyBackup } from "./backup.js";
import { BROWSER_UNIT, MISSION_ENGINE_UNIT } from "./systemd.js";

/**
 * `nexus` — installation, diagnostic et conduite d'une instance.
 *
 * Une CLI plutôt qu'un document d'installation, parce que la configuration
 * manuelle de NEXUS a un coût mesurable : des chemins absolus dans une unité
 * systemd, une clé éphémère qui désactive silencieusement l'authentification
 * entre services, une base en retard de migration. Chacun de ces états
 * fonctionne *presque*, et c'est ce qui les rend coûteux.
 *
 * Pas de dépendance d'analyse d'arguments : la surface est petite et stable, et
 * un `switch` lisible vaut mieux qu'une bibliothèque de plus dans un projet qui
 * en compte déjà beaucoup.
 */

const USAGE = `nexus — installation, diagnostic et conduite d'une instance NEXUS

  nexus doctor              diagnostique l'installation et dit ce qui manque
  nexus setup [options]     met l'installation en conformité (idempotent)
  nexus start [service]     démarre les services (moteur, navigateur)
  nexus stop [service]      arrête les services
  nexus backup [options]    sauvegarde complète, avec rotation
  nexus restore <archive>   restaure une sauvegarde sur cette installation

Options de setup
  --dry-run                 affiche le plan sans rien écrire
  --rotate-keys             remplace la clé de signature existante
  --api-url <url>           base de l'API inscrite dans l'unité systemd

Options de backup
  --passphrase <mot>        chiffre l'archive (AES-256-GCM, scrypt)
  --include-secrets         inclut .env — à n'utiliser qu'avec --passphrase
  --keep <n>                archives conservées par la rotation (défaut 7)
  --verify <archive>        vérifie qu'une archive est restaurable, sans rien
                            restaurer sur cette installation

Options de restore
  --passphrase <mot>        déchiffre l'archive
  --yes                     confirme l'écrasement des données existantes

Codes de sortie
  0  tout va bien
  1  au moins une vérification en échec, ou une action impossible
`;

type Command = "doctor" | "setup" | "start" | "stop" | "backup" | "restore" | "help";

async function main(argv: string[]): Promise<number> {
  const [rawCommand = "help", ...rest] = argv;
  const command = normaliseCommand(rawCommand);

  if (command === "help") {
    process.stdout.write(USAGE);
    return rawCommand === "help" || rawCommand === "--help" || rawCommand === "-h" ? 0 : 1;
  }

  const root = findRepositoryRoot(process.cwd());
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
  }
}

async function doctorCommand(paths: ReturnType<typeof resolvePaths>): Promise<number> {
  const env = readEnvFile(paths.envFile);
  process.stdout.write(`\nNEXUS — diagnostic\n  installation : ${paths.root}\n`);
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
  const apiUrl = valueOf(args, "--api-url");

  // Résolu ici parce que c'est la seule partie asynchrone : le planificateur
  // reste synchrone, donc testable sans machine.
  const pnpmPath = (await systemProbes.command("sh", ["-c", "command -v pnpm"])) ?? "pnpm";

  const plan = planSetup({
    paths,
    dryRun,
    rotateKeys,
    pnpmPath,
    ...(apiUrl === undefined ? {} : { apiUrl }),
  });

  process.stdout.write(`\nNEXUS — ${dryRun ? "plan d'installation" : "installation"}\n`);
  process.stdout.write(`  installation : ${paths.root}\n\n`);

  for (const action of plan.actions) {
    const mark = action.needed ? (dryRun ? "·" : "→") : "✓";
    const suffix = action.needed ? "" : " (déjà en place)";
    process.stdout.write(
      `  ${mark} ${action.label}${suffix}${action.detail === undefined ? "" : `\n      ${action.detail}`}\n`,
    );
  }

  if (!dryRun) {
    const { applied, skipped } = applyPlan(plan);
    process.stdout.write(
      `\n${applied.length} action(s) appliquée(s), ${skipped.length} inchangée(s)\n`,
    );
    if (applied.length > 0) {
      process.stdout.write(
        "\nRecharger systemd pour que les unités réécrites soient prises en compte :\n" +
          "  systemctl --user daemon-reload && nexus start\n",
      );
    }
  }

  for (const warning of plan.warnings) process.stdout.write(`\n  ! ${warning}\n`);
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
      process.stderr.write("DATABASE_URL absent : impossible de vérifier une restauration.\n");
      return 1;
    }
    process.stdout.write(`\nNEXUS — vérification de ${verifyTarget}\n\n`);
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
    process.stderr.write("--keep attend un entier supérieur ou égal à 1.\n");
    return 1;
  }

  const outcome = await createBackup({
    paths,
    includeSecrets: args.includes("--include-secrets"),
    keep,
    ...(passphrase === undefined ? {} : { passphrase }),
  });

  process.stdout.write(`\nNEXUS — sauvegarde\n  ${outcome.path}\n\n`);
  for (const entry of outcome.manifest.entries) {
    process.stdout.write(`  ✓ ${entry.name.padEnd(42)} ${formatBytes(entry.bytes)}\n`);
  }
  if (outcome.rotated.length > 0) {
    process.stdout.write(
      `\n  ${outcome.rotated.length} archive(s) plus ancienne(s) supprimée(s)\n`,
    );
  }
  for (const warning of outcome.warnings) process.stdout.write(`\n  ! ${warning}\n`);
  process.stdout.write(
    `\nVérifier qu'elle est restaurable :\n  nexus backup --verify ${outcome.path}\n\n`,
  );
  return 0;
}

async function restoreCommand(
  paths: ReturnType<typeof resolvePaths>,
  args: string[],
): Promise<number> {
  const archive = args.find((arg) => !arg.startsWith("-"));
  if (archive === undefined) {
    process.stderr.write("usage : nexus restore <archive> [--passphrase <mot>] --yes\n");
    return 1;
  }
  if (!args.includes("--yes")) {
    // Une restauration écrase des données vivantes. Exiger un accord explicite
    // plutôt qu'une question interactive : la commande reste utilisable depuis
    // un script, et personne ne la lance par réflexe.
    process.stderr.write(
      "La restauration remplace la base PostgreSQL et celle du moteur.\n" +
        "Relancer avec --yes pour confirmer.\n",
    );
    return 1;
  }

  const passphrase = valueOf(args, "--passphrase");
  const outcome = await restoreBackup(archive, {
    paths,
    ...(passphrase === undefined ? {} : { passphrase }),
  });

  process.stdout.write(`\nNEXUS — restauration de ${archive}\n\n`);
  for (const item of outcome.applied) process.stdout.write(`  ✓ ${item}\n`);
  for (const item of outcome.skipped) process.stdout.write(`  – ${item}\n`);
  for (const warning of outcome.warnings) process.stdout.write(`\n  ! ${warning}\n`);
  process.stdout.write("\nPuis :\n  nexus doctor\n\n");
  return 0;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Kio`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mio`;
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
      process.stdout.write(`  ✗ ${unit} — ${action} sans effet\n`);
      process.stdout.write(`      → journalctl --user -u ${unit} -n 30\n`);
      continue;
    }
    process.stdout.write(`  ✓ ${unit} — ${state.active ? "active" : "arrêtée"}\n`);
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
