#!/usr/bin/env node
import { readEnvFile, findRepositoryRoot, resolvePaths } from "./environment.js";
import { systemProbes, unitState } from "./probes.js";
import { runDoctor } from "./doctor.js";
import { applyPlan, planSetup } from "./setup.js";
import { exitCodeFor, renderReport } from "./report.js";
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
  nexus backup              sauvegarde complète (à venir)
  nexus restore <archive>   restauration (à venir)

Options de setup
  --dry-run                 affiche le plan sans rien écrire
  --rotate-keys             remplace la clé de signature existante
  --api-url <url>           base de l'API inscrite dans l'unité systemd

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
    case "restore":
      // Annoncé dans l'aide et pas encore implémenté : le dire franchement
      // vaut mieux qu'une commande qui existe et ne sauvegarde rien.
      process.stderr.write(
        `\`nexus ${command}\` n'est pas encore implémenté.\n` +
          "La sauvegarde et la restauration complètes sont le chantier suivant.\n" +
          "En attendant : `pg_dump` pour PostgreSQL, et l'API `backup` de SQLite\n" +
          "pour la base du moteur — une copie de fichier est incohérente tant que\n" +
          "le WAL est actif.\n",
      );
      return 1;
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
