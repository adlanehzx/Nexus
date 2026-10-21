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
 * `nexus policy` — local device policy editor and inspector.
 *
 * Commands:
 *   nexus policy init      writes a commented template, refuses to overwrite without --force
 *   nexus policy show      displays current active policy and its source
 *   nexus policy check     validates and explains decision on a specific path or executable
 */

export const POLICY_FILE = "device-policy.yaml";

/** `~/.nexus/device-policy.yaml`, unless specified otherwise. */
export function defaultPolicyPath(home = homedir()): string {
  return join(home, ".nexus", POLICY_FILE);
}

/**
 * Commented template example.
 * Closed by default: allowed roots are empty.
 */
export const POLICY_EXAMPLE = `# Local device policy — edited by you, never by NEXUS.
#
# This is the sole boundary protecting this host from the Core: if the server
# is compromised, this file prevents this machine from becoming exposed.
# NEXUS never overwrites this file, and no automated command alters it.
#
# After each edit:
#   nexus policy check --path ~/path/to/verify
version: 1

filesystem:
  # Accessible workspace roots. Nothing is accessible outside these.
  #
  # Intentionally EMPTY: this example provides zero access until you define roots.
  # An example opening the home directory by default would risk being adopted verbatim.
  #
  # Replace with your roots, for example:
  #   allow:
  #     - ~/projects
  #     - ~/Documents/nexus
  allow: []

  # Denials take precedence, even within allowed roots.
  deny:
    # All files under these directories.
    under:
      - ~/.ssh
      - ~/.aws
      - ~/.gnupg
      - ~/.config/nexus
    # Path segments matching anywhere in path.
    segments:
      - node_modules
      - .git
    # File name patterns. Single trailing asterisk supported.
    names:
      - .env*
      - id_rsa
      - id_ed25519
      - credentials*

  maxFileSizeMb: 20

exec:
  # allowlist: only executables listed below (empty = worker default list).
  # disabled:  no process execution, regardless of Core requests.
  mode: allowlist
  allowedExecutables:
    - git
    - node
    - pnpm
    - python
  # Worker environment is never forwarded wholesale.
  allowedEnv:
    - PATH
    - HOME
    - LANG
  # Empty = allowed roots above.
  workdirRoots: []
  timeoutSec: 300

git:
  # Allows pull / checkout / commit / clone.
  allowWrite: false

docker:
  # Read-only inspection by default. Broadening requires intentional decision.
  allowedSubcommands:
    - ps
    - images
    - logs
    - inspect

network:
  # Outbound network for the worker process itself.
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
        `unknown subcommand: ${subcommand}\n` +
          "usage: nexus policy [init|show|check] [--file <path>]\n",
      );
      return 1;
  }
}

async function initPolicy(path: string, force: boolean): Promise<number> {
  if (!force) {
    const existing = await readFile(path, "utf8").catch(() => undefined);
    if (existing !== undefined) {
      process.stderr.write(
        `${path} already exists.\n` +
          "Rerun with --force to overwrite, or edit it directly.\n",
      );
      return 1;
    }
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, POLICY_EXAMPLE, { mode: 0o600 });
  process.stdout.write(
    `\nPolicy written: ${path}\n\n` +
      "  It grants ZERO access by default: uncomment roots under\n" +
      "  `filesystem.allow`, then verify with\n" +
      "    nexus policy check --path ~/projects/a-file\n\n",
  );
  return 0;
}

async function showPolicy(path: string): Promise<number> {
  try {
    const loaded = await loadDevicePolicy(path);
    process.stdout.write(`\nNEXUS — local policy\n\n${describePolicy(loaded)}\n\n`);
    if (loaded.source === "default") {
      process.stdout.write(
        `  No policy file at ${path}: all operations denied.\n` +
          "  Initialize with `nexus policy init`.\n\n",
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

  process.stdout.write(`\nNEXUS — local policy: ${loaded.source}\n`);
  if (loaded.source === "default") {
    process.stdout.write(`  no policy file at ${path} — all operations denied\n`);
  }

  const candidate = valueOf(args, "--path");
  const executable = valueOf(args, "--exec");

  if (candidate === undefined && executable === undefined) {
    process.stdout.write(
      "\n  The policy file is valid.\n\n" +
        "  To inspect decisions for a specific target:\n" +
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

  return refused ? 2 : 0;
}

function reportFileError(error: unknown): number {
  if (error instanceof DevicePolicyFileError) {
    process.stderr.write(`\nUnreadable policy: ${error.path}\n\n`);
    for (const problem of error.problems) process.stderr.write(`  ✗ ${problem}\n`);
    process.stderr.write(
      "\n  Nothing is applied until this file is valid.\n\n",
    );
    return 1;
  }
  throw error;
}
