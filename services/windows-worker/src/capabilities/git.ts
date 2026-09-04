import { z } from "zod";
import { redactText } from "@nexus/shared";
import type { LocalCapability } from "@nexus/worker-core";
import type { GitOperation, GitPolicy } from "../policy/git-policy.js";
import type { PathPolicy } from "../policy/path-policy.js";
import type { ProcessRunner } from "../runtime/process-runner.js";
import { assertProcessSucceeded } from "../runtime/process-runner.js";

/**
 * Capacités Git.
 *
 * Sept capacités distinctes plutôt qu'un `git.execute` unique. La différence
 * n'est pas cosmétique : elle est ce qui permet à l'utilisateur d'accorder
 * `git.status` sans accorder `git.checkout`, et au cœur d'exiger une
 * confirmation pour l'une et pas pour l'autre.
 *
 * Un `git.execute` générique rendrait tout cela impossible — il faudrait
 * inspecter les arguments pour deviner l'intention, c'est-à-dire réintroduire
 * l'analyse de chaînes que ce worker refuse partout ailleurs.
 *
 * Les niveaux de risque viennent de `GitPolicy` et alimentent `PermissionService`
 * et `ConfirmationService` du cœur. Le worker déclare ; le cœur tranche.
 */

const repositorySchema = z.object({
  /** Dépôt local, sous une racine autorisée. */
  repositoryPath: z.string().min(1).max(4_096),
});

export const gitStatusInputSchema = repositorySchema;
export const gitDiffInputSchema = repositorySchema.extend({
  /** Limité aux fichiers indexés si vrai. */
  staged: z.boolean().default(false),
  path: z.string().max(4_096).optional(),
});
export const gitBranchInputSchema = repositorySchema;
export const gitPullInputSchema = repositorySchema.extend({
  remote: z.string().max(128).default("origin"),
});
export const gitCheckoutInputSchema = repositorySchema.extend({
  /**
   * Branche existante. Pas de création implicite : trop facile à confondre.
   *
   * Le nom ne peut pas commencer par « - » : Git relirait `--orphan` ou
   * `--force` comme une option, et l'argument cesserait d'être un argument.
   */
  branch: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9_][A-Za-z0-9._\-/]*$/, "nom de branche invalide"),
});
export const gitCommitInputSchema = repositorySchema.extend({
  message: z.string().min(1).max(4_096),
  /** Indexe tout le suivi avant de valider. */
  all: z.boolean().default(false),
});
export const gitCloneInputSchema = z.object({
  url: z.string().min(1).max(2_048),
  /** Dossier de destination, sous une racine autorisée. */
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

/**
 * Environnement d'un appel Git.
 *
 * `GIT_TERMINAL_PROMPT=0` est essentiel : sans lui, un dépôt privé fait attendre
 * Git sur une invite de mot de passe que personne ne verra jamais, et l'étape
 * expire au bout de cinq minutes au lieu d'échouer tout de suite.
 *
 * `GIT_ASKPASS` vide ferme la seconde porte : l'invite graphique.
 */
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

  // Une URL de dépôt contenant un jeton (`https://x-token:ghp_…@github.com/…`)
  // est recopiée telle quelle par Git dans ses messages d'erreur.
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
  properties: { repositoryPath: { type: "string", description: "Chemin du dépôt local" } },
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
      description: "Affiche l'état d'un dépôt Git local.",
      inputSchema: gitStatusInputSchema,
      argsFor: () => ["status", "--porcelain=v1", "--branch"],
      dependencies,
    }),

    makeRepositoryCapability({
      operation: "diff",
      description: "Affiche les modifications d'un dépôt Git local.",
      inputSchema: gitDiffInputSchema,
      inputJsonSchema: {
        type: "object",
        properties: {
          repositoryPath: { type: "string" },
          staged: { type: "boolean", description: "Limiter aux fichiers indexés" },
          path: { type: "string", description: "Restreindre à un chemin" },
        },
        required: ["repositoryPath"],
      },
      argsFor: (input) => [
        "diff",
        ...(input.staged ? ["--staged"] : []),
        // `--` ferme la liste des options : un chemin nommé `--upload-pack=…`
        // ne peut plus être relu comme une option de Git.
        ...(input.path === undefined ? [] : ["--", input.path]),
      ],
      dependencies,
    }),

    makeRepositoryCapability({
      operation: "branch",
      description: "Liste les branches d'un dépôt Git local.",
      inputSchema: gitBranchInputSchema,
      argsFor: () => ["branch", "--list", "--all", "--no-color"],
      dependencies,
    }),

    makeRepositoryCapability({
      operation: "pull",
      description: "Récupère et fusionne les modifications distantes d'un dépôt Git local.",
      inputSchema: gitPullInputSchema,
      inputJsonSchema: {
        type: "object",
        properties: {
          repositoryPath: { type: "string" },
          remote: { type: "string", description: "Dépôt distant, par défaut « origin »" },
        },
        required: ["repositoryPath"],
      },
      argsFor: (input) => ["pull", "--ff-only", input.remote],
      dependencies,
    }),

    makeRepositoryCapability({
      operation: "checkout",
      description: "Bascule un dépôt Git local sur une branche existante.",
      inputSchema: gitCheckoutInputSchema,
      inputJsonSchema: {
        type: "object",
        properties: {
          repositoryPath: { type: "string" },
          branch: { type: "string", description: "Branche existante" },
        },
        required: ["repositoryPath", "branch"],
      },
      // Le « -- » final ferme la liste des options après la branche : Git ne
      // peut plus relire quoi que ce soit comme un drapeau.
      argsFor: (input) => ["checkout", input.branch, "--"],
      dependencies,
    }),

    makeRepositoryCapability({
      operation: "commit",
      description: "Enregistre une révision dans un dépôt Git local.",
      inputSchema: gitCommitInputSchema,
      inputJsonSchema: {
        type: "object",
        properties: {
          repositoryPath: { type: "string" },
          message: { type: "string", description: "Message de révision" },
          all: { type: "boolean", description: "Indexer les fichiers suivis modifiés" },
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

/**
 * `git.clone` — le seul qui parle à l'extérieur.
 *
 * Deux vérifications que les autres n'ont pas : l'hôte du dépôt doit être
 * autorisé, et la destination doit tomber sous une racine autorisée. Sans la
 * seconde, un clone écrirait où bon lui semble.
 */
function createGitCloneCapability(
  dependencies: GitDependencies,
): LocalCapability<z.infer<typeof gitCloneInputSchema>, GitResult> {
  return {
    name: "git.clone",
    description: "Clone un dépôt Git distant autorisé dans un dossier autorisé.",
    inputSchema: gitCloneInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Adresse du dépôt" },
        destination: { type: "string", description: "Dossier de destination" },
        depth: { type: "number", description: "Profondeur d'historique" },
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
