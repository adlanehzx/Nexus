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
 * Structured execution taking program name and argument array.
 */

export const terminalInputSchema = z.object({
  executable: z.string().min(1).max(128),
  args: z.array(z.string().max(4_096)).max(64).default([]),
  workingDirectory: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(1_800_000).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export type TerminalInput = z.infer<typeof terminalInputSchema>;

export const terminalInputJsonSchema = {
  type: "object",
  properties: {
    executable: {
      type: "string",
      description: 'Program to launch, by name only (e.g. "git"). Never a path.',
    },
    args: {
      type: "array",
      items: { type: "string" },
      description: "Arguments, one per element. Never assemble a command line string here.",
    },
    workingDirectory: { type: "string", description: "Working directory" },
    timeoutMs: { type: "number", description: "Maximum timeout in milliseconds" },
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
  env: Record<string, string | undefined>;
  defaultTimeoutMs: number;
}

export function createTerminalCapability(
  dependencies: TerminalDependencies,
): LocalCapability<TerminalInput, TerminalResult> {
  return {
    name: "terminal.execute",
    description:
      "Executes an allowed program with structured arguments on this computer. " +
      "Does not take a command line: specify the program and its arguments separately.",
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

      context.onProgress({ label: `${validated.executable} running` });

      const outcome = await dependencies.runner.run({
        executable: validated.executable,
        args: validated.args,
        cwd,
        env: validated.env,
        timeoutMs: input.timeoutMs ?? context.timeoutMs ?? dependencies.defaultTimeoutMs,
        signal: context.signal,
      });

      assertProcessSucceeded("terminal.execute", outcome);

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
