import { z } from "zod";
import { redactText } from "@nexus/shared";
import type { LocalCapability } from "@nexus/worker-core";
import type { GitOperation, GitPolicy } from "../policy/git-policy.js";
import type { PathPolicy } from "../policy/path-policy.js";
import type { ProcessRunner } from "../runtime/process-runner.js";
import { assertProcessSucceeded } from "../runtime/process-runner.js";

/**
 * Git capabilities.
 *
 * Dedicated capabilities per operation: status, diff, branch, pull, checkout, commit, clone.
 */

const repositorySchema = z.object({
  repositoryPath: z.string().min(1).max(4_096),
});

export const gitStatusInputSchema = repositorySchema;
export const gitDiffInputSchema = repositorySchema.extend({
  staged: z.boolean().default(false),
  path: z.string().max(4_096).optional(),
});
export const gitBranchInputSchema = repositorySchema;
export const gitPullInputSchema = repositorySchema.extend({
  remote: z.string().max(128).default("origin"),
});
export const gitCheckoutInputSchema = repositorySchema.extend({
  branch: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9_][A-Za-z0-9._\-/]*$/, "invalid branch name"),
});
export const gitCommitInputSchema = repositorySchema.extend({
  message: z.string().min(1).max(4_096),
  all: z.boolean().default(false),
});
export const gitCloneInputSchema = z.object({
  url: z.string().min(1).max(2_048),
  destination: z.string().min(1).max(4_096),
  depth: z.number().int().min(1).max(1_000).optional(),
});

export interface GitResult {
  operation: GitOperation;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface GitDependencies {
  policy: GitPolicy;
  pathPolicy: PathPolicy;
  runner: ProcessRunner;
  env: Record<string, string | undefined>;
  defaultTimeoutMs: number;
}

function gitEnv(env: Record<string, string | undefined>): Record<string, string> {
  const passthrough: Record<string, string> = {};
  for (const name of ["PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    const value = env[name];
    if (value !== undefined) passthrough[name] = value;
  }
  return { ...passthrough, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never" };
}

async function runGit(
  dependencies: GitDependencies,
  operation: GitOperation,
  args: string[],
  cwd: string | undefined,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<GitResult> {
  const outcome = await dependencies.runner.run({
    executable: "git",
    args,
    cwd,
    env: gitEnv(dependencies.env),
    timeoutMs,
    signal,
  });

  assertProcessSucceeded(`git.${operation}`, outcome);

  return {
    operation,
    exitCode: outcome.exitCode,
    stdout: redactText(outcome.stdout),
    stderr: redactText(outcome.stderr),
    durationMs: outcome.durationMs,
  };
}

const repositoryJsonSchema = {
  type: "object",
  properties: { repositoryPath: { type: "string", description: "Path to local repository" } },
  required: ["repositoryPath"],
} as const;

function makeRepositoryCapability<I extends { repositoryPath: string }>(options: {
  operation: GitOperation;
  description: string;
  inputSchema: z.ZodType<I>;
  inputJsonSchema?: Record<string, unknown>;
  argsFor: (input: I) => string[];
  dependencies: GitDependencies;
}): LocalCapability<I, GitResult> {
  const { dependencies, operation } = options;

  return {
    name: `git.${operation}`,
    description: options.description,
    inputSchema: options.inputSchema,
    inputJsonSchema: options.inputJsonSchema ?? repositoryJsonSchema,
    riskLevel: dependencies.policy.riskFor(operation),

    probe: async () => {
      try {
        const outcome = await dependencies.runner.run({
          executable: "git",
          args: ["--version"],
          env: gitEnv(dependencies.env),
          timeoutMs: 5_000,
        });
        return outcome.status === "completed";
      } catch {
        return false;
      }
    },

    execute: async (input, context) => {
      dependencies.policy.assertAllowed(operation);
      const cwd = await dependencies.pathPolicy.resolve(input.repositoryPath);
      context.onProgress({ label: `git ${operation}` });

      return runGit(
        dependencies,
        operation,
        options.argsFor(input),
        cwd,
        context.signal,
        context.timeoutMs || dependencies.defaultTimeoutMs,
      );
    },
  };
}

export function createGitCapabilities(
  dependencies: GitDependencies,
): LocalCapability<never, unknown>[] {
  const capabilities = [
    makeRepositoryCapability({
      operation: "status",
      description: "Displays the status of a local Git repository.",
      inputSchema: gitStatusInputSchema,
      argsFor: () => ["status", "--porcelain=v1", "--branch"],
      dependencies,
    }),

    makeRepositoryCapability({
      operation: "diff",
      description: "Displays changes in a local Git repository.",
      inputSchema: gitDiffInputSchema,
      inputJsonSchema: {
        type: "object",
        properties: {
          repositoryPath: { type: "string" },
          staged: { type: "boolean", description: "Limit to staged files" },
          path: { type: "string", description: "Restrict to path" },
        },
        required: ["repositoryPath"],
      },
      argsFor: (input) => [
        "diff",
        ...(input.staged ? ["--staged"] : []),
        ...(input.path === undefined ? [] : ["--", input.path]),
      ],
      dependencies,
    }),

    makeRepositoryCapability({
      operation: "branch",
      description: "Lists branches of a local Git repository.",
      inputSchema: gitBranchInputSchema,
      argsFor: () => ["branch", "--list", "--all", "--no-color"],
      dependencies,
    }),

    makeRepositoryCapability({
      operation: "pull",
      description: "Fetches and merges remote changes into a local Git repository.",
      inputSchema: gitPullInputSchema,
      inputJsonSchema: {
        type: "object",
        properties: {
          repositoryPath: { type: "string" },
          remote: { type: "string", description: 'Remote name, defaults to "origin"' },
        },
        required: ["repositoryPath"],
      },
      argsFor: (input) => ["pull", "--ff-only", input.remote],
      dependencies,
    }),

    makeRepositoryCapability({
      operation: "checkout",
      description: "Switches a local Git repository to an existing branch.",
      inputSchema: gitCheckoutInputSchema,
      inputJsonSchema: {
        type: "object",
        properties: {
          repositoryPath: { type: "string" },
          branch: { type: "string", description: "Existing branch" },
        },
        required: ["repositoryPath", "branch"],
      },
      argsFor: (input) => ["checkout", input.branch, "--"],
      dependencies,
    }),

    makeRepositoryCapability({
      operation: "commit",
      description: "Records a revision in a local Git repository.",
      inputSchema: gitCommitInputSchema,
      inputJsonSchema: {
        type: "object",
        properties: {
          repositoryPath: { type: "string" },
          message: { type: "string", description: "Commit message" },
          all: { type: "boolean", description: "Stage all modified tracked files" },
        },
        required: ["repositoryPath", "message"],
      },
      argsFor: (input) => ["commit", ...(input.all ? ["--all"] : []), "--message", input.message],
      dependencies,
    }),

    createGitCloneCapability(dependencies),
  ];

  return capabilities as unknown as LocalCapability<never, unknown>[];
}

function createGitCloneCapability(
  dependencies: GitDependencies,
): LocalCapability<z.infer<typeof gitCloneInputSchema>, GitResult> {
  return {
    name: "git.clone",
    description: "Clones an allowed remote Git repository into an allowed folder.",
    inputSchema: gitCloneInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Repository address" },
        destination: { type: "string", description: "Destination folder" },
        depth: { type: "number", description: "History depth" },
      },
      required: ["url", "destination"],
    },
    riskLevel: dependencies.policy.riskFor("clone"),

    execute: async (input, context) => {
      dependencies.policy.assertAllowed("clone");
      dependencies.policy.assertRemoteAllowed(input.url);

      const destination = await dependencies.pathPolicy.resolve(input.destination);
      context.onProgress({ label: "git clone" });

      return runGit(
        dependencies,
        "clone",
        [
          "clone",
          ...(input.depth === undefined ? [] : ["--depth", String(input.depth)]),
          "--",
          input.url,
          destination,
        ],
        undefined,
        context.signal,
        context.timeoutMs || dependencies.defaultTimeoutMs,
      );
    },
  };
}
