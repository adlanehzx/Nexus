import { z } from "zod";
import { redactText } from "@nexus/shared";
import type { LocalCapability } from "@nexus/worker-core";
import type { DockerPolicy } from "../policy/docker-policy.js";
import type { ProcessRunner } from "../runtime/process-runner.js";
import { assertProcessSucceeded } from "../runtime/process-runner.js";

/**
 * `docker.execute`.
 *
 * Même forme que le terminal, et même refus : pas de ligne de commande. Une
 * sous-commande choisie dans une liste, des arguments séparés.
 *
 * La sonde de disponibilité compte particulièrement ici. Sans elle, une machine
 * sans Docker annoncerait quand même la capacité, serait sélectionnée pour une
 * tâche Docker, et échouerait — après avoir écarté une machine qui, elle, aurait
 * su faire.
 */

export const dockerInputSchema = z.object({
  subcommand: z.string().min(1).max(32),
  args: z.array(z.string().max(1_024)).max(32).default([]),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});

export type DockerInput = z.infer<typeof dockerInputSchema>;

export interface DockerResult {
  subcommand: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface DockerDependencies {
  policy: DockerPolicy;
  runner: ProcessRunner;
  env: Record<string, string | undefined>;
  defaultTimeoutMs: number;
}

export function createDockerCapability(
  dependencies: DockerDependencies,
): LocalCapability<DockerInput, DockerResult> {
  return {
    name: "docker.execute",
    description:
      "Exécute une opération Docker autorisée sur cet ordinateur (consultation par défaut).",
    inputSchema: dockerInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        subcommand: {
          type: "string",
          description: "Sous-commande Docker, par exemple « ps » ou « logs »",
        },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["subcommand"],
    },
    riskLevel: "HIGH",

    probe: async () => {
      try {
        const outcome = await dependencies.runner.run({
          executable: "docker",
          args: ["version", "--format", "{{.Server.Version}}"],
          env: {},
          timeoutMs: 5_000,
        });
        return outcome.status === "completed";
      } catch {
        // Binaire absent : la sonde échoue, la capacité n'est pas annoncée.
        return false;
      }
    },

    execute: async (input, context): Promise<DockerResult> => {
      const args = dependencies.policy.validate({
        subcommand: input.subcommand,
        args: input.args,
      });

      context.onProgress({ label: `docker ${input.subcommand}` });

      const outcome = await dependencies.runner.run({
        executable: "docker",
        args,
        env: {},
        timeoutMs: input.timeoutMs ?? dependencies.defaultTimeoutMs,
        signal: context.signal,
      });

      assertProcessSucceeded("docker.execute", outcome);

      // Les journaux de conteneurs contiennent régulièrement des variables
      // d'environnement au démarrage — donc des secrets.
      return {
        subcommand: input.subcommand,
        exitCode: outcome.exitCode,
        stdout: redactText(outcome.stdout),
        stderr: redactText(outcome.stderr),
        durationMs: outcome.durationMs,
      };
    },
  };
}
