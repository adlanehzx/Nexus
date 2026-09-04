import { z } from "zod";
import type { LLMProvider, LlmMessage } from "@nexus/llm";
import { riskLevelSchema } from "@nexus/tools";
import type { CreateTaskPlanInput, TaskStepInput } from "@nexus/devices";

export const llmTaskStepSchema = z.object({
  id: z.string().describe("Identifiant unique de l'étape (ex: 'step-1')"),
  description: z.string().describe("Description claire de l'action à accomplir"),
  requiredCapabilities: z
    .array(z.string())
    .describe("Capacités nécessaires pour cette étape (issues strictement de la liste fournie)"),
  tool: z
    .string()
    .describe("L'outil à invoquer (doit toujours correspondre au format 'device.<capability>')"),
  arguments: z.record(z.string(), z.unknown()).describe("Arguments spécifiques à fournir à l'outil"),
  dependsOn: z
    .array(z.string())
    .describe("Liste des identifiants (id) des étapes qui doivent réussir avant celle-ci"),
  riskLevel: riskLevelSchema.describe(
    "Niveau de risque estimé de l'étape. Ne jamais mettre MEDIUM si SAFE, LOW, HIGH ou CRITICAL est plus pertinent.",
  ),
});

export const llmTaskPlanSchema = z.object({
  title: z.string().describe("Titre général de la tâche planifiée"),
  steps: z
    .array(llmTaskStepSchema)
    .describe("Séquence ordonnée des étapes pour accomplir la tâche"),
  reasoning: z.string().describe("Raisonnement expliquant pourquoi ce plan a été construit ainsi"),
});

export type LlmTaskPlan = z.infer<typeof llmTaskPlanSchema>;

export interface TaskPlannerOptions {
  llm: LLMProvider;
  availableCapabilities: string[];
}

export class TaskPlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskPlannerError";
  }
}

/**
 * TaskPlanner
 *
 * Transforme une instruction en langage naturel en un plan structuré (TaskPlan)
 * pour exécution différée ou asynchrone par des workers, via le TaskCoordinator.
 */
export class TaskPlanner {
  readonly #llm: LLMProvider;
  readonly #availableCapabilities: string[];

  constructor(options: TaskPlannerOptions) {
    this.#llm = options.llm;
    this.#availableCapabilities = options.availableCapabilities;
  }

  async plan(input: {
    instruction: string;
    userId: string;
    originClientDeviceId: string;
    correlationId: string;
  }): Promise<{ planInput: CreateTaskPlanInput; reasoning: string }> {
    const systemPrompt = `
Tu es un planificateur de tâches expert pour le système NEXUS.
Ton rôle est de traduire l'instruction de l'utilisateur en un plan d'exécution structuré et valide.

Capacités d'appareils actuellement enregistrées dans le système :
${this.#availableCapabilities.map((c) => `- ${c}`).join("\n")}

RÈGLES ABSOLUES :
1. N'invente AUCUNE capacité. Utilise uniquement celles listées ci-dessus.
2. Pour chaque étape, l'outil ('tool') doit TOUJOURS correspondre au format 'device.<capability>'. Par exemple, pour la capacité 'browser.navigate', le tool est 'device.browser.navigate'.
3. Le champ 'dependsOn' doit utiliser les IDs exacts des étapes préalables, permettant de créer un graphe (DAG) d'exécution.
4. Évalue très précisément le 'riskLevel' (SAFE, LOW, MEDIUM, HIGH, CRITICAL). Ex: Lire un fichier est SAFE. Exécuter un script shell est HIGH.
5. Si la demande est trop ambiguë, dangereuse sans contexte, ou techniquement impossible avec les capacités fournies, tu DOIS générer une liste d'étapes VIDE (steps: []) et expliquer le problème dans 'reasoning'.
`;

    const request = {
      messages: [{ role: "user", content: [{ type: "text", text: input.instruction }] }] as LlmMessage[],
      system: systemPrompt,
    };

    let result: LlmTaskPlan;
    try {
      result = await this.#llm.structuredOutput(request, llmTaskPlanSchema);
    } catch (err: unknown) {
      throw new TaskPlannerError(
        "Erreur lors de la generation du plan par le LLM : " + (err instanceof Error ? err.message : String(err)),
      );
    }

    if (!result.steps || result.steps.length === 0) {
      throw new TaskPlannerError(
        "Instruction ambiguë ou impossible à planifier : " + result.reasoning,
      );
    }

    const steps: TaskStepInput[] = result.steps.map((s) => ({
      id: s.id,
      description: s.description,
      requiredCapabilities: s.requiredCapabilities,
      tool: s.tool,
      arguments: s.arguments,
      dependsOn: s.dependsOn,
      riskLevel: s.riskLevel,
    }));

    return {
      planInput: {
        userId: input.userId,
        title: result.title,
        originClientDeviceId: input.originClientDeviceId,
        correlationId: input.correlationId,
        steps,
      },
      reasoning: result.reasoning,
    };
  }
}
