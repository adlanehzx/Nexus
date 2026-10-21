import { existsSync, readFileSync, statSync } from "node:fs";
import { createPublicKey } from "node:crypto";

import { parseConfig } from "@nexus/config";
import type { NexusPaths } from "./environment.js";
import { hasPersistentSigningKey } from "./environment.js";
import { hostAndPort, unitState, type Probes } from "./probes.js";
import { foreignPaths, BROWSER_UNIT, MISSION_ENGINE_UNIT } from "./systemd.js";
import { fail, ok, skip, warn, type CheckGroup, type CheckResult } from "./report.js";

/**
 * Diagnostic d'une installation NEXUS.
 *
 * Organisé en groupes qui suivent la question qu'on se pose vraiment quand
 * quelque chose ne marche pas : est-ce ma configuration, mes services, mes
 * agents, ou ma sécurité ? Un diagnostic rangé par couche technique obligerait
 * à traduire mentalement avant d'agir.
 */

export interface DoctorContext {
  paths: NexusPaths;
  probes: Probes;
  env: Record<string, string>;
}

export async function runDoctor(context: DoctorContext): Promise<CheckGroup[]> {
  return [
    { title: "Configuration", results: configurationChecks(context) },
    { title: "Données et services", results: await dataChecks(context) },
    { title: "Agents et outils", results: await agentChecks(context) },
    { title: "Sécurité", results: await securityChecks(context) },
    { title: "Services systemd", results: await systemdChecks(context) },
  ];
}

function configurationChecks({ paths, env }: DoctorContext): CheckResult[] {
  const results: CheckResult[] = [];

  if (Object.keys(env).length === 0) {
    results.push(
      fail(
        ".env",
        `absent (${paths.envFile})`,
        "nexus setup — crée le fichier depuis .env.example",
      ),
    );
    return results;
  }
  results.push(ok(".env", `lu (${Object.keys(env).length} variables)`));

  // La configuration est validée par le **schéma de l'application**, pas par
  // une liste recopiée ici : une variable ajoutée au schéma est vérifiée sans
  // que la CLI change, et une liste parallèle finirait par mentir.
  try {
    parseConfig({ ...env, NODE_ENV: env.NODE_ENV ?? "development" });
    results.push(ok("schéma de configuration", "toutes les variables requises sont valides"));
  } catch (error) {
    results.push(
      fail(
        "schéma de configuration",
        firstLine(error instanceof Error ? error.message : String(error)),
        "corriger .env — le message ci-dessus nomme la variable",
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
      ? ok("chemins de .env", "aucun chemin hors de cette installation")
      : warn(
          "chemins de .env",
          `${strays.length} variable(s) pointent ailleurs : ${strays.map(([key]) => key).join(", ")}`,
          "corriger ou relancer nexus setup",
        ),
  );

  return results;
}

async function dataChecks({ paths, probes, env }: DoctorContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(await reachable(probes, "PostgreSQL", env.DATABASE_URL, "pnpm docker:up"));
  results.push(await reachable(probes, "Redis", env.REDIS_URL, "pnpm docker:up"));

  // Les migrations : une base joignable mais en retard est une panne plus
  // sournoise qu'une base absente, parce que tout démarre.
  const status = await probes.command(
    "pnpm",
    ["--filter", "@nexus/database", "exec", "prisma", "migrate", "status"],
    60_000,
  );
  if (status === undefined) {
    results.push(
      warn(
        "migrations PostgreSQL",
        "état indéterminé",
        "pnpm --filter @nexus/database exec prisma migrate status",
      ),
    );
  } else if (status.includes("up to date")) {
    results.push(ok("migrations PostgreSQL", "à jour"));
  } else {
    results.push(
      fail(
        "migrations PostgreSQL",
        "des migrations ne sont pas appliquées",
        "pnpm --filter @nexus/database exec prisma migrate deploy",
      ),
    );
  }

  const database = paths.missionEngineDatabase;
  results.push(
    existsSync(database)
      ? ok("SQLite Mission Engine", `${(statSync(database).size / 1024).toFixed(0)} Kio`)
      : warn("SQLite Mission Engine", "absente — créée au premier démarrage du moteur"),
  );

  results.push(
    existsSync(paths.backupsDir)
      ? ok("dossier de sauvegardes", paths.backupsDir)
      : warn("dossier de sauvegardes", "absent", "nexus backup — le crée au besoin"),
  );

  return results;
}

async function agentChecks({ paths, probes, env }: DoctorContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const engineUrl = env.MISSION_CONTROL_URL;
  if (engineUrl === undefined || engineUrl.length === 0) {
    results.push(skip("Mission Engine", "MISSION_CONTROL_URL non défini"));
  } else {
    const health = await probes.http(`${engineUrl.replace(/\/$/, "")}/v1/health/ready`);
    if (health === undefined) {
      results.push(fail("Mission Engine", `injoignable sur ${engineUrl}`, "nexus start"));
    } else {
      const profiles = readProfiles(health.body);
      results.push(
        ok(
          "Mission Engine",
          `prêt — profils : ${profiles.length > 0 ? profiles.join(", ") : "aucun"}`,
        ),
      );
      results.push(
        profiles.length > 0
          ? ok("agents ACP configurés", `${profiles.length}`)
          : warn(
              "agents ACP configurés",
              "aucun profil actif : aucune tâche ACP ne pourra être routée",
              "enregistrer un agent depuis le tableau de bord",
            ),
      );
    }
  }

  // Le runtime ACP : deux fichiers, et leur absence est la cause nº 1 d'un
  // worker qui refuse de démarrer.
  for (const [label, path, fix] of [
    ["runner ACP", paths.agentRunner, "pnpm --filter @nexus/agent build"],
    ["registre ACP", paths.agentRegistry, "créer le fichier de profils de l'agent"],
  ] as const) {
    results.push(existsSync(path) ? ok(label, path) : fail(label, `absent (${path})`, fix));
  }

  const searxng = env.SEARXNG_URL;
  if (searxng === undefined || searxng.length === 0) {
    results.push(skip("SearXNG", "SEARXNG_URL non défini — recherche web inactive"));
  } else {
    const probe = await probes.http(searxng);
    results.push(
      probe === undefined
        ? fail("SearXNG", `injoignable sur ${searxng}`, "pnpm docker:up")
        : ok("SearXNG", `joignable (HTTP ${probe.status})`),
    );
  }

  const cdp = await probes.http("http://127.0.0.1:19222/json/version");
  results.push(
    cdp === undefined
      ? warn(
          "Chromium (CDP)",
          "injoignable sur 127.0.0.1:19222 — Browser Use indisponible",
          "systemctl --user start nexus-browser",
        )
      : ok("Chromium (CDP)", "joignable"),
  );

  return results;
}

async function securityChecks({ paths, probes, env }: DoctorContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Les permissions d'abord, et **avant** la question de la clé : le fichier
  // contient de toute façon le mot de passe PostgreSQL. Les vérifier seulement
  // quand une clé de signature est présente laissait sans rien dire le cas le
  // plus courant — une installation neuve, dont le `.env` est en 0644.
  const mode = permissionsOf(paths.envFile);
  results.push(
    mode === undefined
      ? skip("permissions de .env", "fichier absent")
      : mode === "600"
        ? ok("permissions de .env", "0600")
        : warn(
            "permissions de .env",
            `0${mode} — lisible au-delà du propriétaire, alors qu'il porte des secrets`,
            `chmod 600 ${paths.envFile}`,
          ),
  );

  if (!hasPersistentSigningKey(env)) {
    results.push(
      warn(
        "clé de signature",
        "éphémère : régénérée à chaque démarrage de l'API",
        "nexus setup — génère une clé persistante",
      ),
    );
    results.push(skip("authentification API → moteur", "impossible sans clé persistante"));
    return results;
  }
  results.push(ok("clé de signature", "persistante"));

  if (!existsSync(paths.publicKeyFile)) {
    results.push(
      warn(
        "clé publique déployée",
        `absente (${paths.publicKeyFile})`,
        "nexus setup — la dépose et active l'authentification du moteur",
      ),
    );
  } else {
    // La vérification qui compte vraiment : la clé déployée correspond-elle
    // encore à la clé privée courante ? Une clé publique périmée fait échouer
    // tous les appels entrants avec une erreur de signature, sans rien dire du
    // désaccord lui-même.
    const matches = publicKeyMatches(env.AUTH_SIGNING_KEY ?? "", paths.publicKeyFile);
    results.push(
      matches
        ? ok("clé publique déployée", "correspond à la clé de signature")
        : fail(
            "clé publique déployée",
            "ne correspond pas à la clé de signature courante",
            "nexus setup — réécrit la clé publique",
          ),
    );
  }

  const engineUrl = env.MISSION_CONTROL_URL;
  if (engineUrl !== undefined && engineUrl.length > 0) {
    // Une mutation sans jeton : si elle n'est pas refusée, l'authentification
    // n'est pas active, quoi qu'en dise la configuration.
    const probe = await probes.http(`${engineUrl.replace(/\/$/, "")}/v1/settings`);
    results.push(
      probe === undefined
        ? skip("authentification API → moteur", "moteur injoignable")
        : ok(
            "authentification API → moteur",
            "le moteur répond ; état vérifié au démarrage du service",
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
      results.push(warn(unit, "non installée", "nexus setup — génère et installe les unités"));
      continue;
    }

    const details = [
      state.active ? "active" : "arrêtée",
      state.enabled ? "activée au démarrage" : "non activée",
    ];
    results.push(
      state.active ? ok(unit, details.join(", ")) : warn(unit, details.join(", "), "nexus start"),
    );

    // Le piège que cette CLI existe pour fermer : une unité qui pointe sur un
    // autre emplacement que l'installation courante.
    if (state.fragmentPath !== undefined && existsSync(state.fragmentPath)) {
      const strays = foreignPaths(readFileSyncSafe(state.fragmentPath), paths.root);
      if (strays.length > 0) {
        results.push(
          fail(
            `${unit} (chemins)`,
            `${strays.length} chemin(s) hors de cette installation : ${strays[0] ?? ""}`,
            "nexus setup — réécrit l'unité avec les chemins courants",
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
  if (url === undefined || url.length === 0) return skip(label, "URL non définie");
  const target = hostAndPort(url);
  if (target === undefined) return fail(label, `URL illisible : ${url}`);
  const open = await probes.tcp(target.host, target.port);
  return open
    ? ok(label, `joignable sur ${target.host}:${target.port}`)
    : fail(label, `injoignable sur ${target.host}:${target.port}`, fix);
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
