import { z } from "zod";
import type { LocalCapability } from "@nexus/worker-core";
import type { ProcessRunner } from "../runtime/process-runner.js";
import { PolicyViolationError } from "../errors.js";

/**
 * `browser.open`.
 *
 * Opens a web page in the user's desktop browser.
 */

export const browserOpenInputSchema = z.object({
  url: z.string().url().max(2_048),
});

export type BrowserOpenInput = z.infer<typeof browserOpenInputSchema>;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export interface BrowserDependencies {
  runner: ProcessRunner;
  env: Record<string, string | undefined>;
}

export function createBrowserOpenCapability(
  dependencies: BrowserDependencies,
): LocalCapability<BrowserOpenInput, { url: string; opened: boolean }> {
  return {
    name: "browser.open",
    description:
      "Opens a web page in the user's browser on their screen. " +
      "Does not automate browsing: to navigate or interact, NEXUS uses its dedicated browser worker.",
    inputSchema: browserOpenInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: { url: { type: "string", description: "http(s) address to open" } },
      required: ["url"],
    },
    riskLevel: "LOW",

    execute: async (input) => {
      const url = new URL(input.url);
      if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
        throw new PolicyViolationError({
          rule: "browser.protocol",
          message: `URL scheme not allowed: ${url.protocol}`,
          userMessage: "Only http and https addresses can be opened.",
          context: { protocol: url.protocol },
        });
      }

      const outcome = await dependencies.runner.run({
        executable: "rundll32",
        args: ["url.dll,FileProtocolHandler", url.toString()],
        env: {},
        timeoutMs: 10_000,
      });

      return { url: url.toString(), opened: outcome.status === "completed" };
    },
  };
}
