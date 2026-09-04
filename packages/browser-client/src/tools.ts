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
 * Outils `browser.*` exposés à l'agent.
 *
 * Un outil par **intention**, et non un seul outil générique. C'est ce qui
 * permet au système de permissions de faire son travail : lire le prix d'un
 * billet et acheter ce billet ne sont pas la même action, et ne peuvent pas
 * porter le même niveau de risque ni la même confirmation.
 *
 * L'intention n'est pas déclarative : le worker restreint réellement ce que le
 * navigateur peut faire (cf. `services/browser-worker/app/policies.py`). Un
 * `browser.read` ne peut pas cliquer, même si le modèle le lui demande.
 */

const taskInputSchema = z.object({
  /** Ce que l'agent veut obtenir, en langage naturel. */
  instructions: z.string().min(3).max(4_000),
  /** Point de départ. Sans lui, l'agent doit dire dans les instructions où aller. */
  url: z.string().optional(),
  /** Réutilise une session ouverte — indispensable pour enchaîner les étapes. */
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
  /** Vrai si le site exige une action humaine (CAPTCHA, MFA, 2FA). */
  needsHuman: z.boolean(),
  visitedUrl: z.string().nullable(),
});
type TaskOutput = z.infer<typeof taskOutputSchema>;

export interface BrowserToolsOptions {
  client: BrowserWorkerClient;
  /** Restreint la navigation. Vivement recommandé en production. */
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
      "Ouvre une page et en extrait de l'information (prix, horaires, disponibilité, contenu). LECTURE SEULE : ne clique pas, ne remplit aucun formulaire, ne se connecte à rien. Utilise-le pour toute recherche d'information sur le web.",
  },
  {
    name: "browser.interact",
    intent: "interact",
    risk: "MEDIUM",
    requiresConfirmation: true,
    description:
      "Interagit avec une page : cliquer, remplir un formulaire, filtrer, rechercher. N'effectue ni connexion ni paiement. Nécessite l'accord de l'utilisateur.",
  },
  {
    name: "browser.login",
    intent: "login",
    risk: "HIGH",
    requiresConfirmation: true,
    description:
      "Se connecte à un site avec des identifiants déjà enregistrés par l'utilisateur. Ne contourne JAMAIS un CAPTCHA ni une authentification à deux facteurs : si le site en demande une, la tâche s'arrête et rend la main à l'utilisateur.",
  },
  {
    name: "browser.purchase",
    intent: "purchase",
    risk: "CRITICAL",
    requiresConfirmation: true,
    description:
      "Finalise un achat ou une réservation payante. Action IRRÉVERSIBLE et engageante financièrement. À n'utiliser qu'après avoir présenté le montant exact et obtenu l'accord explicite de l'utilisateur.",
  },
];

/** Construit les outils navigateur pour le registre. */
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
    // Une action de navigateur n'est jamais rejouée toute seule : on ne peut pas
    // savoir si le premier essai a déjà cliqué sur « Payer ».
    idempotent: spec.intent === "read",
    timeoutMs: 15 * 60_000,
    summarize: (input) =>
      `${spec.name} — ${input.url ?? "page courante"} : ${input.instructions.slice(0, 160)}`,

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
          : `Va sur ${input.url}, puis : ${input.instructions}`;

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
    // On ne contourne jamais une protection : on rend la main. Le message est
    // rédigé pour que l'agent le relaie tel quel à l'utilisateur.
    return {
      ...base,
      needsHuman: true,
      output:
        task.error?.message ??
        "Le site demande une vérification humaine (CAPTCHA ou authentification à deux facteurs). Je ne la contourne pas : prends la main sur cette étape, puis redemande-moi de continuer.",
    };
  }

  if (task.status !== "succeeded") {
    throw new BrowserWorkerError(task.error?.code ?? "BROWSER_TASK_FAILED", {
      message: task.error?.message ?? `Tâche navigateur terminée en ${task.status}`,
      userMessage:
        task.error?.message ?? `La navigation s'est terminée sans résultat (${task.status}).`,
      retryable: task.error?.retryable ?? false,
    });
  }

  return { ...base, needsHuman: false, output: task.output ?? "" };
}

/** Traduit un événement du worker en progression lisible par un humain. */
function describeEvent(event: BrowserEvent): { label?: string; pct?: number } | undefined {
  switch (event.type) {
    case "navigation":
      return { label: `Ouverture de ${hostOf(event.url)}` };
    case "action":
      return { label: `${event.action}${event.target === null ? "" : ` : ${event.target}`}` };
    case "thinking":
      return { label: event.text.slice(0, 120) };
    case "progress":
      return {
        label: `Étape ${String(event.step)}/${String(event.maxSteps)}`,
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
      "Ferme une session de navigateur et libère ses ressources. À appeler quand la navigation est terminée.",
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
