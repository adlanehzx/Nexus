import { ExecutableNotAllowedError, PolicyViolationError } from "../errors.js";

/**
 * Process execution policy.
 *
 * Enforces structured calls (executable + argument array) rather than shell command strings.
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

export const DEFAULT_ALLOWED_ENV = ["PATH", "SYSTEMROOT", "TEMP", "TMP", "COMSPEC"] as const;

const DENIED_EXTENSIONS = [".bat", ".cmd", ".ps1", ".vbs", ".js", ".msi", ".scr"];

const DENIED_ARGUMENTS: Record<string, readonly string[]> = {
  node: ["-e", "--eval", "-p", "--print", "--input-type", "-r", "--require"],
  nodejs: ["-e", "--eval", "-p", "--print", "--input-type", "-r", "--require"],
  deno: ["eval"],
  bun: ["-e", "--eval"],
  python: ["-c", "--command"],
  python3: ["-c", "--command"],
  py: ["-c", "--command"],

  npm: ["exec", "x"],
  npx: ["*"],
  pnpm: ["exec", "dlx"],
  yarn: ["dlx"],

  git: ["-c", "--config-env", "--exec-path", "--upload-pack", "--receive-pack"],
};

const INSTALL_SUBCOMMANDS = new Set(["install", "i", "add", "ci", "update", "up"]);
const INSTALLERS = new Set(["npm", "pnpm", "yarn"]);

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

  validate(request: ExecRequest, sourceEnv: Record<string, string | undefined>): ValidatedExec {
    const executable = request.executable.trim();
    if (executable.length === 0) {
      throw new PolicyViolationError({ rule: "executable.empty", message: "Empty executable" });
    }

    if (executable.includes("\\") || executable.includes("/")) {
      throw new PolicyViolationError({
        rule: "executable.path",
        message: "Executable paths are not allowed; use an allowed program name",
        userMessage: "Name an allowed program, without a path.",
        context: { executable },
      });
    }

    const lowered = executable.toLowerCase();
    if (DENIED_EXTENSIONS.some((extension) => lowered.endsWith(extension))) {
      throw new PolicyViolationError({
        rule: "executable.extension",
        message: `Extension not allowed: ${executable}`,
        userMessage: "NEXUS does not execute scripts or batch files.",
        context: { executable },
      });
    }

    const program = baseName(executable).toLowerCase();

    if (NEVER_ALLOWED.has(program)) {
      throw new PolicyViolationError({
        rule: "executable.livingOffTheLand",
        message: `Program permanently prohibited: ${program}`,
        userMessage:
          `"${program}" exists to run code on behalf of another program. ` +
          "NEXUS never launches it, whatever the configuration says.",
        context: { executable: program },
      });
    }

    if (!this.allows(executable)) throw new ExecutableNotAllowedError(executable);

    this.#assertArgumentsAllowed(program, request.args);

    if (request.args.length > this.#maxArgs) {
      throw new PolicyViolationError({
        rule: "args.count",
        message: `Too many arguments (${String(request.args.length)})`,
      });
    }

    const args = request.args.map((arg, index) => {
      if (typeof arg !== "string") {
        throw new PolicyViolationError({
          rule: "args.type",
          message: `Argument ${String(index)} is not a string`,
        });
      }
      if (arg.includes("\0")) {
        throw new PolicyViolationError({
          rule: "args.nul",
          message: `Argument ${String(index)} contains a null character`,
        });
      }
      if (arg.length > this.#maxArgLength) {
        throw new PolicyViolationError({
          rule: "args.length",
          message: `Argument ${String(index)} too long`,
        });
      }
      return arg;
    });

    return { executable, args, env: this.#buildEnv(request.env ?? {}, sourceEnv) };
  }

  #assertArgumentsAllowed(program: string, args: readonly string[]): void {
    const denied = DENIED_ARGUMENTS[program];

    if (denied !== undefined) {
      for (const arg of args) {
        const flag = arg.split("=")[0] ?? arg;

        if (denied.includes("*") || denied.includes(flag)) {
          throw new PolicyViolationError({
            rule: "args.codeExecution",
            message: `Argument prohibited for ${program}: ${flag}`,
            userMessage:
              `"${flag}" would make ${program} run arbitrary code, ` +
              "outside any file policy. Run an existing script instead.",
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
          message: `Installation without --ignore-scripts prohibited for ${program}`,
          userMessage:
            "Installing dependencies runs the scripts of the downloaded packages. " +
            'Add "--ignore-scripts".',
          context: { program },
        });
      }
    }

    if (program === "docker" && (first === undefined || !DOCKER_READ_ONLY.has(first))) {
      throw new PolicyViolationError({
        rule: "args.dockerWrite",
        message: `Docker subcommand prohibited from terminal.execute: ${first ?? "(none)"}`,
        userMessage:
          "Only read-only Docker goes through the terminal. " +
          'Commands that write go through the "docker.execute" capability.',
        context: { subcommand: first ?? "" },
      });
    }
  }

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
          message: `Environment variable not allowed: ${name}`,
          userMessage: `The variable "${name}" is not allowed on this device.`,
          context: { variable: name },
        });
      }
      if (value.includes("\0")) {
        throw new PolicyViolationError({
          rule: "env.nul",
          message: `Variable ${name} contains a null character`,
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
