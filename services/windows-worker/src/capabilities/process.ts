import { z } from "zod";
import type { LocalCapability } from "@nexus/worker-core";
import type { ExecPolicy } from "../policy/exec-policy.js";
import type { PathPolicy } from "../policy/path-policy.js";
import type { ProcessInfo, ProcessRunner } from "../runtime/process-runner.js";
import { PolicyViolationError } from "../errors.js";

/**
 * `process.list`, `process.start`, `process.stop`.
 *
 * `process.stop` is restricted to processes launched by NEXUS itself.
 */

export const listInputSchema = z.object({
  nameContains: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

export const startInputSchema = z.object({
  executable: z.string().min(1).max(128),
  args: z.array(z.string().max(4_096)).max(64).default([]),
  workingDirectory: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const stopInputSchema = z.object({
  processId: z.number().int().positive(),
  force: z.boolean().default(false),
});

export type ListInput = z.infer<typeof listInputSchema>;
export type StartInput = z.infer<typeof startInputSchema>;
export type StopInput = z.infer<typeof stopInputSchema>;

export class OwnedProcessRegistry {
  readonly #owned = new Map<number, { executable: string; startedAt: string }>();

  claim(processId: number, executable: string, startedAt: string): void {
    this.#owned.set(processId, { executable, startedAt });
  }

  owns(processId: number): boolean {
    return this.#owned.has(processId);
  }

  release(processId: number): void {
    this.#owned.delete(processId);
  }

  list(): { processId: number; executable: string; startedAt: string }[] {
    return [...this.#owned.entries()].map(([processId, info]) => ({ processId, ...info }));
  }

  get size(): number {
    return this.#owned.size;
  }
}

export interface ProcessDependencies {
  runner: ProcessRunner;
  execPolicy: ExecPolicy;
  pathPolicy: PathPolicy;
  owned: OwnedProcessRegistry;
  env: Record<string, string | undefined>;
}

export function createProcessListCapability(
  dependencies: ProcessDependencies,
): LocalCapability<ListInput, { processes: ProcessInfo[]; total: number }> {
  return {
    name: "process.list",
    description: "Lists running processes on this computer.",
    inputSchema: listInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        nameContains: { type: "string", description: "Filter on process name" },
        limit: { type: "number" },
      },
    },
    riskLevel: "SAFE",

    execute: async (input) => {
      const all = await dependencies.runner.list();
      const filtered =
        input.nameContains === undefined
          ? all
          : all.filter((process) =>
              process.name.toLowerCase().includes(input.nameContains!.toLowerCase()),
            );

      return { processes: filtered.slice(0, input.limit), total: filtered.length };
    },
  };
}

export function createProcessStartCapability(
  dependencies: ProcessDependencies,
): LocalCapability<StartInput, { processId: number; executable: string; startedAt: string }> {
  return {
    name: "process.start",
    description: "Starts an allowed program in the background on this computer.",
    inputSchema: startInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        executable: { type: "string", description: "Allowed program by name" },
        args: { type: "array", items: { type: "string" } },
        workingDirectory: { type: "string" },
      },
      required: ["executable"],
    },
    riskLevel: "HIGH",

    execute: async (input) => {
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

      const started = await dependencies.runner.start({
        executable: validated.executable,
        args: validated.args,
        cwd,
        env: validated.env,
      });

      dependencies.owned.claim(started.processId, started.executable, started.startedAt);
      return started;
    },
  };
}

export function createProcessStopCapability(
  dependencies: ProcessDependencies,
): LocalCapability<StopInput, { processId: number; stopped: boolean }> {
  return {
    name: "process.stop",
    description: "Stops a process previously started by NEXUS on this computer.",
    inputSchema: stopInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        processId: { type: "number", description: "Process identifier" },
        force: { type: "boolean", description: "Force stop" },
      },
      required: ["processId"],
    },
    riskLevel: "HIGH",

    execute: async (input) => {
      if (!dependencies.owned.owns(input.processId)) {
        throw new PolicyViolationError({
          rule: "process.notOwned",
          message: `Process ${String(input.processId)} was not started by NEXUS`,
          userMessage: "NEXUS can only stop processes it started itself on this device.",
          context: { processId: input.processId },
        });
      }

      const stopped = await dependencies.runner.stop(input.processId, input.force);
      if (stopped) dependencies.owned.release(input.processId);

      return { processId: input.processId, stopped };
    },
  };
}
