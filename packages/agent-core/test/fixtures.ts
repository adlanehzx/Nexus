import { z } from "zod";
import { ScriptedLLMProvider, type ScriptedTurn } from "@nexus/llm/testing";
import {
  ConfirmationService,
  PermissionService,
  RetryableToolError,
  StaticGrantProvider,
  ToolExecutor,
  ToolRegistry,
  type ToolDefinition,
} from "@nexus/tools";
import type { ContextAssembler } from "@nexus/memory";
import { AgentOrchestrator, InMemoryAgentRunStore, type AgentEvent } from "../src/index.js";
import type { ExecutionPolicy } from "../src/policy.js";

/**
 * Real tools used across integration tests.
 */

export const weatherTool: ToolDefinition<{ city: string }, { city: string; celsius: number }> = {
  name: "weather.get",
  description: "Returns the current temperature of a city.",
  inputSchema: z.object({ city: z.string().min(1) }),
  outputSchema: z.object({ city: z.string(), celsius: z.number() }),
  riskLevel: "SAFE",
  requiredPermissions: [],
  requiresConfirmation: false,
  execute: (input) => Promise.resolve({ city: input.city, celsius: 21 }),
};

export const calendarListTool: ToolDefinition<{ day: string }, { events: string[] }> = {
  name: "calendar.list",
  description: "Lists calendar events for a given day.",
  inputSchema: z.object({ day: z.string().min(1) }),
  outputSchema: z.object({ events: z.array(z.string()) }),
  riskLevel: "SAFE",
  requiredPermissions: ["calendar.read"],
  requiresConfirmation: false,
  execute: () => Promise.resolve({ events: ["Dentiste 14h"] }),
};

/** Requires human confirmation due to external side-effects. */
export function makeEmailTool(): {
  tool: ToolDefinition<{ to: string; subject: string; body: string }, { messageId: string }>;
  sent: { to: string; subject: string; body: string }[];
} {
  const sent: { to: string; subject: string; body: string }[] = [];
  return {
    sent,
    tool: {
      name: "email.send",
      description: "Sends an email.",
      inputSchema: z.object({
        to: z.string().min(3),
        subject: z.string(),
        body: z.string(),
      }),
      outputSchema: z.object({ messageId: z.string() }),
      riskLevel: "HIGH",
      requiredPermissions: ["email.send"],
      requiresConfirmation: true,
      summarize: (input) => `Send an email to ${input.to}`,
      execute: (input) => {
        sent.push(input);
        return Promise.resolve({ messageId: `msg-${String(sent.length)}` });
      },
    },
  };
}

/** Risk dynamically determined by file path. */
export const fileWriteTool: ToolDefinition<{ path: string; content: string }, { bytes: number }> = {
  name: "filesystem.write",
  description: "Writes a file.",
  inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
  outputSchema: z.object({ bytes: z.number() }),
  riskLevel: "MEDIUM",
  requiredPermissions: ["filesystem.write"],
  requiresConfirmation: (input) => !input.path.startsWith("/workspace/project/"),
  execute: (input) => Promise.resolve({ bytes: input.content.length }),
};

/** Fails transiently `failures` times before succeeding. */
export function makeFlakyTool(failures: number): {
  tool: ToolDefinition<{ url: string }, { status: number }>;
  attempts: () => number;
} {
  let attempts = 0;
  return {
    attempts: () => attempts,
    tool: {
      name: "flaky.fetch",
      description: "Calls an unstable API.",
      inputSchema: z.object({ url: z.string() }),
      outputSchema: z.object({ status: z.number() }),
      riskLevel: "LOW",
      requiredPermissions: [],
      requiresConfirmation: false,
      execute: () => {
        attempts += 1;
        if (attempts <= failures) {
          return Promise.reject(
            new RetryableToolError("flaky.fetch", { message: "503 Service Unavailable" }),
          );
        }
        return Promise.resolve({ status: 200 });
      },
    },
  };
}

/** Permanent failure. */
export const brokenTool: ToolDefinition<Record<string, never>, { ok: boolean }> = {
  name: "broken.tool",
  description: "Fails systematically.",
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  riskLevel: "SAFE",
  requiredPermissions: [],
  requiresConfirmation: false,
  execute: () => Promise.reject(new Error("disk full")),
};

/** Ignores abort signal to verify executor timeout enforcement. */
export const hangingTool: ToolDefinition<Record<string, never>, { ok: boolean }> = {
  name: "slow.task",
  description: "Never completes.",
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  riskLevel: "SAFE",
  requiredPermissions: [],
  requiresConfirmation: false,
  timeoutMs: 30,
  execute: () => new Promise(() => undefined),
};

/** Returns output violating declared schema. */
export const badOutputTool: ToolDefinition<Record<string, never>, { count: number }> = {
  name: "bad.output",
  description: "Returns invalid output format.",
  inputSchema: z.object({}),
  outputSchema: z.object({ count: z.number() }),
  riskLevel: "SAFE",
  requiredPermissions: [],
  requiresConfirmation: false,
  execute: () => Promise.resolve({ count: "many" } as unknown as { count: number }),
};

export const dangerousTool: ToolDefinition<{ command: string }, { exitCode: number }> = {
  name: "terminal.execute",
  description: "Executes a shell command.",
  inputSchema: z.object({ command: z.string().min(1) }),
  outputSchema: z.object({ exitCode: z.number() }),
  riskLevel: "CRITICAL",
  requiredPermissions: ["terminal.execute"],
  requiresConfirmation: false,
  execute: () => Promise.resolve({ exitCode: 0 }),
};

export interface Harness {
  orchestrator: AgentOrchestrator;
  llm: ScriptedLLMProvider;
  registry: ToolRegistry;
  store: InMemoryAgentRunStore;
  confirmations: ConfirmationService;
  events: AgentEvent[];
  sleeps: number[];
  run: (message?: string) => ReturnType<AgentOrchestrator["run"]>;
}

export interface HarnessOptions {
  turns: ScriptedTurn[];
  tools?: ToolDefinition<never, unknown>[];
  permissions?: string[];
  policy?: Partial<ExecutionPolicy>;
  now?: () => number;
  autoApproveMaxRisk?: Parameters<typeof makePermissions>[1];
  context?: ContextAssembler;
}

function makePermissions(granted: string[], autoApproveMaxRisk: "SAFE" | "LOW" | "MEDIUM" = "LOW") {
  return new PermissionService({
    grants: new StaticGrantProvider(granted),
    autoApproveMaxRisk,
  });
}

/**
 * Constructs test harness with real components except scripted LLM.
 */
export function makeHarness(options: HarnessOptions): Harness {
  const llm = new ScriptedLLMProvider(options.turns);
  const registry = new ToolRegistry();
  registry.registerAll(
    (options.tools ?? [weatherTool]) as unknown as ToolDefinition<never, unknown>[],
  );

  const store = new InMemoryAgentRunStore();
  const confirmations = new ConfirmationService(
    options.now ? { now: () => new Date(options.now!()) } : {},
  );
  const events: AgentEvent[] = [];
  const sleeps: number[] = [];

  const executor = new ToolExecutor({
    defaultTimeoutMs: options.policy?.defaultToolTimeoutMs ?? 1_000,
    retry: options.policy?.retry ?? {
      attempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 5_000,
      factor: 2,
      jitter: false,
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

  const orchestrator = new AgentOrchestrator({
    llm,
    registry,
    permissions: makePermissions(options.permissions ?? [], options.autoApproveMaxRisk ?? "LOW"),
    confirmations,
    executor,
    store,
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.context ? { context: options.context } : {}),
  });

  orchestrator.on((event) => events.push(event));

  return {
    orchestrator,
    llm,
    registry,
    store,
    confirmations,
    events,
    sleeps,
    run: (message = "Hello") =>
      orchestrator.run({ userId: "user-1", conversationId: "conv-1", message }),
  };
}

/** Shortcut for a model turn issuing a tool call. */
export function callTurn(name: string, args: unknown, id = `call-${name}`): ScriptedTurn {
  return { kind: "tool_calls", calls: [{ id, name, arguments: args }] };
}
