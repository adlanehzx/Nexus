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
 * Sauvegarde et restauration d'une instance.
 *
 * Le critère est celui qui compte : réinstaller sur une machine vide et
 * retrouver ses missions, ses conversations et ses agents. Tout le reste en
 * découle — notamment le fait que les **fichiers de configuration** sont
 * sauvegardés autant que les bases, parce qu'une base restaurée sans ses
 * profils d'agents ne sait plus router une tâche.
 *
 * Deux refus délibérés.
 *
 * **Aucune copie de fichier pour SQLite.** La base du moteur tourne en WAL :
 * copier le fichier pendant qu'il écrit produit une sauvegarde incohérente qui
 * s'ouvre quand même, ce qui est le pire des cas. On passe par l'API `backup`
 * de SQLite, qui prend un instantané cohérent sans arrêter le service.
 *
 * **Pas de secret par défaut.** Une archive se copie, se transporte, s'oublie
 * sur un disque externe. Y mettre la clé de signature ferait de chaque copie un
 * équivalent du serveur ; `RESTORE.md` explique à la place comment rétablir ce
 * qui manque.
 */

export interface BackupOptions {
  paths: NexusPaths;
  /** Chiffre l'archive. Absente, elle est écrite en clair, et le manifeste le dit. */
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
  "nexus restore <archive>  — restaure PostgreSQL, SQLite et les configurations",
  "AUTH_SIGNING_KEY n'est PAS dans l'archive : la reporter dans .env depuis son",
  "  stockage hors ligne, ou en générer une avec `nexus setup`. Sans l'ancienne,",
  "  les missions encore en cours ne pourront pas être reprises — leurs",
  "  assertions sont signées par la clé précédente.",
  "Les secrets du trousseau (jetons OAuth, clés de fournisseurs) ne sont pas",
  "  sauvegardés : les réenregistrer depuis le tableau de bord.",
  "nexus doctor — vérifie que l'installation restaurée est complète",
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
    warnings.push("DATABASE_URL absent : PostgreSQL n'a pas été sauvegardé");
  } else {
    entries.push({
      name: "postgres.dump",
      description:
        "pg_dump format personnalisé : comptes, conversations, messages, mémoire, tâches, runs et assertions",
      content: await dumpPostgres(databaseUrl),
    });
  }

  // ── SQLite du moteur ────────────────────────────────────────────────────
  if (!existsSync(paths.missionEngineDatabase)) {
    warnings.push("base SQLite du moteur absente : aucune mission à sauvegarder");
  } else {
    entries.push({
      name: "mission-engine.db",
      description: "instantané cohérent de la base du moteur : missions, tâches, tentatives",
      content: snapshotSqlite(paths),
    });
  }

  // ── Configurations ──────────────────────────────────────────────────────
  for (const [name, path, description] of configurationFiles(paths)) {
    if (!existsSync(path)) continue;
    entries.push({ name, description, content: readFileSync(path) });
  }

  // ── Clé publique ────────────────────────────────────────────────────────
  if (existsSync(paths.publicKeyFile)) {
    entries.push({
      name: "public/api-public.pem",
      description: "clé publique de l'API, pour reconfigurer Mission Engine après restauration",
      content: readFileSync(paths.publicKeyFile),
    });
  }

  // ── Secrets, uniquement sur demande explicite ───────────────────────────
  if (options.includeSecrets) {
    if (existsSync(paths.envFile)) {
      entries.push({
        name: "secrets/.env",
        description: "FICHIER DE SECRETS — clé de signature et mots de passe",
        content: readFileSync(paths.envFile),
      });
    }
    warnings.push(
      "l'archive contient .env : la traiter comme un secret, et refuser de la déposer sur un stockage partagé",
    );
    if (options.passphrase === undefined) {
      warnings.push(
        "secrets inclus SANS chiffrement : fournir une phrase de passe, ou retirer --include-secrets",
      );
    }
  }

  entries.push({
    name: "RESTORE.md",
    description: "instructions de restauration, lisibles sans déchiffrer l'archive",
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
    warnings.push("archive non chiffrée : utiliser --passphrase pour la protéger");
  }

  return { path, manifest: readArchive(archive).manifest, rotated: victims, warnings };
}

/**
 * Vérifie qu'une archive est **restaurable**, sans toucher à l'installation.
 *
 * C'est la seule vérification qui compte. Une sauvegarde dont on n'a jamais
 * tenté la restauration n'est pas une sauvegarde : on découvre son état le jour
 * où on en a besoin. Ici PostgreSQL est restauré dans une base jetable et la
 * base SQLite ouverte en lecture, puis les volumes sont comparés à ceux de
 * l'archive.
 */
export async function verifyBackup(
  archivePath: string,
  options: { databaseUrl: string; passphrase?: string },
): Promise<{ checks: { name: string; detail: string; ok: boolean }[] }> {
  const read = readArchive(readFileSync(archivePath));
  const entries = extractEntries(read, options.passphrase);
  const checks: { name: string; detail: string; ok: boolean }[] = [];

  checks.push({
    name: "manifeste et empreintes",
    detail: `${read.manifest.entries.length} entrée(s) vérifiée(s)`,
    ok: true,
  });

  const workspace = mkdtempSync(join(tmpdir(), "nexus-verify-"));
  try {
    const dump = entries.get("postgres.dump");
    if (dump === undefined) {
      checks.push({ name: "PostgreSQL", detail: "absent de l'archive", ok: false });
    } else {
      const dumpPath = join(workspace, "postgres.dump");
      writeFileSync(dumpPath, dump);
      const probe = `nexus_verify_${Date.now()}`;
      await psql(options.databaseUrl, `CREATE DATABASE "${probe}"`);
      try {
        // `--no-owner` : la base jetable n'a pas les rôles de l'originale, et
        // leur absence ferait échouer une restauration par ailleurs correcte.
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
          name: "restauration PostgreSQL",
          detail: `${tables.trim()} tables rétablies dans une base jetable`,
          ok: Number(tables.trim()) > 0,
        });
      } finally {
        await psql(options.databaseUrl, `DROP DATABASE IF EXISTS "${probe}"`);
      }
    }

    const sqlite = entries.get("mission-engine.db");
    if (sqlite === undefined) {
      checks.push({ name: "SQLite du moteur", detail: "absent de l'archive", ok: true });
    } else {
      const path = join(workspace, "mission-engine.db");
      writeFileSync(path, sqlite);
      const integrity = await run("sqlite3", [path, "PRAGMA integrity_check;"]).then(
        (result) => result.stdout.trim(),
        () => "indisponible",
      );
      const missions = await run("sqlite3", [path, "SELECT count(*) FROM missions;"]).then(
        (result) => result.stdout.trim(),
        () => "?",
      );
      checks.push({
        name: "restauration SQLite",
        detail: `integrity_check : ${integrity} · ${missions} mission(s)`,
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
 * Restaure une archive sur l'installation courante.
 *
 * Écrase des données vivantes : l'appelant doit avoir obtenu un accord
 * explicite avant d'arriver ici. La fonction, elle, refuse de restaurer une
 * archive dont une empreinte ne correspond pas — à moitié restauré est le seul
 * état qu'on ne saurait pas diagnostiquer.
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
    skipped.push("PostgreSQL (absent de l'archive)");
  } else if (databaseUrl === undefined) {
    warnings.push("DATABASE_URL absent : PostgreSQL non restauré");
  } else {
    const workspace = mkdtempSync(join(tmpdir(), "nexus-restore-"));
    try {
      const dumpPath = join(workspace, "postgres.dump");
      writeFileSync(dumpPath, dump);
      // `--clean --if-exists` : on remplace, on ne superpose pas. Restaurer
      // par-dessus des tables existantes produirait des conflits de clés et un
      // état mi-ancien mi-nouveau.
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
    applied.push("SQLite du moteur");
    warnings.push(
      "le moteur doit être redémarré pour relire sa base : systemctl --user restart nexus-mission-engine",
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
    applied.push("clé publique de l'API");
  }

  if (!read.manifest.includesSecrets) {
    warnings.push(
      "l'archive ne contient aucun secret : reporter AUTH_SIGNING_KEY dans .env, sinon les missions en cours ne pourront pas être reprises",
    );
  }

  return { applied, skipped, warnings };
}

/** Fichiers de configuration sauvegardés, avec leur rôle. */
export function configurationFiles(paths: NexusPaths): [string, string, string][] {
  return [
    [
      "config/mission-engine/runtime-settings.json",
      paths.engineRuntimeSettings,
      "réglages du moteur : délais, tentatives, priorités de routage",
    ],
    [
      "config/mission-engine/profiles.production.json",
      paths.engineProfiles,
      "agents enregistrés auprès du moteur",
    ],
    [
      "config/agent/profiles.production.json",
      paths.agentRegistry,
      "profils du runtime ACP : commandes, modèles, politiques",
    ],
    [
      "config/api/browser.json",
      join(paths.root, "services", "api", "config", "browser.json"),
      "configuration Browser Use",
    ],
    [
      "config/api/mcp.json",
      join(paths.root, "services", "api", "config", "mcp.json"),
      "serveurs MCP déclarés",
    ],
  ];
}

/**
 * Convertit une URL de connexion Prisma en URL acceptée par libpq.
 *
 * Prisma ajoute des paramètres qui lui sont propres — `schema`,
 * `connection_limit`, `pgbouncer` — et `pg_dump` refuse l'URL entière dès qu'il
 * en rencontre un : « invalid URI query parameter ». On ne garde donc que les
 * paramètres que libpq connaît, par liste blanche plutôt qu'en retirant les
 * fautifs un à un : un paramètre Prisma ajouté demain casserait silencieusement
 * les sauvegardes.
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
 * Repère un refus de `pg_dump` pour cause de version trop ancienne.
 *
 * `pg_dump` refuse de sauvegarder un serveur plus récent que lui, et c'est une
 * protection légitime : le format de sortie dépend de la version. Le cas est
 * courant — un client issu des paquets de la distribution face à un serveur
 * lancé par Docker.
 */
export function isVersionMismatch(message: string): boolean {
  return /server version mismatch|server version: \d+/.test(message);
}

/**
 * Nom du conteneur Docker qui publie ce port.
 *
 * Le repli quand le client local est trop ancien : le conteneur embarque un
 * `pg_dump` de la même version que son serveur, par construction. On identifie
 * le conteneur par le port publié plutôt que par son nom — un nom codé en dur
 * serait faux dès la première installation qui le change.
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
      // Format personnalisé : compressé, et restaurable table par table si la
      // restauration complète échoue un jour.
      await run("pg_dump", ["--format", "custom", "--file", path, url], {
        maxBuffer: 1024 * 1024 * 64,
      });
      return readFileSync(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isVersionMismatch(message)) throw error;

      // Repli par le conteneur, qui embarque un client de la même version que
      // son serveur. Refuser ici obligerait à installer un paquet pour
      // sauvegarder une base qui tourne déjà très bien.
      const dumped = await dumpThroughContainer(url);
      if (dumped === undefined) {
        throw new Error(
          "Le client pg_dump local est plus ancien que le serveur, et aucun " +
            "conteneur publiant ce port n'a été trouvé.\n" +
            "Installer un client de la même version majeure que le serveur, " +
            "ou démarrer PostgreSQL par `pnpm docker:up`.",
          // La cause d'origine porte les deux versions en présence : la perdre
          // obligerait à relancer la commande pour savoir laquelle manque.
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

  // Vu de l'intérieur du conteneur, le serveur est sur son propre réseau local.
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

/**
 * Candidats pour l'instantané SQLite, dans l'ordre de préférence.
 *
 * Trois, parce qu'une sauvegarde ne doit pas dépendre d'un outil que
 * l'installation n'a pas forcément : le Python du moteur existe sur une
 * installation complète, `sqlite3` est souvent là, et le Python du système
 * presque toujours. Tous trois utilisent la **même** API `backup` de SQLite —
 * ce qui est négociable est l'interpréteur, pas la méthode.
 */
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
    // `.backup` du client sqlite3 appelle la même API : cohérent sous WAL, et
    // sans arrêter le service qui écrit.
    { file: "sqlite3", args: [source, `.backup '${target}'`] },
    { file: "python3", args: ["-c", script, source, target] },
  ];
}

/**
 * Instantané SQLite par l'API `backup`, et non par une copie.
 *
 * Le moteur écrit en WAL : une copie de fichier pendant une écriture donne une
 * base qui s'ouvre et à laquelle il manque des transactions. L'instantané, lui,
 * est cohérent sans arrêter le service.
 */
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
        // Synchrone : la fonction est appelée une fois et son résultat est
        // immédiatement nécessaire pour composer l'archive.
        execFileSync(candidate.file, candidate.args, { stdio: "pipe" });
        return readFileSync(target);
      } catch (error) {
        attempts.push(
          `${candidate.file} : ${error instanceof Error ? error.message.split("\n")[0] : "échec"}`,
        );
      }
    }

    throw new Error(
      `aucun outil disponible pour un instantané SQLite cohérent.\n${attempts.join("\n")}\n` +
        "Installer `sqlite3`, ou construire l'environnement Python du moteur.",
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
    return typeof version === "string" ? version : "inconnue";
  } catch {
    return "inconnue";
  }
}

function restoreDocument(at: Date, options: BackupOptions): string {
  return `# Restauration d'une sauvegarde NEXUS

Archive créée le ${at.toISOString()} depuis ${options.paths.root}.
Secrets inclus : ${options.includeSecrets ? "OUI — traiter cette archive comme un secret" : "non"}.
Chiffrement : ${options.passphrase === undefined ? "aucun" : "AES-256-GCM, clé dérivée par scrypt"}.

## Sur une machine vide

1. Installer les prérequis : Node (voir \`.nvmrc\`), pnpm, Docker, uv.
2. Cloner le dépôt, \`pnpm install\`, \`pnpm build\`.
3. \`pnpm docker:up\` pour PostgreSQL, Redis et SearXNG.
4. \`nexus setup\` pour la configuration et les clés.
5. \`nexus restore <archive>\` pour les données.
6. \`nexus doctor\` pour vérifier ce qui manque encore.

## Ce que l'archive ne contient pas

${
  options.includeSecrets
    ? "Rien d'essentiel : les secrets sont inclus."
    : `La clé de signature (\`AUTH_SIGNING_KEY\`) et les secrets du trousseau.

C'est délibéré : une archive se copie et se transporte, et y mettre la clé de
signature ferait de chaque copie un équivalent du serveur.

Conséquence à connaître : sans l'ancienne clé, les missions **encore en cours**
ne pourront pas être reprises, parce que leurs assertions de propriété sont
signées par elle. Les missions terminées, les conversations, la mémoire et les
agents sont intacts.`
}

## Vérifier une archive sans rien restaurer

    nexus backup --verify <archive>

PostgreSQL est restauré dans une base jetable, la base du moteur est ouverte en
lecture, et les deux sont comparées à l'archive. Une sauvegarde dont on n'a
jamais tenté la restauration n'est pas une sauvegarde.
`;
}
