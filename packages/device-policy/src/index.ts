import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AppError } from "@nexus/shared";

/**
 * Politique locale d'un appareil.
 *
 * ## Le problème, tel qu'il était
 *
 * La politique **existait déjà** : racines autorisées, exécutables autorisés,
 * variables d'environnement transmises, sous-commandes Docker, écriture Git.
 * Elle vivait dans des variables d'environnement, ce qui a trois coûts
 * mesurables :
 *
 *  1. **Illisible.** `WORKER_ALLOWED_PATHS=C:\a,C:\b` n'est pas une politique
 *     qu'on relit avant de s'en remettre à elle, et encore moins qu'on explique
 *     à quelqu'un d'autre. Un fichier commenté, oui.
 *  2. **Pas de refus.** On ne pouvait qu'autoriser des racines. Interdire
 *     `~/.ssh` *sous* une racine autorisée était impossible, alors que c'est
 *     précisément le cas qui compte : on autorise son dossier personnel, et on
 *     veut en exclure trois endroits.
 *  3. **Muette.** Une faute de frappe dans une liste séparée par des virgules
 *     élargit ou rétrécit silencieusement ce que NEXUS peut toucher. Rien ne le
 *     dit, et on ne le découvre qu'à l'usage.
 *
 * ## Ce que ce fichier n'est pas
 *
 * La documentation d'origine esquissait une liste blanche de **chaînes de
 * commande**. Elle n'est pas
 * implémentée, et c'est délibéré : le worker n'expose nulle part de fonction
 * qui prenne une chaîne de commande. Son API est structurée — un exécutable,
 * un tableau d'arguments, pas de shell — ce qui supprime l'injection au lieu
 * de la filtrer. Ajouter des motifs de chaînes aujourd'hui donnerait l'air
 * d'un durcissement tout en réintroduisant le modèle plus faible.
 *
 * La politique configure donc des exécutables, jamais des commandes.
 *
 * ## Pourquoi pas de globs
 *
 * Les refus sont exprimés en trois règles étroites — préfixe, segment, nom —
 * plutôt qu'avec un moteur de motifs générique. Pour une liste de refus, la
 * taille de la surface de confiance *est* le risque : un moteur de globs se
 * comporte différemment selon l'échappement, la casse, les liens, et une
 * divergence subtile n'y est pas un bug d'affichage mais un trou. Les trois cas
 * qui comptaient — tout ce qui est sous `~/.ssh`, les fichiers nommés
 * `.env*`, et tout chemin traversant `node_modules` — s'expriment
 * sans lui, et chaque règle se lit en une ligne.
 */

const pathRule = z.string().min(1).max(512);

export const devicePolicySchema = z
  .object({
    /** Version du format. Présente pour qu'une évolution puisse être refusée. */
    version: z.literal(1),

    filesystem: z
      .object({
        /** Racines accessibles. Une liste vide interdit tout accès fichier. */
        allow: z.array(pathRule).max(64).default([]),
        /**
         * Refus, appliqués **après** l'autorisation et plus forts qu'elle.
         *
         * C'est l'inversion qui compte : on autorise large — son dossier de
         * travail — et on exclut précisément. L'inverse obligerait à énumérer
         * tout ce qui est permis, ce que personne ne tient à jour.
         */
        deny: z
          .object({
            /** Tout ce qui se trouve sous ce dossier. Ex. `~/.ssh`. */
            under: z.array(pathRule).max(64).default([]),
            /** Tout chemin contenant ce segment. Ex. `node_modules`. */
            segments: z.array(z.string().min(1).max(64)).max(64).default([]),
            /**
             * Nom de fichier, avec au plus une `*` en fin. Ex. `.env*`.
             *
             * Une seule étoile, en fin seulement : c'est assez pour les cas
             * réels et cela garde la règle lisible d'un coup d'œil.
             */
            names: z
              .array(
                z
                  .string()
                  .min(1)
                  .max(64)
                  .refine(
                    (value) => (value.match(/\*/g) ?? []).length === 0 || /^[^*]+\*$/.test(value),
                    "une seule étoile, en fin de nom",
                  ),
              )
              .max(64)
              .default([]),
          })
          .strict()
          .default({ under: [], segments: [], names: [] }),
        maxFileSizeMb: z.number().int().min(1).max(1_024).default(20),
      })
      .strict()
      .default({
        allow: [],
        deny: { under: [], segments: [], names: [] },
        maxFileSizeMb: 20,
      }),

    exec: z
      .object({
        /**
         * `disabled` coupe l'exécution de processus, quoi que le cœur demande.
         *
         * Il n'y a pas de `confirm-all` : une confirmation est une décision
         * humaine, et elle se prend sur la surface où la personne se trouve —
         * pas sur une machine qui n'a pas d'écran. Le worker décide
         * *localement* si une action est permise ; il ne sait pas demander.
         */
        mode: z.enum(["allowlist", "disabled"]).default("allowlist"),
        /** Vide = la liste par défaut du worker, volontairement courte. */
        allowedExecutables: z.array(z.string().min(1).max(64)).max(64).default([]),
        /** L'environnement du worker n'est jamais transmis en bloc. */
        allowedEnv: z.array(z.string().min(1).max(64)).max(64).default([]),
        /** Racines autorisées comme répertoire de travail. Vide = celles de `filesystem.allow`. */
        workdirRoots: z.array(pathRule).max(64).default([]),
        timeoutSec: z.number().int().min(1).max(3_600).default(300),
      })
      .strict()
      .default({
        mode: "allowlist",
        allowedExecutables: [],
        allowedEnv: [],
        workdirRoots: [],
        timeoutSec: 300,
      }),

    git: z
      .object({ allowWrite: z.boolean().default(false) })
      .strict()
      .default({ allowWrite: false }),

    docker: z
      .object({
        /** Par défaut : consultation seule. Élargir est une décision — l'accès
         * au démon Docker équivaut à un accès administrateur. */
        allowedSubcommands: z
          .array(z.string().min(1).max(32))
          .max(32)
          .default(["ps", "images", "logs", "inspect"]),
      })
      .strict()
      .default({ allowedSubcommands: ["ps", "images", "logs", "inspect"] }),

    network: z
      .object({
        /**
         * Sortie réseau du worker lui-même.
         *
         * `deny` par défaut : le worker parle au cœur, et c'est tout. Une
         * capacité qui aurait besoin du réseau passe par le cœur, où la
         * permission et la confirmation existent.
         */
        egress: z.enum(["deny", "allow"]).default("deny"),
      })
      .strict()
      .default({ egress: "deny" }),
  })
  // `strict` partout : une clé inconnue est une **erreur**, pas un champ
  // ignoré. Une politique dont une section est muette parce qu'elle est mal
  // orthographiée serait exactement la panne silencieuse qu'on veut éviter.
  .strict();

export type DevicePolicy = z.infer<typeof devicePolicySchema>;

/** La politique la plus fermée qui reste utilisable : rien n'est accessible. */
export const CLOSED_POLICY: DevicePolicy = devicePolicySchema.parse({ version: 1 });

export class DevicePolicyError extends AppError {
  readonly code = "DEVICE_POLICY_DENIED";
  readonly httpStatus = 403;
  /** La règle qui a refusé. */
  readonly rule: string;

  /**
   * `rule` nomme la règle qui a refusé.
   *
   * Exigé par `PolicyViolationError`, et c'est une bonne contrainte : un refus
   * qui ne nomme pas sa règle laisse l'utilisateur deviner ce qu'il faudrait
   * autoriser. C'est la différence entre « refusé » et « refusé : sous
   * ~/.ssh ».
   */
  constructor(rule: string, message: string, context: Record<string, unknown> = {}) {
    super({
      message,
      userMessage: `La politique locale de cet appareil refuse cette action : ${rule}.`,
      context: { ...context, rule },
    });
    this.rule = rule;
  }
}

export class DevicePolicyFileError extends Error {
  readonly path: string;
  /** Les problèmes, un par ligne, dans l'ordre du fichier. */
  readonly problems: readonly string[];

  constructor(path: string, problems: readonly string[], options: { cause?: unknown } = {}) {
    super(`politique illisible (${path}) :\n  - ${problems.join("\n  - ")}`, options);
    this.path = path;
    this.problems = problems;
  }
}

/**
 * Remplace un `~` initial par le dossier personnel, **sans rien normaliser**.
 *
 * C'est la fonction à utiliser quand le chemin sera interprété par quelqu'un
 * d'autre — typiquement la politique de chemins du worker Windows, qui
 * normalise en sémantique `win32`. `expandPath`, lui, résout avec la
 * sémantique de l'hôte : appliqué à `C:\\Projets` depuis Linux, il produit un
 * chemin relatif au répertoire courant, c'est-à-dire n'importe quoi.
 */
export function expandTilde(value: string, home = homedir()): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return home + value.slice(1);
  return value;
}

/** Remplace `~` par le dossier personnel, et rend un chemin absolu normalisé. */
export function expandPath(value: string, home = homedir()): string {
  const expanded =
    value === "~"
      ? home
      : value.startsWith("~/") || value.startsWith("~\\")
        ? resolve(home, value.slice(2))
        : value;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(expanded);
}

export interface PolicyDecision {
  allowed: boolean;
  /** Pourquoi, en une phrase lisible par la personne qui édite la politique. */
  reason: string;
}

/**
 * Décide si un chemin est accessible.
 *
 * L'ordre **est** le contrat : le refus gagne. Un chemin peut tomber sous une
 * racine autorisée et rester interdit, ce qui est le cas d'usage central —
 * autoriser son dossier personnel, en exclure trois endroits.
 */
export function checkPath(
  policy: DevicePolicy,
  candidate: string,
  home = homedir(),
): PolicyDecision {
  const target = expandPath(candidate, home);
  const segments = target.split(/[\\/]+/).filter((part) => part.length > 0);
  const name = segments.at(-1) ?? "";

  // Les refus comparent **sans tenir compte de la casse**, et les
  // autorisations la respectent. L'asymétrie est volontaire : sur Linux,
  // `.ENV` et `.env` sont deux fichiers, et un refus qui ne verrait que le
  // second laisserait fuir le premier. Un refus trop large coûte un message
  // d'erreur lisible ; un refus qui manque coûte un secret. C'est aussi ce qui
  // aligne cette décision sur celle du worker Windows, où le système de
  // fichiers ignore la casse — sans quoi `nexus policy check` répondrait
  // autrement que la machine.
  const lowered = target.toLowerCase();
  const loweredSegments = segments.map((part) => part.toLowerCase());
  const loweredName = name.toLowerCase();

  for (const denied of policy.filesystem.deny.under) {
    if (isUnder(lowered, expandPath(denied, home).toLowerCase())) {
      return { allowed: false, reason: `refusé : sous ${denied}` };
    }
  }
  for (const segment of policy.filesystem.deny.segments) {
    if (loweredSegments.includes(segment.toLowerCase())) {
      return { allowed: false, reason: `refusé : contient le segment ${segment}` };
    }
  }
  for (const pattern of policy.filesystem.deny.names) {
    if (matchesName(loweredName, pattern.toLowerCase())) {
      return { allowed: false, reason: `refusé : le nom correspond à ${pattern}` };
    }
  }

  if (policy.filesystem.allow.length === 0) {
    return { allowed: false, reason: "refusé : aucune racine autorisée" };
  }
  for (const allowed of policy.filesystem.allow) {
    if (isUnder(target, expandPath(allowed, home))) {
      return { allowed: true, reason: `autorisé : sous ${allowed}` };
    }
  }
  return { allowed: false, reason: "refusé : hors des racines autorisées" };
}

/**
 * `child` est-il `parent` ou sous `parent` ?
 *
 * Comparaison par **segments** et non par préfixe de chaîne : `/home/adlane2`
 * commence par `/home/adlane` sans être dedans, et un refus qui se laisserait
 * prendre à cela protégerait le mauvais dossier.
 */
function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSeparator = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(withSeparator);
}

function matchesName(name: string, pattern: string): boolean {
  if (!pattern.endsWith("*")) return name === pattern;
  return name.startsWith(pattern.slice(0, -1));
}

/** Décide si un exécutable est permis. */
export function checkExecutable(policy: DevicePolicy, executable: string): PolicyDecision {
  if (policy.exec.mode === "disabled") {
    return { allowed: false, reason: "refusé : l'exécution de processus est désactivée" };
  }
  if (policy.exec.allowedExecutables.length === 0) {
    return { allowed: true, reason: "délégué : liste par défaut du worker" };
  }
  const wanted = executable.toLowerCase();
  const allowed = policy.exec.allowedExecutables.some((item) => item.toLowerCase() === wanted);
  return allowed
    ? { allowed: true, reason: "autorisé : dans la liste" }
    : { allowed: false, reason: `refusé : ${executable} n'est pas dans la liste` };
}

export interface LoadedPolicy {
  policy: DevicePolicy;
  /** D'où elle vient, pour que `nexus policy show` puisse le dire. */
  source: "fichier" | "défaut";
  path: string | undefined;
}

/**
 * Lit la politique, ou rend celle par défaut si le fichier n'existe pas.
 *
 * Un fichier **présent mais invalide** est une erreur, jamais un repli
 * silencieux sur les valeurs par défaut : quelqu'un a écrit une politique, et
 * l'ignorer pour cause de virgule manquante appliquerait l'inverse de son
 * intention sans le dire.
 */
export async function loadDevicePolicy(path: string): Promise<LoadedPolicy> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { policy: CLOSED_POLICY, source: "défaut", path: undefined };
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new DevicePolicyFileError(path, [describeYamlError(error)], { cause: error });
  }

  const parsed = devicePolicySchema.safeParse(raw);
  if (!parsed.success) {
    throw new DevicePolicyFileError(
      path,
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(racine)"} : ${issue.message}`,
      ),
    );
  }
  return { policy: parsed.data, source: "fichier", path };
}

function describeYamlError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `YAML invalide — ${message.split("\n")[0] ?? message}`;
}

/**
 * Rend la politique en texte, pour qu'on puisse la relire avant de s'y fier.
 *
 * Volontairement exhaustif : une politique affichée à moitié laisserait croire
 * que ce qui n'apparaît pas n'existe pas.
 */
export function describePolicy(loaded: LoadedPolicy): string {
  const { policy } = loaded;
  const lines: string[] = [];
  const list = (values: readonly string[], empty: string) =>
    values.length === 0 ? empty : values.join(", ");

  lines.push(`source : ${loaded.source}${loaded.path === undefined ? "" : ` (${loaded.path})`}`);
  lines.push("");
  lines.push("fichiers");
  lines.push(`  racines autorisées   ${list(policy.filesystem.allow, "aucune — tout est refusé")}`);
  lines.push(`  refusé sous          ${list(policy.filesystem.deny.under, "—")}`);
  lines.push(`  segments refusés     ${list(policy.filesystem.deny.segments, "—")}`);
  lines.push(`  noms refusés         ${list(policy.filesystem.deny.names, "—")}`);
  lines.push(`  taille maximale      ${String(policy.filesystem.maxFileSizeMb)} Mio`);
  lines.push("");
  lines.push("exécution");
  lines.push(`  mode                 ${policy.exec.mode}`);
  lines.push(
    `  exécutables          ${list(policy.exec.allowedExecutables, "liste par défaut du worker")}`,
  );
  lines.push(
    `  environnement        ${list(policy.exec.allowedEnv, "liste par défaut du worker")}`,
  );
  lines.push(
    `  répertoires travail  ${list(policy.exec.workdirRoots, "les racines autorisées ci-dessus")}`,
  );
  lines.push(`  délai                ${String(policy.exec.timeoutSec)} s`);
  lines.push("");
  lines.push("git et docker");
  lines.push(`  écriture git         ${policy.git.allowWrite ? "autorisée" : "refusée"}`);
  lines.push(`  docker               ${list(policy.docker.allowedSubcommands, "aucune")}`);
  lines.push("");
  lines.push(`réseau sortant         ${policy.network.egress}`);
  return lines.join("\n");
}
