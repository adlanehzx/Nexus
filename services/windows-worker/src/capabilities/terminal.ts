import { z } from "zod";
import { redactText } from "@nexus/shared";
import type { LocalCapability } from "@nexus/worker-core";
import type { ExecPolicy } from "../policy/exec-policy.js";
import type { PathPolicy } from "../policy/path-policy.js";
import type { ProcessRunner } from "../runtime/process-runner.js";
import { assertProcessSucceeded } from "../runtime/process-runner.js";

/**
 * `terminal.execute`.
 *
 * L'API est structurée, et c'est le point central de tout ce paquet. Il n'existe
 * **aucun** champ `command: string` : le cœur envoie un exécutable choisi dans
 * une liste et des arguments qui resteront des arguments.
 *
 * Écrire `{ command: "git status" }` obligerait le worker à découper la chaîne,
 * donc à réimplémenter les règles de découpage d'un shell — et à se tromper,
 * comme tout le monde s'y trompe. Écrire `{ executable: "git", args: ["status"] }`
 * supprime la question.
 */

export const terminalInputSchema = z.object({
  /** Nom d'un programme autorisé. Ni chemin, ni chaîne de commande. */
  executable: z.string().min(1).max(128),
  args: z.array(z.string().max(4_096)).max(64).default([]),
  /** Doit tomber sous une racine autorisée, comme n'importe quel chemin. */
  workingDirectory: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(1_800_000).optional(),
  /** Variables transmises. Bornées par la liste blanche de la politique. */
  env: z.record(z.string(), z.string()).optional(),
});

export type TerminalInput = z.infer<typeof terminalInputSchema>;

export const terminalInputJsonSchema = {
  type: "object",
  properties: {
    executable: {
      type: "string",
      description: "Programme à lancer, par son nom seul (ex. « git »). Jamais un chemin.",
    },
    args: {
      type: "array",
      items: { type: "string" },
      description: "Arguments, un par élément. Ne jamais assembler une ligne de commande ici.",
    },
    workingDirectory: { type: "string", description: "Répertoire de travail" },
    timeoutMs: { type: "number", description: "Délai maximal en millisecondes" },
  },
  required: ["executable"],
} as const;

export interface TerminalResult {
  processId: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  status: string;
  truncated: boolean;
}

export interface TerminalDependencies {
  execPolicy: ExecPolicy;
  pathPolicy: PathPolicy;
  runner: ProcessRunner;
  /** Environnement du worker, filtré par la politique avant transmission. */
  env: Record<string, string | undefined>;
  defaultTimeoutMs: number;
}

export function createTerminalCapability(
  dependencies: TerminalDependencies,
): LocalCapability<TerminalInput, TerminalResult> {
  return {
    name: "terminal.execute",
    description:
      "Exécute un programme autorisé avec des arguments structurés sur cet ordinateur. " +
      "Ne prend pas de ligne de commande : indiquer le programme et ses arguments séparément.",
    inputSchema: terminalInputSchema,
    inputJsonSchema: terminalInputJsonSchema,
    riskLevel: "HIGH",

    execute: async (input, context): Promise<TerminalResult> => {
      const validated = dependencies.execPolicy.validate(
        {
          executable: input.executable,
          args: input.args,
          ...(input.env === undefined ? {} : { env: input.env }),
        },
        dependencies.env,
      );

      const cwd =
        input.workingDirectory === undefined
          ? undefined
          : await dependencies.pathPolicy.resolve(input.workingDirectory);

      context.onProgress({ label: `${validated.executable} en cours` });

      const outcome = await dependencies.runner.run({
        executable: validated.executable,
        args: validated.args,
        cwd,
        env: validated.env,
        timeoutMs: input.timeoutMs ?? context.timeoutMs ?? dependencies.defaultTimeoutMs,
        signal: context.signal,
      });

      assertProcessSucceeded("terminal.execute", outcome);

      // La rédaction s'applique ici, avant que quoi que ce soit ne quitte la
      // machine. Ce qu'un programme écrit sur sa sortie n'est pas maîtrisé : un
      // script de déploiement qui affiche son jeton ne doit pas le faire entrer
      // dans le journal du cœur.
      return {
        processId: outcome.processId,
        exitCode: outcome.exitCode,
        stdout: redactText(outcome.stdout),
        stderr: redactText(outcome.stderr),
        durationMs: outcome.durationMs,
        status: outcome.status,
        truncated: outcome.truncated,
      };
    },
  };
}
