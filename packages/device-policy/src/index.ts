import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AppError } from "@nexus/shared";

/**
 * Local device policy.
 *
 * ## Rationale
 *
 * Device policy governs allowed filesystem roots, permitted executables,
 * allowed environment variables, Docker subcommands, and Git write operations.
 *
 * Rather than unvalidated environment variables, policy is structured in YAML:
 * 1. Human-readable and commentable.
 * 2. Explicit deny rules applied after allow rules (e.g. deny `~/.ssh` inside home directory).
 * 3. Strict schema validation to prevent silent typos.
 *
 * Configures allowed executables with structured arguments, never raw command line strings.
 */

const pathRule = z.string().min(1).max(512);

export const devicePolicySchema = z
  .object({
    /** Format version. Present so schema evolution can be gated. */
    version: z.literal(1),

    filesystem: z
      .object({
        /** Accessible root paths. Empty array denies all filesystem access. */
        allow: z.array(pathRule).max(64).default([]),
        /**
         * Deny rules, applied after allow rules and taking precedence.
         */
        deny: z
          .object({
            /** Paths under this directory prefix. E.g. `~/.ssh`. */
            under: z.array(pathRule).max(64).default([]),
            /** Any path containing this directory segment. E.g. `node_modules`. */
            segments: z.array(z.string().min(1).max(64)).max(64).default([]),
            /**
             * Filename pattern with at most one trailing wildcard `*`. E.g. `.env*`.
             */
            names: z
              .array(
                z
                  .string()
                  .min(1)
                  .max(64)
                  .refine(
                    (value) => (value.match(/\*/g) ?? []).length === 0 || /^[^*]+\*$/.test(value),
                    "single trailing wildcard asterisk allowed",
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
         * `disabled` disables all process spawning regardless of Core requests.
         */
        mode: z.enum(["allowlist", "disabled"]).default("allowlist"),
        /** Empty = worker default allowed executable list. */
        allowedExecutables: z.array(z.string().min(1).max(64)).max(64).default([]),
        /** Worker environment variables are filtered strictly. */
        allowedEnv: z.array(z.string().min(1).max(64)).max(64).default([]),
        /** Permitted working directory roots. Empty = `filesystem.allow`. */
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
        /** Default: read-only inspection commands. */
        allowedSubcommands: z
          .array(z.string().min(1).max(32))
          .max(32)
          .default(["ps", "images", "logs", "inspect"]),
      })
      .strict()
      .default({ allowedSubcommands: ["ps", "images", "logs", "inspect"] }),

    network: z
      .object({
        /** Worker outbound egress mode. */
        egress: z.enum(["deny", "allow"]).default("deny"),
      })
      .strict()
      .default({ egress: "deny" }),
  })
  .strict();

export type DevicePolicy = z.infer<typeof devicePolicySchema>;

/** Fully closed policy: zero operations permitted. */
export const CLOSED_POLICY: DevicePolicy = devicePolicySchema.parse({ version: 1 });

export class DevicePolicyError extends AppError {
  readonly code = "DEVICE_POLICY_DENIED";
  readonly httpStatus = 403;
  readonly rule: string;

  constructor(rule: string, message: string, context: Record<string, unknown> = {}) {
    super({
      message,
      userMessage: `Local policy on this device denied this action: ${rule}.`,
      context: { ...context, rule },
    });
    this.rule = rule;
  }
}

export class DevicePolicyFileError extends Error {
  readonly path: string;
  readonly problems: readonly string[];

  constructor(path: string, problems: readonly string[], options: { cause?: unknown } = {}) {
    super(`unreadable policy (${path}):\n  - ${problems.join("\n  - ")}`, options);
    this.path = path;
    this.problems = problems;
  }
}

/**
 * Expands leading `~` to home directory without canonicalizing or normalizing.
 */
export function expandTilde(value: string, home = homedir()): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return home + value.slice(1);
  return value;
}

/** Expands leading `~` to home directory and resolves to normalized absolute path. */
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
  reason: string;
}

/**
 * Decides whether a filesystem path is permitted under the device policy.
 */
export function checkPath(
  policy: DevicePolicy,
  candidate: string,
  home = homedir(),
): PolicyDecision {
  const target = expandPath(candidate, home);
  const segments = target.split(/[\\/]+/).filter((part) => part.length > 0);
  const name = segments.at(-1) ?? "";

  const lowered = target.toLowerCase();
  const loweredSegments = segments.map((part) => part.toLowerCase());
  const loweredName = name.toLowerCase();

  for (const denied of policy.filesystem.deny.under) {
    if (isUnder(lowered, expandPath(denied, home).toLowerCase())) {
      return { allowed: false, reason: `denied: under ${denied}` };
    }
  }
  for (const segment of policy.filesystem.deny.segments) {
    if (loweredSegments.includes(segment.toLowerCase())) {
      return { allowed: false, reason: `denied: contains segment ${segment}` };
    }
  }
  for (const pattern of policy.filesystem.deny.names) {
    if (matchesName(loweredName, pattern.toLowerCase())) {
      return { allowed: false, reason: `denied: name matches ${pattern}` };
    }
  }

  if (policy.filesystem.allow.length === 0) {
    return { allowed: false, reason: "denied: no allowed roots" };
  }
  for (const allowed of policy.filesystem.allow) {
    if (isUnder(target, expandPath(allowed, home))) {
      return { allowed: true, reason: `allowed: under ${allowed}` };
    }
  }
  return { allowed: false, reason: "denied: outside allowed roots" };
}

function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSeparator = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(withSeparator);
}

function matchesName(name: string, pattern: string): boolean {
  if (!pattern.endsWith("*")) return name === pattern;
  return name.startsWith(pattern.slice(0, -1));
}

/** Decides whether an executable is permitted under the device policy. */
export function checkExecutable(policy: DevicePolicy, executable: string): PolicyDecision {
  if (policy.exec.mode === "disabled") {
    return { allowed: false, reason: "denied: process execution is disabled" };
  }
  if (policy.exec.allowedExecutables.length === 0) {
    return { allowed: true, reason: "delegated: default worker list" };
  }
  const wanted = executable.toLowerCase();
  const allowed = policy.exec.allowedExecutables.some((item) => item.toLowerCase() === wanted);
  return allowed
    ? { allowed: true, reason: "allowed: in list" }
    : { allowed: false, reason: `denied: ${executable} is not in list` };
}

export interface LoadedPolicy {
  policy: DevicePolicy;
  /** Source identifier: "file" if loaded from disk, "default" otherwise. */
  source: "file" | "default";
  path: string | undefined;
}

/**
 * Loads device policy from file, falling back to closed policy if file does not exist.
 */
export async function loadDevicePolicy(path: string): Promise<LoadedPolicy> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { policy: CLOSED_POLICY, source: "default", path: undefined };
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
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    );
  }
  return { policy: parsed.data, source: "file", path };
}

function describeYamlError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Invalid YAML — ${message.split("\n")[0] ?? message}`;
}

/**
 * Returns human-readable text description of loaded policy.
 */
export function describePolicy(loaded: LoadedPolicy): string {
  const { policy } = loaded;
  const lines: string[] = [];
  const list = (values: readonly string[], empty: string) =>
    values.length === 0 ? empty : values.join(", ");

  lines.push(`source: ${loaded.source}${loaded.path === undefined ? "" : ` (${loaded.path})`}`);
  lines.push("");
  lines.push("filesystem");
  lines.push(`  allowed roots        ${list(policy.filesystem.allow, "none — all denied")}`);
  lines.push(`  denied under         ${list(policy.filesystem.deny.under, "—")}`);
  lines.push(`  denied segments      ${list(policy.filesystem.deny.segments, "—")}`);
  lines.push(`  denied names         ${list(policy.filesystem.deny.names, "—")}`);
  lines.push(`  max file size        ${String(policy.filesystem.maxFileSizeMb)} MiB`);
  lines.push("");
  lines.push("execution");
  lines.push(`  mode                 ${policy.exec.mode}`);
  lines.push(
    `  executables          ${list(policy.exec.allowedExecutables, "default worker list")}`,
  );
  lines.push(
    `  environment          ${list(policy.exec.allowedEnv, "default worker list")}`,
  );
  lines.push(
    `  workdir roots        ${list(policy.exec.workdirRoots, "allowed roots above")}`,
  );
  lines.push(`  timeout              ${String(policy.exec.timeoutSec)} s`);
  lines.push("");
  lines.push("git and docker");
  lines.push(`  git write            ${policy.git.allowWrite ? "allowed" : "denied"}`);
  lines.push(`  docker               ${list(policy.docker.allowedSubcommands, "none")}`);
  lines.push("");
  lines.push(`egress network         ${policy.network.egress}`);
  return lines.join("\n");
}
