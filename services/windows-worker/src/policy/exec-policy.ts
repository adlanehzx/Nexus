import { ExecutableNotAllowedError, PolicyViolationError } from "../errors.js";

/**
 * Politique d'exécution de processus.
 *
 * **Il n'existe nulle part dans ce worker de fonction qui prenne une commande
 * shell et l'exécute.** L'API est structurée — un exécutable, une liste
 * d'arguments — et pour trois raisons cumulatives :
 *
 *  1. un exécutable choisi dans une liste ne peut pas être remplacé par un
 *     autre au moyen d'un `;` ou d'un `&&` ;
 *  2. des arguments passés en tableau ne sont jamais réinterprétés : `rm -rf /`
 *     transmis à `git` est un argument absurde, pas une commande ;
 *  3. sans shell, il n'y a ni expansion de variables, ni substitution de
 *     commande, ni glob — donc pas d'injection à empêcher.
 *
 * La sécurité vient de la forme de l'API, pas d'un filtre sur des chaînes. Un
 * filtre se contourne ; une API qui n'accepte pas de chaîne de commande, non.
 */

/**
 * Exécutables autorisés par défaut.
 *
 * Court exprès. Chaque ajout élargit ce que NEXUS peut faire sur la machine, et
 * doit être une décision de l'utilisateur — pas un défaut hérité.
 */
export const DEFAULT_ALLOWED_EXECUTABLES = [
  "git",
  "node",
  "npm",
  "pnpm",
  "python",
  "docker",
  "tasklist",
  "where",
] as const;

/**
 * Variables d'environnement transmises par défaut.
 *
 * L'environnement du worker n'est **jamais** transmis en bloc : il contient le
 * chemin de la clé privée de l'appareil, et tout ce que l'utilisateur a exporté
 * dans son shell. Un processus enfant reçoit ce qui figure ici, et rien d'autre.
 */
export const DEFAULT_ALLOWED_ENV = ["PATH", "SYSTEMROOT", "TEMP", "TMP", "COMSPEC"] as const;

/**
 * Extensions refusées.
 *
 * `.bat` et `.cmd` sont un cas particulier de Windows : Node les exécute en
 * passant par `cmd.exe`, ce qui réintroduit exactement l'interprétation shell
 * que cette politique existe pour éviter. Les arguments y redeviennent du texte
 * interprété.
 */
const DENIED_EXTENSIONS = [".bat", ".cmd", ".ps1", ".vbs", ".js", ".msi", ".scr"];

/**
 * Arguments refusés, par programme.
 *
 * La politique d'exécution empêche l'injection **shell** : pas de chaîne de
 * commande, pas de découpage, pas d'interprétation. Elle n'empêchait pas, en
 * revanche, qu'un programme autorisé soit lui-même un interpréteur.
 *
 * `node -e "require('fs').readFileSync('C:/Users/x/.ssh/id_rsa')"` est un appel
 * parfaitement structuré : un exécutable de la liste, un argument bien formé. Et
 * il **contourne entièrement la politique de chemins** — `filesystem.read` est
 * borné à des racines déclarées, `node -e` ne l'est pas. Le bac à sable du
 * système de fichiers ne vaut donc que si les interpréteurs ne peuvent pas
 * recevoir de code en argument.
 *
 * Même raisonnement pour les échappatoires qui exécutent du code sans en avoir
 * l'air : un alias Git (`git -c alias.x='!cmd' x`), un `sshCommand` injecté, un
 * `npm install` dont les scripts de post-installation tournent, un `docker run`
 * qui monte le disque.
 *
 * La liste refuse des **formes d'appel**, pas des programmes : `node script.js`
 * et `pnpm test` — l'usage voulu — passent sans changement.
 */
const DENIED_ARGUMENTS: Record<string, readonly string[]> = {
  // Interpréteurs : le code passé en argument échappe à toute politique.
  node: ["-e", "--eval", "-p", "--print", "--input-type", "-r", "--require"],
  nodejs: ["-e", "--eval", "-p", "--print", "--input-type", "-r", "--require"],
  deno: ["eval"],
  bun: ["-e", "--eval"],
  python: ["-c", "--command"],
  python3: ["-c", "--command"],
  py: ["-c", "--command"],

  // Gestionnaires de paquets : `exec`/`dlx` lancent un binaire arbitraire
  // téléchargé à la volée, et une installation exécute les scripts du paquet.
  npm: ["exec", "x"],
  npx: ["*"],
  pnpm: ["exec", "dlx"],
  yarn: ["dlx"],

  // Git exécute des commandes par plusieurs chemins détournés.
  git: ["-c", "--config-env", "--exec-path", "--upload-pack", "--receive-pack"],
};

/**
 * Programmes dont l'installation exécute du code tiers.
 *
 * `npm install` lance les scripts `preinstall`/`postinstall` du paquet
 * téléchargé : c'est une exécution de code arbitraire déguisée en gestion de
 * dépendances. `--ignore-scripts` la referme, et l'exiger laisse l'usage normal
 * intact.
 */
const INSTALL_SUBCOMMANDS = new Set(["install", "i", "add", "ci", "update", "up"]);
const INSTALLERS = new Set(["npm", "pnpm", "yarn"]);

/**
 * Sous-commandes Docker autorisées depuis `terminal.execute`.
 *
 * Le worker a une `DockerPolicy` complète, avec ses drapeaux refusés et ses
 * montages interdits — et `terminal.execute` la contournait entièrement en
 * lançant `docker` comme n'importe quel programme. Deux portes vers le même
 * démon, une seule gardée.
 *
 * On ferme la seconde en n'acceptant ici que la consultation. Ce qui écrit passe
 * par la capacité `docker.execute`, qui applique sa politique.
 */
const DOCKER_READ_ONLY = new Set([
  "ps",
  "images",
  "logs",
  "inspect",
  "version",
  "info",
  "port",
  "top",
  "stats",
]);

/**
 * Programmes que Windows fournit et qui exécutent du code pour le compte d'un
 * autre — les « binaires vivant de la terre ».
 *
 * `rundll32 shell32.dll,ShellExec_RunDLL calc.exe` lance n'importe quoi.
 * `mshta` exécute du script. `certutil -urlcache -f <url> <fichier>` télécharge.
 * `regsvr32 /s /u /i:<url> scrobj.dll` exécute du code distant.
 *
 * Ils sont refusés **avant** la liste d'autorisation, et c'est le point : un
 * utilisateur peut légitimement ajouter `rundll32` à `WORKER_ALLOWED_EXECUTABLES`
 * en croyant que `browser.open` en a besoin — il n'en a pas besoin, il l'invoque
 * lui-même avec une adresse validée. Sans ce refus, cette bonne intention
 * ouvrirait l'exécution arbitraire.
 *
 * Une liste d'autorisation qu'une erreur de configuration suffit à vider de son
 * sens n'est pas une protection.
 */
const NEVER_ALLOWED = new Set([
  "rundll32",
  "regsvr32",
  "mshta",
  "wmic",
  "certutil",
  "bitsadmin",
  "installutil",
  "msbuild",
  "cscript",
  "wscript",
  "powershell",
  "pwsh",
  "cmd",
  "forfiles",
  "conhost",
  "wsl",
]);

export interface ExecRequest {
  executable: string;
  args: readonly string[];
  workingDirectory?: string;
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
}

export interface ValidatedExec {
  executable: string;
  args: string[];
  env: Record<string, string>;
}

export interface ExecPolicyOptions {
  allowedExecutables?: readonly string[];
  allowedEnv?: readonly string[];
  /** Longueur maximale d'un argument. Borne les charges utiles absurdes. */
  maxArgLength?: number;
  maxArgs?: number;
}

export class ExecPolicy {
  readonly #allowed: Set<string>;
  readonly #allowedEnv: Set<string>;
  readonly #maxArgLength: number;
  readonly #maxArgs: number;

  constructor(options: ExecPolicyOptions = {}) {
    const executables =
      options.allowedExecutables && options.allowedExecutables.length > 0
        ? options.allowedExecutables
        : DEFAULT_ALLOWED_EXECUTABLES;
    const env =
      options.allowedEnv && options.allowedEnv.length > 0
        ? options.allowedEnv
        : DEFAULT_ALLOWED_ENV;

    this.#allowed = new Set(executables.map((name) => name.toLowerCase()));
    this.#allowedEnv = new Set(env.map((name) => name.toUpperCase()));
    this.#maxArgLength = options.maxArgLength ?? 4_096;
    this.#maxArgs = options.maxArgs ?? 64;
  }

  get allowedExecutables(): string[] {
    return [...this.#allowed].sort();
  }

  allows(executable: string): boolean {
    return this.#allowed.has(baseName(executable).toLowerCase());
  }

  /**
   * Valide une demande d'exécution.
   *
   * @throws {ExecutableNotAllowedError} si le programme n'est pas dans la liste.
   * @throws {PolicyViolationError} sur un argument ou un environnement refusé.
   */
  validate(request: ExecRequest, sourceEnv: Record<string, string | undefined>): ValidatedExec {
    const executable = request.executable.trim();
    if (executable.length === 0) {
      throw new PolicyViolationError({ rule: "executable.empty", message: "Exécutable vide" });
    }

    // Un chemin absolu contournerait la liste : `C:\autre\git.exe` porte le même
    // nom de base que `git` sans être le même programme.
    if (executable.includes("\\") || executable.includes("/")) {
      throw new PolicyViolationError({
        rule: "executable.path",
        message: "Un chemin d'exécutable n'est pas accepté ; utiliser un nom autorisé",
        userMessage: "Indiquez un programme autorisé par son nom, sans chemin.",
        context: { executable },
      });
    }

    const lowered = executable.toLowerCase();
    if (DENIED_EXTENSIONS.some((extension) => lowered.endsWith(extension))) {
      throw new PolicyViolationError({
        rule: "executable.extension",
        message: `Extension refusée : ${executable}`,
        userMessage: "Les scripts et fichiers de commandes ne sont pas exécutables par NEXUS.",
        context: { executable },
      });
    }

    const program = baseName(executable).toLowerCase();

    // Le refus passe **avant** la liste d'autorisation : ce sont des programmes
    // qu'aucune configuration ne doit pouvoir rendre accessibles.
    if (NEVER_ALLOWED.has(program)) {
      throw new PolicyViolationError({
        rule: "executable.livingOffTheLand",
        message: `Programme systématiquement refusé : ${program}`,
        userMessage:
          `« ${program} » sert à exécuter du code pour le compte d'un autre programme. ` +
          "NEXUS ne le lance jamais, quelle que soit la configuration.",
        context: { executable: program },
      });
    }

    if (!this.allows(executable)) throw new ExecutableNotAllowedError(executable);

    this.#assertArgumentsAllowed(program, request.args);

    if (request.args.length > this.#maxArgs) {
      throw new PolicyViolationError({
        rule: "args.count",
        message: `Trop d'arguments (${String(request.args.length)})`,
      });
    }

    const args = request.args.map((arg, index) => {
      if (typeof arg !== "string") {
        throw new PolicyViolationError({
          rule: "args.type",
          message: `Argument ${String(index)} n'est pas une chaîne`,
        });
      }
      if (arg.includes("\0")) {
        throw new PolicyViolationError({
          rule: "args.nul",
          message: `Argument ${String(index)} contient un caractère nul`,
        });
      }
      if (arg.length > this.#maxArgLength) {
        throw new PolicyViolationError({
          rule: "args.length",
          message: `Argument ${String(index)} trop long`,
        });
      }
      return arg;
    });

    return { executable, args, env: this.#buildEnv(request.env ?? {}, sourceEnv) };
  }

  /**
   * Refuse les formes d'appel qui exécutent du code arbitraire.
   *
   * @throws {PolicyViolationError} avec la règle exacte dans le contexte, pour
   *   que le message rendu à l'utilisateur explique quoi corriger.
   */
  #assertArgumentsAllowed(program: string, args: readonly string[]): void {
    const denied = DENIED_ARGUMENTS[program];

    if (denied !== undefined) {
      for (const arg of args) {
        // `--eval=x` autant que `--eval x` : on compare aussi la partie gauche.
        const flag = arg.split("=")[0] ?? arg;

        if (denied.includes("*") || denied.includes(flag)) {
          throw new PolicyViolationError({
            rule: "args.codeExecution",
            message: `Argument refusé pour ${program} : ${flag}`,
            userMessage:
              `« ${flag} » ferait exécuter du code arbitraire par ${program}, ` +
              "hors de toute politique de fichiers. Lancez un script existant à la place.",
            context: { program, argument: flag },
          });
        }
      }
    }

    const first = args[0]?.toLowerCase();

    if (INSTALLERS.has(program) && first !== undefined && INSTALL_SUBCOMMANDS.has(first)) {
      if (!args.some((arg) => arg === "--ignore-scripts")) {
        throw new PolicyViolationError({
          rule: "args.installScripts",
          message: `Installation sans --ignore-scripts refusée pour ${program}`,
          userMessage:
            "Une installation de dépendances exécute les scripts des paquets téléchargés. " +
            "Ajoutez « --ignore-scripts ».",
          context: { program },
        });
      }
    }

    if (program === "docker" && (first === undefined || !DOCKER_READ_ONLY.has(first))) {
      throw new PolicyViolationError({
        rule: "args.dockerWrite",
        message: `Sous-commande Docker refusée depuis terminal.execute : ${first ?? "(aucune)"}`,
        userMessage:
          "Seule la consultation Docker passe par le terminal. " +
          "Les commandes qui écrivent passent par la capacité « docker.execute ».",
        context: { subcommand: first ?? "" },
      });
    }
  }

  /**
   * Construit l'environnement du processus enfant.
   *
   * Liste blanche stricte, dans les deux sens : les variables demandées par
   * l'appelant doivent y figurer, celles du worker aussi. Rien ne fuit par
   * héritage.
   */
  #buildEnv(
    requested: Readonly<Record<string, string>>,
    sourceEnv: Record<string, string | undefined>,
  ): Record<string, string> {
    const env: Record<string, string> = {};

    for (const name of this.#allowedEnv) {
      const value = sourceEnv[name];
      if (value !== undefined) env[name] = value;
    }

    for (const [name, value] of Object.entries(requested)) {
      const upper = name.toUpperCase();
      if (!this.#allowedEnv.has(upper)) {
        throw new PolicyViolationError({
          rule: "env.notAllowed",
          message: `Variable d'environnement non autorisée : ${name}`,
          userMessage: `La variable « ${name} » n'est pas autorisée sur cet appareil.`,
          context: { variable: name },
        });
      }
      if (value.includes("\0")) {
        throw new PolicyViolationError({
          rule: "env.nul",
          message: `Variable ${name} contient un caractère nul`,
        });
      }
      env[upper] = value;
    }

    return env;
  }
}

function baseName(executable: string): string {
  const last = executable.split(/[\\/]/).pop() ?? executable;
  return last.replace(/\.exe$/i, "");
}
