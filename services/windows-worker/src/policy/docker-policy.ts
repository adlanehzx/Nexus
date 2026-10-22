import { PolicyViolationError } from "../errors.js";

/**
 * Docker policy.
 *
 * Restricts Docker execution to allowed inspection subcommands by default.
 */

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

const DENIED_FLAGS = [
  "--privileged",
  "--cap-add",
  "--device",
  "--pid=host",
  "--network=host",
  "--userns=host",
  "--security-opt",
];

const DENIED_MOUNT_TARGETS = [
  "/var/run/docker.sock",
  "//./pipe/docker_engine",
  "\\\\.\\pipe\\docker_engine",
];

export interface DockerPolicyOptions {
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

  static isMutating(subcommand: string): boolean {
    return !READ_ONLY_SUBCOMMANDS.includes(
      subcommand.toLowerCase() as (typeof READ_ONLY_SUBCOMMANDS)[number],
    );
  }

  validate(request: DockerRequest): string[] {
    const subcommand = request.subcommand.trim().toLowerCase();

    if (!this.#allowed.has(subcommand)) {
      throw new PolicyViolationError({
        rule: "docker.subcommand",
        message: `Docker subcommand not allowed: ${subcommand}`,
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
            message: `Docker flag prohibited: ${flag}`,
            userMessage: "That Docker option would lift the container isolation.",
            context: { flag },
          });
        }
      }

      for (const target of DENIED_MOUNT_TARGETS) {
        if (lowered.includes(target.toLowerCase())) {
          throw new PolicyViolationError({
            rule: "docker.mount",
            message: "Mounting the Docker socket is prohibited",
            userMessage: "Mounting the Docker socket into a container is prohibited.",
            context: { target },
          });
        }
      }

      if (/^(-v|--volume)?=?[a-z]:[\\/]?:/i.test(arg) || arg.startsWith("/:")) {
        throw new PolicyViolationError({
          rule: "docker.rootMount",
          message: "Mounting a drive root is prohibited",
          userMessage: "Mounting a drive root into a container is prohibited.",
        });
      }
    }

    return [subcommand, ...request.args];
  }
}
