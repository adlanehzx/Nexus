import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DevicePolicyFileError,
  checkExecutable,
  checkPath,
  describePolicy,
  loadDevicePolicy,
} from "@nexus/device-policy";

/**
 * `nexus policy` — l'éditeur de la politique locale.
 *
 * « Éditeur » ne veut pas dire « écrit par NEXUS ». La politique est le seul
 * endroit du système où la machine se protège **du cœur** : si le serveur est
 * compromis, c'est elle qui empêche le poste de devenir une machine ouverte.
 * Une politique que l'agent pourrait réécrire ne protégerait de rien.
 *
 * Ces commandes font donc trois choses, et aucune ne modifie une politique
 * existante :
 *
 *   nexus policy init      écrit un exemple commenté, et refuse d'écraser
 *   nexus policy show      affiche la politique en vigueur, et sa source
 *   nexus policy check     valide, et explique ce qu'elle décide d'un chemin
 *
 * `check` est la commande qui compte. Une politique qu'on ne peut pas
 * interroger se relit en espérant l'avoir comprise ; avec
 * `--path ~/.ssh/id_ed25519`, elle répond.
 */

export const POLICY_FILE = "device-policy.yaml";

/** `~/.nexus/device-policy.yaml`, sauf indication contraire. */
export function defaultPolicyPath(home = homedir()): string {
  return join(home, ".nexus", POLICY_FILE);
}

/**
 * Exemple commenté.
 *
 * Il est **fermé** : les racines autorisées sont commentées, donc une
 * politique issue de cet exemple sans édition ne donne aucun accès. Un exemple
 * qui ouvrirait le dossier personnel par défaut serait recopié tel quel, et
 * c'est ainsi qu'un exemple devient une faille.
 */
export const POLICY_EXAMPLE = `# Politique locale de cet appareil — éditée par vous, jamais par NEXUS.
#
# C'est le seul endroit où la machine se protège du cœur : si le serveur est
# compromis, c'est ce fichier qui empêche ce poste de devenir une machine
# ouverte. NEXUS ne l'écrit pas, et aucune commande ne le modifie.
#
# Après chaque modification :
#   nexus policy check --path ~/un/chemin/a/verifier
version: 1

filesystem:
  # Racines accessibles. Rien n'est accessible en dehors.
  #
  # Volontairement VIDE : cet exemple ne donne aucun accès tant que vous n'avez
  # pas choisi. Un exemple qui ouvrirait votre dossier personnel serait recopié
  # tel quel, et c'est ainsi qu'un exemple devient une faille.
  #
  # Remplacez par vos racines, par exemple :
  #   allow:
  #     - ~/projets
  #     - ~/Documents/nexus
  allow: []

  # Les refus gagnent, même sous une racine autorisée. C'est l'intérêt :
  # autoriser large, exclure précisément.
  deny:
    # Tout ce qui est sous ces dossiers.
    under:
      - ~/.ssh
      - ~/.aws
      - ~/.gnupg
      - ~/.config/nexus
    # Tout chemin traversant un de ces dossiers, où qu'il soit.
    segments:
      - node_modules
      - .git
    # Noms de fichiers. Une seule étoile, en fin de nom.
    names:
      - .env*
      - id_rsa
      - id_ed25519
      - credentials*

  maxFileSizeMb: 20

exec:
  # allowlist : seuls les exécutables ci-dessous (vide = liste par défaut du
  #             worker, volontairement courte).
  # disabled  : aucune exécution de processus, quoi que le cœur demande.
  #
  # Il n'y a pas de mode « demander » : une confirmation est une décision
  # humaine, et elle se prend sur la surface où vous êtes — pas sur une machine
  # qui n'a pas d'écran.
  mode: allowlist
  allowedExecutables:
    - git
    - node
    - pnpm
    - python
  # L'environnement du worker n'est jamais transmis en bloc : il contient le
  # chemin de la clé privée de cet appareil.
  allowedEnv:
    - PATH
    - HOME
    - LANG
  # Vide = les racines autorisées ci-dessus.
  workdirRoots: []
  timeoutSec: 300

git:
  # Autorise pull / checkout / commit / clone.
  allowWrite: false

docker:
  # Par défaut : consultation seule. Élargir est une décision — l'accès au
  # démon Docker équivaut à un accès administrateur.
  allowedSubcommands:
    - ps
    - images
    - logs
    - inspect

network:
  # Sortie réseau du worker lui-même. Il parle au cœur, et c'est tout : une
  # capacité qui a besoin du réseau passe par le cœur, où la permission et la
  # confirmation existent.
  egress: deny
`;

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

export async function policyCommand(args: string[]): Promise<number> {
  const subcommand = args.find((arg) => !arg.startsWith("-")) ?? "show";
  const path = valueOf(args, "--file") ?? defaultPolicyPath();

  switch (subcommand) {
    case "init":
      return initPolicy(path, args.includes("--force"));
    case "show":
      return showPolicy(path);
    case "check":
      return checkPolicy(path, args);
    default:
      process.stderr.write(
        `sous-commande inconnue : ${subcommand}\n` +
          "usage : nexus policy [init|show|check] [--file <chemin>]\n",
      );
      return 1;
  }
}

async function initPolicy(path: string, force: boolean): Promise<number> {
  if (!force) {
    // Ne jamais écraser sans accord : ce fichier est la seule défense locale,
    // et le réinitialiser par mégarde la remplacerait par un exemple fermé —
    // donc casserait tout — ou, pire, par un exemple ouvert.
    const existing = await readFile(path, "utf8").catch(() => undefined);
    if (existing !== undefined) {
      process.stderr.write(
        `${path} existe déjà.\n` +
          "Relancez avec --force pour l'écraser, ou éditez-le directement.\n",
      );
      return 1;
    }
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, POLICY_EXAMPLE, { mode: 0o600 });
  process.stdout.write(
    `\nPolitique écrite : ${path}\n\n` +
      "  Elle ne donne encore AUCUN accès : décommentez les racines sous\n" +
      "  `filesystem.allow`, puis vérifiez avec\n" +
      "    nexus policy check --path ~/projets/un-fichier\n\n",
  );
  return 0;
}

async function showPolicy(path: string): Promise<number> {
  try {
    const loaded = await loadDevicePolicy(path);
    process.stdout.write(`\nNEXUS — politique locale\n\n${describePolicy(loaded)}\n\n`);
    if (loaded.source === "défaut") {
      process.stdout.write(
        `  Aucun fichier à ${path} : tout est refusé.\n` +
          "  Créez-en un avec `nexus policy init`.\n\n",
      );
    }
    return 0;
  } catch (error) {
    return reportFileError(error);
  }
}

async function checkPolicy(path: string, args: string[]): Promise<number> {
  let loaded;
  try {
    loaded = await loadDevicePolicy(path);
  } catch (error) {
    return reportFileError(error);
  }

  process.stdout.write(`\nNEXUS — politique locale : ${loaded.source}\n`);
  if (loaded.source === "défaut") {
    process.stdout.write(`  aucun fichier à ${path} — tout est refusé\n`);
  }

  const candidate = valueOf(args, "--path");
  const executable = valueOf(args, "--exec");

  if (candidate === undefined && executable === undefined) {
    // Valider sans interroger ne dit que « le fichier se lit ». C'est utile, et
    // ce n'est pas ce qu'on vient chercher.
    process.stdout.write(
      "\n  Le fichier est valide.\n\n" +
        "  Pour savoir ce qu'il décide :\n" +
        "    nexus policy check --path ~/.ssh/id_ed25519\n" +
        "    nexus policy check --exec curl\n\n",
    );
    return 0;
  }

  process.stdout.write("\n");
  let refused = false;
  if (candidate !== undefined) {
    const decision = checkPath(loaded.policy, candidate);
    refused = refused || !decision.allowed;
    process.stdout.write(
      `  ${decision.allowed ? "✓" : "✗"} ${candidate}\n      ${decision.reason}\n`,
    );
  }
  if (executable !== undefined) {
    const decision = checkExecutable(loaded.policy, executable);
    refused = refused || !decision.allowed;
    process.stdout.write(
      `  ${decision.allowed ? "✓" : "✗"} ${executable}\n      ${decision.reason}\n`,
    );
  }
  process.stdout.write("\n");

  // Un refus n'est pas une erreur de la commande : on a posé une question et
  // obtenu une réponse. Le code de sortie reflète la **réponse**, ce qui rend
  // la commande utilisable dans un script de vérification.
  return refused ? 2 : 0;
}

function reportFileError(error: unknown): number {
  if (error instanceof DevicePolicyFileError) {
    process.stderr.write(`\nPolitique illisible : ${error.path}\n\n`);
    for (const problem of error.problems) process.stderr.write(`  ✗ ${problem}\n`);
    process.stderr.write(
      "\n  Rien n'est appliqué tant que ce fichier n'est pas valide : un fichier\n" +
        "  présent mais cassé n'est pas remplacé par les valeurs par défaut.\n\n",
    );
    return 1;
  }
  throw error;
}
