import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Où se trouve l'installation, et avec quoi.
 *
 * Tout le reste de la CLI en dépend, et c'est aussi ce qui répond à l'exigence
 * « supprimer les chemins absolus propres à une machine » : rien n'est écrit en
 * dur, tout est dérivé de l'emplacement réel du dépôt. Une installation
 * déplacée ou clonée ailleurs continue de fonctionner sans édition.
 */

export interface NexusPaths {
  /** Racine du dépôt. */
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
 * Remonte jusqu'à la racine du dépôt.
 *
 * Reconnue par `pnpm-workspace.yaml`, et non par `.git` : une copie exportée
 * sans historique reste une installation valide, alors qu'un dépôt sans
 * espace de travail ne l'est pas.
 */
export function findRepositoryRoot(from: string): string {
  let current = resolve(from);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `racine NEXUS introuvable depuis ${from} : aucun pnpm-workspace.yaml en remontant`,
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
    // Hors du dépôt : une clé n'a rien à faire dans un arbre versionné, même
    // publique, et la placer ailleurs supprime le risque de la commiter par
    // inadvertance avec sa voisine privée.
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
 * Lit un fichier `.env` sans toucher à `process.env`.
 *
 * La CLI inspecte une configuration, elle ne l'adopte pas : charger le fichier
 * dans son propre environnement ferait que `doctor` se mentirait à lui-même
 * — il dirait qu'une variable est présente alors qu'il vient de la poser.
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
    // Les guillemets sont ceux de l'écriture, pas de la valeur. Une clé PEM
    // arrive entre guillemets avec des `\n` échappés : les restaurer est ce qui
    // permet de la relire telle qu'elle a été écrite.
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
 * Réécrit une variable d'un fichier `.env`, ou l'ajoute.
 *
 * Rend le contenu plutôt que d'écrire : l'appelant décide d'écrire ou non, ce
 * qui rend `--dry-run` possible sans dupliquer la logique — et testable sans
 * système de fichiers.
 */
export function upsertEnvValue(content: string, key: string, value: string): string {
  const serialised = `${key}=${quoteIfNeeded(value)}`;
  const lines = content.length === 0 ? [] : content.split("\n");

  // Une ligne commentée de la même clé est réveillée sur place : c'est là que
  // la documentation l'attend, et laisser le commentaire ferait croire que la
  // valeur n'est pas définie.
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
 * La clé de signature est-elle persistante ?
 *
 * Sans elle, l'API en fabrique une à chaque démarrage : les sessions ne
 * survivent pas à un redémarrage, et aucune clé publique ne peut être
 * provisionnée — donc l'authentification entre services reste inerte. C'est la
 * question la plus conséquente que `doctor` pose.
 */
export function hasPersistentSigningKey(env: Record<string, string>): boolean {
  const value = env.AUTH_SIGNING_KEY;
  return typeof value === "string" && value.includes("BEGIN PRIVATE KEY");
}
