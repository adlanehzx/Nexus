import { PolicyViolationError } from "../errors.js";

/**
 * Politique Docker.
 *
 * Un point à ne pas perdre de vue : **accéder au démon Docker, c'est être
 * administrateur de la machine.** `docker run -v C:\:/host` monte le disque
 * entier dans un conteneur ; `--privileged` lève l'isolation. Il n'existe pas de
 * « Docker en lecture seule » au niveau du démon — la restriction doit se faire
 * ici, avant l'appel.
 *
 * D'où le choix par défaut : seules des sous-commandes de consultation sont
 * autorisées. Élargir est possible, mais c'est une décision explicite de
 * l'utilisateur, inscrite dans sa configuration.
 */

/** Sous-commandes qui n'écrivent rien et ne lancent rien. */
export const READ_ONLY_SUBCOMMANDS = [
  "ps",
  "images",
  "logs",
  "inspect",
  "version",
  "info",
  "port",
  "top",
  "stats",
] as const;

/**
 * Options refusées quelle que soit la sous-commande.
 *
 * Chacune d'elles annule, à elle seule, l'isolation du conteneur.
 */
const DENIED_FLAGS = [
  "--privileged",
  "--cap-add",
  "--device",
  "--pid=host",
  "--network=host",
  "--userns=host",
  "--security-opt",
];

/** Montages qui exposeraient la machine hôte ou le démon lui-même. */
const DENIED_MOUNT_TARGETS = [
  "/var/run/docker.sock",
  "//./pipe/docker_engine",
  "\\\\.\\pipe\\docker_engine",
];

export interface DockerPolicyOptions {
  /** Sous-commandes autorisées. Défaut : consultation seule. */
  allowedSubcommands?: readonly string[];
}

export interface DockerRequest {
  subcommand: string;
  args: readonly string[];
}

export class DockerPolicy {
  readonly #allowed: Set<string>;

  constructor(options: DockerPolicyOptions = {}) {
    const allowed =
      options.allowedSubcommands && options.allowedSubcommands.length > 0
        ? options.allowedSubcommands
        : READ_ONLY_SUBCOMMANDS;
    this.#allowed = new Set(allowed.map((name) => name.toLowerCase()));
  }

  get allowedSubcommands(): string[] {
    return [...this.#allowed].sort();
  }

  /** La sous-commande modifie-t-elle l'état ? Détermine le niveau de risque. */
  static isMutating(subcommand: string): boolean {
    return !READ_ONLY_SUBCOMMANDS.includes(
      subcommand.toLowerCase() as (typeof READ_ONLY_SUBCOMMANDS)[number],
    );
  }

  /**
   * Valide une demande Docker et renvoie la ligne d'arguments à passer.
   *
   * @throws {PolicyViolationError} sur une sous-commande non autorisée ou une
   *   option qui lèverait l'isolation.
   */
  validate(request: DockerRequest): string[] {
    const subcommand = request.subcommand.trim().toLowerCase();

    if (!this.#allowed.has(subcommand)) {
      throw new PolicyViolationError({
        rule: "docker.subcommand",
        message: `Sous-commande Docker non autorisée : ${subcommand}`,
        userMessage: `The Docker operation "${subcommand}" is not allowed on this device.`,
        context: { subcommand, allowed: [...this.#allowed] },
      });
    }

    for (const arg of request.args) {
      const lowered = arg.toLowerCase();

      for (const flag of DENIED_FLAGS) {
        if (lowered === flag || lowered.startsWith(`${flag}=`)) {
          throw new PolicyViolationError({
            rule: "docker.flag",
            message: `Option Docker interdite : ${flag}`,
            userMessage: "That Docker option would lift the container isolation.",
            context: { flag },
          });
        }
      }

      for (const target of DENIED_MOUNT_TARGETS) {
        if (lowered.includes(target.toLowerCase())) {
          throw new PolicyViolationError({
            rule: "docker.mount",
            message: "Montage du socket Docker interdit",
            userMessage: "Mounting the Docker socket into a container is prohibited.",
            context: { target },
          });
        }
      }

      // Monter une racine de lecteur revient à donner le disque entier.
      if (/^(-v|--volume)?=?[a-z]:[\\/]?:/i.test(arg) || arg.startsWith("/:")) {
        throw new PolicyViolationError({
          rule: "docker.rootMount",
          message: "Montage d'une racine de disque interdit",
          userMessage: "Mounting a drive root into a container is prohibited.",
        });
      }
    }

    return [subcommand, ...request.args];
  }
}
