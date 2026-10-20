import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";

import type { NexusPaths } from "./environment.js";
import { readEnvFile, upsertEnvValue } from "./environment.js";
import { MISSION_ENGINE_UNIT, renderMissionEngineUnit } from "./systemd.js";

/**
 * Installation et mise en conformité d'une instance.
 *
 * Trois propriétés gouvernent ce fichier.
 *
 * **Idempotent.** Relancer `setup` sur une installation saine ne doit rien
 * changer. Une commande d'installation qu'on hésite à relancer ne sert qu'une
 * fois, alors que c'est précisément après une modification qu'on en a besoin.
 *
 * **Ne détruit jamais un secret.** Une clé de signature existante n'est pas
 * remplacée : la régénérer invaliderait les sessions et désaccorderait la clé
 * publique déployée. Le remplacement est une décision, pas un effet de bord
 * d'une commande d'installation — d'où `--rotate-keys`, explicite.
 *
 * **Chaque action est décrite avant d'être faite.** `--dry-run` rend le plan
 * sans rien écrire, et c'est le même code qui décide dans les deux cas : un
 * aperçu calculé séparément finirait par mentir.
 */

export interface SetupOptions {
  paths: NexusPaths;
  dryRun: boolean;
  /** Remplace une clé de signature existante. Jamais implicite. */
  rotateKeys: boolean;
  /**
   * Chemin absolu de `pnpm`.
   *
   * Résolu par l'appelant, qui peut interroger le système : le planificateur
   * reste synchrone et testable, et l'unité générée porte un chemin réel plutôt
   * qu'un nom qui dépendrait du `PATH` du service — lequel n'hérite de rien.
   */
  pnpmPath: string;
  apiUrl?: string;
  /** `PATH` donné au service. Injecté pour que le rendu soit reproductible. */
  servicePath?: string;
}

export interface SetupAction {
  /** Ce qui sera fait, à l'infinitif, lisible par la personne qui décide. */
  label: string;
  /** `false` quand l'état attendu est déjà en place. */
  needed: boolean;
  detail?: string;
  apply: () => void;
}

export interface SetupPlan {
  actions: SetupAction[];
  warnings: string[];
}

export function planSetup(options: SetupOptions): SetupPlan {
  const { paths } = options;
  const actions: SetupAction[] = [];
  const warnings: string[] = [];

  const envExists = existsSync(paths.envFile);
  let envContent = envExists ? readFileSync(paths.envFile, "utf8") : "";

  if (!envExists) {
    const template = existsSync(paths.envExample)
      ? readFileSync(paths.envExample, "utf8")
      : "NODE_ENV=development\n";
    envContent = template;
    actions.push({
      label: "créer .env depuis .env.example",
      needed: true,
      detail: paths.envFile,
      apply: () => writeSecret(paths.envFile, template),
    });
  }

  const env = envExists ? readEnvFile(paths.envFile) : {};

  // ── Clé de signature ────────────────────────────────────────────────────
  const existingKey = env.AUTH_SIGNING_KEY;
  const hasKey = typeof existingKey === "string" && existingKey.includes("BEGIN PRIVATE KEY");
  const generate = !hasKey || options.rotateKeys;

  if (hasKey && options.rotateKeys) {
    warnings.push(
      "rotation demandée : les sessions en cours seront invalidées, et toute clé publique déployée ailleurs devra être remplacée",
    );
  }

  let publicKeyPem = hasKey ? derivePublicKey(existingKey) : undefined;

  if (generate) {
    const pair = generateKeyPairSync("ed25519");
    const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();

    actions.push({
      label: hasKey ? "remplacer la clé de signature" : "générer une clé de signature persistante",
      needed: true,
      detail: "Ed25519, écrite dans .env en 0600",
      apply: () => {
        const updated = upsertEnvValue(
          readFileSyncOr(paths.envFile, envContent),
          "AUTH_SIGNING_KEY",
          privateKeyPem,
        );
        writeSecret(paths.envFile, updated);
      },
    });
  } else {
    actions.push({
      label: "clé de signature persistante",
      needed: false,
      detail: "déjà présente — utiliser --rotate-keys pour la remplacer",
      apply: () => undefined,
    });
  }

  // ── Permissions du fichier de secrets ───────────────────────────────────
  const envMode = permissionsOf(paths.envFile);
  const envModeWrong = envMode !== undefined && envMode !== "600";
  actions.push({
    label: "restreindre .env à son propriétaire",
    needed: envModeWrong || !envExists,
    detail: envMode === undefined ? "sera créé en 0600" : `actuellement 0${envMode}`,
    apply: () => chmodSync(paths.envFile, 0o600),
  });

  // ── Clé publique déployée ───────────────────────────────────────────────
  if (publicKeyPem !== undefined) {
    const deployed = existsSync(paths.publicKeyFile)
      ? readFileSync(paths.publicKeyFile, "utf8")
      : undefined;
    const matches = deployed !== undefined && normalise(deployed) === normalise(publicKeyPem);
    const pem = publicKeyPem;

    actions.push({
      label: "déposer la clé publique pour Mission Engine",
      needed: !matches,
      detail: paths.publicKeyFile,
      apply: () => {
        mkdirSync(dirname(paths.publicKeyFile), { recursive: true, mode: 0o700 });
        // Publique, donc lisible : la restreindre n'ajoute rien et compliquerait
        // un déploiement où le moteur tourne sous un autre utilisateur.
        writeFileSync(paths.publicKeyFile, pem, { mode: 0o644 });
      },
    });
  }

  // ── Mot de passe PostgreSQL ─────────────────────────────────────────────
  if (env.DATABASE_URL === undefined || env.DATABASE_URL.length === 0) {
    const password = randomBytes(24).toString("base64url");
    const url = `postgresql://nexus:${password}@127.0.0.1:15432/nexus`;
    actions.push({
      label: "générer une URL PostgreSQL locale",
      needed: true,
      detail: "mot de passe aléatoire de 24 octets",
      apply: () => {
        const updated = upsertEnvValue(
          readFileSyncOr(paths.envFile, envContent),
          "DATABASE_URL",
          url,
        );
        writeSecret(paths.envFile, updated);
      },
    });
    warnings.push(
      "le mot de passe PostgreSQL vient d'être généré : `docker compose` doit être relancé pour que la base l'adopte",
    );
  }

  // ── Unité systemd ───────────────────────────────────────────────────────
  const unitPath = join(paths.systemdUserDir, MISSION_ENGINE_UNIT);
  const unit = renderMissionEngineUnit({
    paths,
    pnpmPath: options.pnpmPath,
    servicePath: options.servicePath ?? process.env.PATH ?? "/usr/local/bin:/usr/bin",
    apiUrl: options.apiUrl ?? env.MISSION_CONTROL_URL ?? "http://127.0.0.1:3000",
    publicKeyFile: publicKeyPem === undefined ? undefined : paths.publicKeyFile,
  });
  const currentUnit = existsSync(unitPath) ? readFileSync(unitPath, "utf8") : undefined;

  actions.push({
    label: "écrire l'unité systemd du moteur",
    needed: currentUnit !== unit,
    detail: unitPath,
    apply: () => {
      mkdirSync(paths.systemdUserDir, { recursive: true });
      writeFileSync(unitPath, unit, { mode: 0o644 });
    },
  });

  return { actions, warnings };
}

/**
 * Exécute un plan.
 *
 * Les actions déjà satisfaites ne sont pas rejouées : c'est ce qui rend la
 * commande sûre à relancer, et ce qui fait que sa sortie dit quelque chose —
 * « rien à faire » est une information.
 */
export function applyPlan(plan: SetupPlan): { applied: string[]; skipped: string[] } {
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const action of plan.actions) {
    if (!action.needed) {
      skipped.push(action.label);
      continue;
    }
    action.apply();
    applied.push(action.label);
  }
  return { applied, skipped };
}

function writeSecret(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  // `writeFileSync` n'applique le mode qu'à la création : sur un fichier
  // existant, les permissions restent celles d'avant, et c'est exactement le
  // cas qu'on veut corriger.
  chmodSync(path, 0o600);
}

function readFileSyncOr(path: string, fallback: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

function derivePublicKey(privateKeyPem: string): string | undefined {
  try {
    return createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();
  } catch {
    return undefined;
  }
}

function permissionsOf(path: string): string | undefined {
  try {
    return (statSync(path).mode & 0o777).toString(8);
  } catch {
    return undefined;
  }
}

const normalise = (value: string): string => value.replace(/\s+/g, "");
