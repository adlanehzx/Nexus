import { z } from "zod";
import { redactText } from "@nexus/shared";
import type { LocalCapability } from "@nexus/worker-core";
import type { DockerPolicy } from "../policy/docker-policy.js";
import type { ProcessRunner } from "../runtime/process-runner.js";
import { assertProcessSucceeded } from "../runtime/process-runner.js";

/**
 * `docker.execute`.
 *
 * Runs allowed Docker subcommands.
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
    description: "Executes an allowed Docker operation on this computer (inspection by default).",
    inputSchema: dockerInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        subcommand: {
          type: "string",
          description: 'Docker subcommand, e.g. "ps" or "logs"',
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
