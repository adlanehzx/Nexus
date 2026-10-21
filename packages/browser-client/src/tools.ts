import { z } from "zod";
import type { Permission, RiskLevel, ToolDefinition } from "@nexus/tools";
import { type BrowserWorkerClient, BrowserWorkerError } from "./client.js";
import {
  INTENT_PERMISSIONS,
  type BrowserEvent,
  type BrowserIntent,
  type BrowserTask,
} from "./protocol.js";

/**
 * `browser.*` tools exposed to the agent.
 *
 * One tool per **intent**, rather than a single generic tool. This is what
 * enables the permission system to do its job: reading the price of a
 * ticket and purchasing that ticket are not the same action, and cannot
 * carry the same risk level or confirmation requirements.
 *
 * The intent is not declarative: the worker genuinely restricts what the
 * browser can do (see `services/browser-worker/app/policies.py`). A
 * `browser.read` call cannot click, even if the model requests it.
 */

const taskInputSchema = z.object({
  /** What the agent wants to achieve, in natural language. */
  instructions: z.string().min(3).max(4_000),
  /** Starting point. Without it, instructions must specify where to go. */
  url: z.string().optional(),
  /** Reuses an open session — required for multi-step workflows. */
  sessionId: z.string().optional(),
  maxSteps: z.number().int().min(1).max(50).optional(),
});
type TaskInput = z.infer<typeof taskInputSchema>;

const taskOutputSchema = z.object({
  sessionId: z.string(),
  status: z.string(),
  output: z.string(),
  steps: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  /** True if the site requires human intervention (CAPTCHA, MFA, 2FA). */
  needsHuman: z.boolean(),
  visitedUrl: z.string().nullable(),
});
type TaskOutput = z.infer<typeof taskOutputSchema>;

export interface BrowserToolsOptions {
  client: BrowserWorkerClient;
  /** Restricts browsing. Highly recommended in production. */
  allowedDomains?: string[];
  prohibitedDomains?: string[];
  defaultMaxSteps?: number;
  sessionTtlSeconds?: number;
  headless?: boolean;
}

interface IntentSpec {
  name: string;
  intent: BrowserIntent;
  risk: RiskLevel;
  requiresConfirmation: boolean;
  description: string;
}

const INTENTS: IntentSpec[] = [
  {
    name: "browser.read",
    intent: "read",
    risk: "SAFE",
    requiresConfirmation: false,
    description:
      "Opens a page and extracts information (prices, schedules, availability, content). READ-ONLY: does not click, does not fill forms, does not log into anything. Use this for all web information retrieval.",
  },
  {
    name: "browser.interact",
    intent: "interact",
    risk: "MEDIUM",
    requiresConfirmation: true,
    description:
      "Interacts with a page: click, fill forms, filter, search. Does not log in or make payments. Requires user confirmation.",
  },
  {
    name: "browser.login",
    intent: "login",
    risk: "HIGH",
    requiresConfirmation: true,
    description:
      "Logs into a site using credentials already registered by the user. NEVER bypasses a CAPTCHA or two-factor authentication: if the site asks for one, the task stops and yields to the user.",
  },
  {
    name: "browser.purchase",
    intent: "purchase",
    risk: "CRITICAL",
    requiresConfirmation: true,
    description:
      "Finalizes a purchase or paid booking. IRREVERSIBLE and financially binding action. Only use after presenting the exact amount and obtaining explicit user confirmation.",
  },
];

/** Builds browser tools for the registry. */
export function createBrowserTools(options: BrowserToolsOptions): ToolDefinition<never, unknown>[] {
  const tools: ToolDefinition<TaskInput, TaskOutput>[] = INTENTS.map((spec) =>
    makeTaskTool(spec, options),
  );

  return [...tools, makeCloseTool(options)] as unknown as ToolDefinition<never, unknown>[];
}

function makeTaskTool(
  spec: IntentSpec,
  options: BrowserToolsOptions,
): ToolDefinition<TaskInput, TaskOutput> {
  return {
    name: spec.name,
    description: spec.description,
    version: "1",
    inputSchema: taskInputSchema,
    outputSchema: taskOutputSchema,
    riskLevel: spec.risk,
    requiredPermissions: INTENT_PERMISSIONS[spec.intent] as Permission[],
    requiresConfirmation: spec.requiresConfirmation,
    // A browser action is never retried automatically: we cannot know
    // whether the first attempt already clicked on "Pay".
    idempotent: spec.intent === "read",
    timeoutMs: 15 * 60_000,
    summarize: (input) =>
      `${spec.name} — ${input.url ?? "current page"} : ${input.instructions.slice(0, 160)}`,

    execute: async (input, context): Promise<TaskOutput> => {
      const client = options.client;

      const sessionId =
        input.sessionId ??
        (
          await client.createSession(
            {
              ownerId: context.userId,
              allowedDomains: options.allowedDomains ?? [],
              prohibitedDomains: options.prohibitedDomains ?? [],
              headless: options.headless ?? true,
              ttlSeconds: options.sessionTtlSeconds ?? 600,
              metadata: { runId: context.runId },
            },
            context.signal,
          )
        ).sessionId;

      const instructions =
        input.url === undefined
          ? input.instructions
          : `Go to ${input.url}, then: ${input.instructions}`;

      const task = await client.runTask(
        {
          taskId: context.idempotencyKey.slice(0, 120),
          sessionId,
          instructions,
          intent: spec.intent,
          maxSteps: input.maxSteps ?? options.defaultMaxSteps ?? 15,
        },
        context.signal,
      );

      let visitedUrl: string | null = null;

      const finished = await client.waitForTask(task.taskId, {
        ...(context.signal ? { signal: context.signal } : {}),
        onEvent: (event) => {
          if (event.type === "navigation") visitedUrl = event.url;
          const progress = describeEvent(event);
          if (progress !== undefined) context.onProgress(progress);
        },
      });

      return finalize(finished, sessionId, visitedUrl);
    },
  };
}

function finalize(task: BrowserTask, sessionId: string, visitedUrl: string | null): TaskOutput {
  const base = {
    sessionId,
    status: task.status,
    steps: task.steps,
    durationMs: task.durationMs ?? 0,
    visitedUrl,
  };

  if (task.status === "needs_human") {
    // We never bypass protections: yield control. The message is
    // written so the agent can relay it as-is to the user.
    return {
      ...base,
      needsHuman: true,
      output:
        task.error?.message ??
        "The site requires human verification (CAPTCHA or two-factor authentication). This cannot be bypassed: please complete this step manually, then ask me to continue.",
    };
  }

  if (task.status !== "succeeded") {
    throw new BrowserWorkerError(task.error?.code ?? "BROWSER_TASK_FAILED", {
      message: task.error?.message ?? `Browser task finished with status ${task.status}`,
      userMessage:
        task.error?.message ?? `Browsing finished without a result (${task.status}).`,
      retryable: task.error?.retryable ?? false,
    });
  }

  return { ...base, needsHuman: false, output: task.output ?? "" };
}

/** Translates a worker event into a human-readable progress report. */
function describeEvent(event: BrowserEvent): { label?: string; pct?: number } | undefined {
  switch (event.type) {
    case "navigation":
      return { label: `Opening ${hostOf(event.url)}` };
    case "action":
      return { label: `${event.action}${event.target === null ? "" : ` : ${event.target}`}` };
    case "thinking":
      return { label: event.text.slice(0, 120) };
    case "progress":
      return {
        label: `Step ${String(event.step)}/${String(event.maxSteps)}`,
        pct: Math.round((event.step / event.maxSteps) * 100),
      };
    default:
      return undefined;
  }
}

function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).host : url.slice(0, 60);
}

function makeCloseTool(options: BrowserToolsOptions): ToolDefinition<never, unknown> {
  const tool: ToolDefinition<{ sessionId: string }, { closed: boolean }> = {
    name: "browser.close_session",
    description:
      "Closes a browser session and frees its resources. Call when browsing is complete.",
    version: "1",
    inputSchema: z.object({ sessionId: z.string().min(1) }),
    outputSchema: z.object({ closed: z.boolean() }),
    riskLevel: "SAFE",
    requiredPermissions: ["browser.navigate"],
    requiresConfirmation: false,
    idempotent: true,
    timeoutMs: 30_000,
    execute: async (input, context) => {
      await options.client.closeSession(input.sessionId, context.signal);
      return { closed: true };
    },
  };
  return tool as unknown as ToolDefinition<never, unknown>;
}
