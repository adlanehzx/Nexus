import { z } from "zod";
import type { LocalCapability } from "@nexus/worker-core";
import type { ProcessRunner } from "../runtime/process-runner.js";
import { ExecutableNotAllowedError } from "../errors.js";

/**
 * `app.open` — opens an application on the user's screen.
 */

export const appOpenInputSchema = z.object({
  app: z.string().min(1).max(64),
});

export type AppOpenInput = z.infer<typeof appOpenInputSchema>;

export interface AppOpenResult {
  app: string;
  processId: number;
  startedAt: string;
}

export interface AppDependencies {
  runner: ProcessRunner;
  applications: ReadonlyMap<string, string>;
  env: Record<string, string | undefined>;
  allowedEnv: readonly string[];
}

export function createAppOpenCapability(
  dependencies: AppDependencies,
): LocalCapability<AppOpenInput, AppOpenResult> {
  const known = [...dependencies.applications.keys()].sort();

  return {
    name: "app.open",
    description:
      "Opens an application installed on this computer on the user's screen. " +
      `Known applications: ${known.length === 0 ? "none" : known.join(", ")}. ` +
      "Accepts only one of these names — neither path nor arguments.",
    inputSchema: appOpenInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        app: {
          type: "string",
          description: "Name of application to open",
          ...(known.length === 0 ? {} : { enum: known }),
        },
      },
      required: ["app"],
    },
    riskLevel: "MEDIUM",

    execute: async (input): Promise<AppOpenResult> => {
      const name = input.app.trim().toLowerCase();
      const executable = dependencies.applications.get(name);

      if (executable === undefined) {
        throw new ExecutableNotAllowedError(
          `${input.app} (known: ${known.length === 0 ? "none" : known.join(", ")})`,
        );
      }

      const env: Record<string, string> = {};
      for (const variable of dependencies.allowedEnv) {
        const value = dependencies.env[variable];
        if (value !== undefined) env[variable] = value;
      }

      const started = await dependencies.runner.start({
        executable,
        args: [],
        env,
      });

      return { app: name, processId: started.processId, startedAt: started.startedAt };
    },
  };
}

export function parseApplications(entries: readonly string[]): Map<string, string> {
  const applications = new Map<string, string>();

  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;

    const name = entry.slice(0, separator).trim().toLowerCase();
    const executable = entry.slice(separator + 1).trim();

    if (name.length === 0 || executable.length === 0) continue;
    if (name.includes("\0") || executable.includes("\0")) continue;

    applications.set(name, executable);
  }

  return applications;
}
