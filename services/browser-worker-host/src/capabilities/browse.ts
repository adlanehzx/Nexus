import { z } from "zod";
import type { LocalCapability } from "@nexus/worker-core";
import type { BrowserWorkerClient } from "@nexus/browser-client";
import type { BrowserEvent, BrowserIntent, BrowserTask } from "@nexus/browser-client";
import type { RiskLevel } from "@nexus/tools";
import { BrowserTaskFailedError, HumanVerificationRequiredError } from "../errors.js";
import type { SessionPool } from "../runtime/session-pool.js";

/**
 * `browser.*` capabilities for the browser worker host.
 *
 * Dedicated capabilities per intent (navigate, interact, login, purchase)
 * map directly to permissions and risk levels.
 */

export const browseInputSchema = z.object({
  /** Natural language instructions. */
  instructions: z.string().min(3).max(4_000),
  /** Starting URL. HTTP and HTTPS only. */
  url: z
    .string()
    .url()
    .refine(
      (value) => {
        const protocol = URL.parse(value)?.protocol;
        return protocol === "http:" || protocol === "https:";
      },
      { message: "only http:// and https:// are accepted" },
    )
    .optional(),
  /** Maximum task steps. */
  maxSteps: z.number().int().min(1).max(50).optional(),
});

export type BrowseInput = z.infer<typeof browseInputSchema>;

export interface BrowseResult {
  output: string;
  status: string;
  steps: number;
  durationMs: number;
  visitedUrl: string | null;
  sessionId: string;
}

export interface BrowseDependencies {
  client: BrowserWorkerClient;
  sessions: SessionPool;
  maxSteps: number;
}

interface IntentSpec {
  capability: string;
  intent: BrowserIntent;
  riskLevel: RiskLevel;
  description: string;
}

export const BROWSER_INTENTS: readonly IntentSpec[] = [
  {
    capability: "browser.navigate",
    intent: "read",
    riskLevel: "LOW",
    description:
      "Open a web page and extract information: prices, schedules, availability, content. " +
      "READ ONLY — does not click action buttons, fill forms, or sign in. " +
      "Use for general web research.",
  },
  {
    capability: "browser.interact",
    intent: "interact",
    riskLevel: "MEDIUM",
    description:
      "Interact with a web page: click, fill forms, filter, search. " +
      "Does not sign in or execute payments.",
  },
  {
    capability: "browser.login",
    intent: "login",
    riskLevel: "HIGH",
    description:
      "Sign in to a website with existing user credentials. " +
      "NEVER bypasses CAPTCHA or two-factor authentication: if challenged, halts and returns control to user.",
  },
  {
    capability: "browser.purchase",
    intent: "purchase",
    riskLevel: "CRITICAL",
    description:
      "Finalize a purchase or paid reservation. IRREVERSIBLE, financially binding action. " +
      "Only execute after displaying exact amount and obtaining explicit user confirmation.",
  },
];

export function createBrowseCapabilities(
  dependencies: BrowseDependencies,
): LocalCapability<BrowseInput, BrowseResult>[] {
  return BROWSER_INTENTS.map((spec) => createBrowseCapability(spec, dependencies));
}

function createBrowseCapability(
  spec: IntentSpec,
  dependencies: BrowseDependencies,
): LocalCapability<BrowseInput, BrowseResult> {
  return {
    name: spec.capability,
    description: spec.description,
    version: "1",
    inputSchema: browseInputSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        instructions: {
          type: "string",
          description: "What to achieve, in natural language",
        },
        url: { type: "string", description: "Starting web page" },
        maxSteps: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["instructions"],
    },
    riskLevel: spec.riskLevel,

    probe: async (): Promise<boolean> => {
      try {
        await dependencies.client.health();
        return true;
      } catch {
        return false;
      }
    },

    execute: async (input, context): Promise<BrowseResult> => {
      const sessionId = await dependencies.sessions.acquire(context.taskId, context.signal);

      const instructions =
        input.url === undefined
          ? input.instructions
          : `Go to ${input.url}, then: ${input.instructions}`;

      const started = await dependencies.client.runTask(
        {
          taskId: `${context.taskId}-${context.stepId}`.slice(0, 120),
          sessionId,
          instructions,
          intent: spec.intent,
          maxSteps: Math.min(input.maxSteps ?? dependencies.maxSteps, dependencies.maxSteps),
        },
        context.signal,
      );

      let visitedUrl: string | null = null;

      const finished = await dependencies.client.waitForTask(started.taskId, {
        signal: context.signal,
        onEvent: (event) => {
          if (event.type === "navigation") visitedUrl = event.url;
          const progress = describeEvent(event);
          if (progress !== undefined) context.onProgress(progress);
        },
      });

      return finalize(spec, finished, sessionId, visitedUrl);
    },
  };
}

function finalize(
  spec: IntentSpec,
  task: BrowserTask,
  sessionId: string,
  visitedUrl: string | null,
): BrowseResult {
  if (task.status === "needs_human") {
    throw new HumanVerificationRequiredError(
      spec.capability,
      task.error?.message ??
        "The site requires human verification (CAPTCHA or two-factor authentication). " +
          "Autonomous bypass is prohibited: please complete this step, then instruct me to continue.",
    );
  }

  if (task.status !== "succeeded") {
    throw new BrowserTaskFailedError(spec.capability, {
      status: task.status,
      code: task.error?.code,
      message: task.error?.message,
      retryable: task.error?.retryable ?? false,
    });
  }

  return {
    output: task.output ?? "",
    status: task.status,
    steps: task.steps,
    durationMs: task.durationMs ?? 0,
    visitedUrl,
    sessionId,
  };
}

function describeEvent(event: BrowserEvent): { percent?: number; label?: string } | undefined {
  switch (event.type) {
    case "navigation":
      return { label: `Opening ${hostOf(event.url)}` };
    case "action":
      return { label: `${event.action}${event.target === null ? "" : `: ${event.target}`}` };
    case "thinking":
      return { label: event.text.slice(0, 120) };
    case "progress":
      return {
        label: `Step ${String(event.step)}/${String(event.maxSteps)}`,
        percent: Math.round((event.step / event.maxSteps) * 100),
      };
    default:
      return undefined;
  }
}

function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).host : url.slice(0, 60);
}
