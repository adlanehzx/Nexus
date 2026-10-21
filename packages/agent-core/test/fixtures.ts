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
import { AgentOrchestrator, InMemoryAgentRunStore, type AgentEvent } from "../src/index.js";
import type { ExecutionPolicy } from "../src/policy.js";

/**
 * Outils réels utilisés par les tests.
 *
 * Ce ne sont pas des bouchons : ce sont des outils qui font vraiment ce qu'ils
 * annoncent (renvoyer une valeur, échouer, ignorer leur signal…). Seul le modèle
 * — la vraie frontière externe — est scripté. Tout le reste du chemin, de la
 * validation des arguments à la réinjection de l'observation, s'exécute.
 */

export const weatherTool: ToolDefinition<{ city: string }, { city: string; celsius: number }> = {
  name: "weather.get",
  description: "Donne la température actuelle d'une ville.",
  inputSchema: z.object({ city: z.string().min(1) }),
  outputSchema: z.object({ city: z.string(), celsius: z.number() }),
  riskLevel: "SAFE",
  requiredPermissions: [],
  requiresConfirmation: false,
  execute: (input) => Promise.resolve({ city: input.city, celsius: 21 }),
};

export const calendarListTool: ToolDefinition<{ day: string }, { events: string[] }> = {
  name: "calendar.list",
  description: "Liste les événements d'une journée.",
  inputSchema: z.object({ day: z.string().min(1) }),
  outputSchema: z.object({ events: z.array(z.string()) }),
  riskLevel: "SAFE",
  requiredPermissions: ["calendar.read"],
  requiresConfirmation: false,
  execute: () => Promise.resolve({ events: ["Dentiste 14h"] }),
};

/** Nécessite une confirmation : effet de bord réel et visible par un tiers. */
export function makeEmailTool(): {
  tool: ToolDefinition<{ to: string; subject: string; body: string }, { messageId: string }>;
  sent: { to: string; subject: string; body: string }[];
} {
  const sent: { to: string; subject: string; body: string }[] = [];
  return {
    sent,
    tool: {
      name: "email.send",
      description: "Envoie un email.",
      inputSchema: z.object({
        to: z.string().min(3),
        subject: z.string(),
        body: z.string(),
      }),
      outputSchema: z.object({ messageId: z.string() }),
      riskLevel: "HIGH",
      requiredPermissions: ["email.send"],
      requiresConfirmation: true,
      summarize: (input) => `Envoyer un email à ${input.to}`,
      execute: (input) => {
        sent.push(input);
        return Promise.resolve({ messageId: `msg-${String(sent.length)}` });
      },
    },
  };
}

/** Le risque dépend du chemin : hors zone de travail, confirmation exigée. */
export const fileWriteTool: ToolDefinition<{ path: string; content: string }, { bytes: number }> = {
  name: "filesystem.write",
  description: "Écrit un fichier.",
  inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
  outputSchema: z.object({ bytes: z.number() }),
  riskLevel: "MEDIUM",
  requiredPermissions: ["filesystem.write"],
  requiresConfirmation: (input) => !input.path.startsWith("/workspace/project/"),
  execute: (input) => Promise.resolve({ bytes: input.content.length }),
};

/** Échoue de façon transitoire `failures` fois, puis réussit. */
export function makeFlakyTool(failures: number): {
  tool: ToolDefinition<{ url: string }, { status: number }>;
  attempts: () => number;
} {
  let attempts = 0;
  return {
    attempts: () => attempts,
    tool: {
      name: "flaky.fetch",
      description: "Appelle une API instable.",
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

/** Échec définitif : rien ne sert de réessayer. */
export const brokenTool: ToolDefinition<Record<string, never>, { ok: boolean }> = {
  name: "broken.tool",
  description: "Échoue systématiquement.",
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  riskLevel: "SAFE",
  requiredPermissions: [],
  requiresConfirmation: false,
  execute: () => Promise.reject(new Error("disque plein")),
};

/**
 * Ignore délibérément son `AbortSignal`.
 * C'est le cas qui prouve que le délai est imposé par l'exécuteur, et non
 * poliment respecté par l'outil.
 */
export const hangingTool: ToolDefinition<Record<string, never>, { ok: boolean }> = {
  name: "slow.task",
  description: "Ne se termine jamais.",
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  riskLevel: "SAFE",
  requiredPermissions: [],
  requiresConfirmation: false,
  timeoutMs: 30,
  execute: () => new Promise(() => undefined),
};

/** Renvoie une sortie non conforme à son propre schéma. */
export const badOutputTool: ToolDefinition<Record<string, never>, { count: number }> = {
  name: "bad.output",
  description: "Renvoie une sortie non conforme.",
  inputSchema: z.object({}),
  outputSchema: z.object({ count: z.number() }),
  riskLevel: "SAFE",
  requiredPermissions: [],
  requiresConfirmation: false,
  execute: () => Promise.resolve({ count: "beaucoup" } as unknown as { count: number }),
};

export const dangerousTool: ToolDefinition<{ command: string }, { exitCode: number }> = {
  name: "terminal.execute",
  description: "Exécute une commande shell.",
  inputSchema: z.object({ command: z.string().min(1) }),
  outputSchema: z.object({ exitCode: z.number() }),
  riskLevel: "CRITICAL",
  requiredPermissions: ["terminal.execute"],
  // Même déclaré sans confirmation, CRITICAL en impose une : un outil ne peut
  // pas s'auto-dispenser d'un accord sur une action irréversible.
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
  /** Délais de backoff demandés, dans l'ordre — sans jamais attendre réellement. */
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
}

function makePermissions(granted: string[], autoApproveMaxRisk: "SAFE" | "LOW" | "MEDIUM" = "LOW") {
  return new PermissionService({
    grants: new StaticGrantProvider(granted),
    autoApproveMaxRisk,
  });
}

/**
 * Monte un moteur complet.
 *
 * Seuls le modèle (scripté) et l'horloge de backoff (enregistrée, jamais
 * attendue) sont remplacés. Registre, permissions, confirmations, exécuteur,
 * boucle, magasin d'états : tout est réel.
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
    // On enregistre le délai demandé sans jamais dormir : le calcul du backoff
    // est testé pour ce qu'il est — de l'arithmétique — pas en temps réel.
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
    run: (message = "Bonjour") =>
      orchestrator.run({ userId: "user-1", conversationId: "conv-1", message }),
  };
}

/** Raccourci : un tour du modèle qui appelle un outil. */
export function callTurn(name: string, args: unknown, id = `call-${name}`): ScriptedTurn {
  return { kind: "tool_calls", calls: [{ id, name, arguments: args }] };
}
