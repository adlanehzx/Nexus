import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { LLMProvider, LlmMessage } from "@nexus/llm";
import type {
  MissionControlPort,
  MissionSnapshot,
  MissionTaskInput,
  RuntimeSettings,
  SubmitMission,
} from "@nexus/mission-control-client";

const plannedTaskSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,47}$/)
    .describe("Identifiant stable en snake_case"),
  profile: z.string().describe("Profil ACP, choisi strictement dans la liste fournie"),
  instruction: z.string().min(1).max(20_000),
  depends_on: z.array(z.string()).max(8),
});

const plannedMissionSchema = z.object({
  title: z.string().min(1).max(200),
  tasks: z.array(plannedTaskSchema).min(1).max(7),
});

export interface OrchestratedMission {
  missionId: string;
  title: string;
  state: string;
  profiles: string[];
  completedTasks: number;
  totalTasks: number;
  response: string | null;
  error: string | null;
}

/**
 * Façade NEXUS au-dessus du moteur ACP durable.
 *
 * Le modèle ne lance aucun processus : il produit uniquement un DAG validé.
 * Mission Control reste responsable de la file, des retries et de la reprise.
 */
export class AcpOrchestrator {
  readonly #missionControl: MissionControlPort;
  readonly #llm: LLMProvider | undefined;
  readonly #workspaceRoot: string;

  constructor(options: {
    missionControl: MissionControlPort;
    llm?: LLMProvider;
    workspaceRoot?: string;
  }) {
    this.#missionControl = options.missionControl;
    this.#llm = options.llm;
    this.#workspaceRoot = options.workspaceRoot ?? resolve(process.cwd(), ".nexus-workspaces");
  }

  async submit(userId: string, objective: string): Promise<OrchestratedMission> {
    const [health, settings] = await Promise.all([
      this.#missionControl.health(),
      this.#missionControl.settings(),
    ]);
    if (!health.worker_enabled || health.profiles.length === 0) {
      throw new Error("Le moteur ACP n'a aucun profil actif.");
    }

    const missionKey = randomUUID();
    const workspace = resolve(this.#workspaceRoot, missionKey);
    await mkdir(workspace, { recursive: true, mode: 0o700 });

    const planned = await this.#plan(objective, health.profiles, settings);
    const tasks = ensureFinalSynthesis(planned.tasks, objective, health.profiles, settings);
    const input: SubmitMission = {
      external_key: `${ownerPrefix(userId)}-${missionKey}`,
      title: planned.title,
      workspace,
      tasks,
    };
    const submitted = await this.#missionControl.submitMission(input, `nexus-chat-${missionKey}`);
    return {
      missionId: submitted.mission_id,
      title: input.title,
      state: "pending",
      profiles: [...new Set(tasks.map((task) => task.profile))],
      completedTasks: 0,
      totalTasks: tasks.length,
      response: null,
      error: null,
    };
  }

  async status(userId: string, missionId: string): Promise<OrchestratedMission | undefined> {
    const mission = await this.#missionControl.getMission(missionId);
    if (!mission.external_key.startsWith(`${ownerPrefix(userId)}-`)) return undefined;
    return presentMission(mission);
  }

  async #plan(
    objective: string,
    profiles: string[],
    settings: RuntimeSettings,
  ): Promise<z.infer<typeof plannedMissionSchema>> {
    if (this.#llm === undefined) return fallbackPlan(objective, profiles, settings);

    const system = `Tu es l'orchestrateur central de NEXUS. Décompose une mission utilisateur en tâches ACP spécialisées, parallèles lorsque possible.

Profils réellement disponibles : ${profiles.join(", ")}.
Priorité recherche : ${settings.research_priority.join(", ")}.
Priorité critique : ${settings.review_priority.join(", ")}.

Règles absolues :
- utilise exclusivement ces profils ;
- produis un DAG sans cycle et sans dépendance inconnue ;
- chaque instruction doit être autonome, vérifiable et ne contenir aucun secret ;
- antigravity est privilégié pour recherche/exploration, claude pour analyse et critique, codex pour code/intégration ;
- ne crée PAS de tâche de synthèse finale : NEXUS l'ajoute après validation ;
- pour une demande simple, une seule tâche suffit.`;
    const messages: LlmMessage[] = [{ role: "user", content: [{ type: "text", text: objective }] }];

    try {
      const planned = await this.#llm.structuredOutput({ system, messages }, plannedMissionSchema);
      validatePlan(planned.tasks, profiles);
      return planned;
    } catch {
      // La disponibilité du planificateur ne doit jamais être un point unique
      // de panne. Le plan conservateur utilise les mêmes agents et le même
      // moteur durable, sans inventer de capacité.
      return fallbackPlan(objective, profiles, settings);
    }
  }
}

function validatePlan(tasks: z.infer<typeof plannedTaskSchema>[], profiles: string[]): void {
  const allowed = new Set(profiles);
  const keys = new Set(tasks.map((task) => task.key));
  if (keys.size !== tasks.length) throw new Error("Clés de tâches dupliquées");
  for (const task of tasks) {
    if (!allowed.has(task.profile)) throw new Error("Profil ACP inconnu");
    if (task.depends_on.some((dependency) => !keys.has(dependency) || dependency === task.key)) {
      throw new Error("Dépendance ACP invalide");
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error("Cycle ACP");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key)?.depends_on ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const task of tasks) visit(task.key);
}

function ensureFinalSynthesis(
  planned: z.infer<typeof plannedTaskSchema>[],
  objective: string,
  profiles: string[],
  settings: RuntimeSettings,
): MissionTaskInput[] {
  validatePlan(planned, profiles);
  const dependencies = new Set(planned.flatMap((task) => task.depends_on));
  const leaves = planned.filter((task) => !dependencies.has(task.key)).map((task) => task.key);
  // Claude est actuellement le synthétiseur le plus stable dans l'installation
  // locale. Codex reste sélectionnable pour les tâches de code/revue par le
  // planificateur, sans devenir un point unique de panne pour chaque mission.
  const finalProfile = preferred(profiles, settings.synthesis_priority);
  const executionTasks: MissionTaskInput[] = planned.map((task) => {
    const fallbacks = fallbackOrder(task.profile, profiles);
    return {
      ...task,
      fallback_profiles: fallbacks,
      timeout_seconds: settings.task_timeout_seconds,
      max_attempts: Math.min(settings.max_attempts, 1 + fallbacks.length),
      retry_delay_seconds: settings.retry_delay_seconds,
      context_budget_chars: settings.context_budget_chars,
    };
  });
  const reviewProfile = preferred(profiles, settings.review_priority);
  const qualityReview: MissionTaskInput | undefined =
    settings.quality_review && planned.length > 1
      ? {
          key: "nexus_quality_review_1",
          profile: reviewProfile,
          fallback_profiles: fallbackOrder(reviewProfile, profiles),
          depends_on: leaves,
          timeout_seconds: settings.task_timeout_seconds,
          max_attempts: Math.min(settings.max_attempts, profiles.length),
          retry_delay_seconds: settings.retry_delay_seconds,
          context_budget_chars: Math.max(settings.context_budget_chars, 80_000),
          instruction: qualityReviewInstruction(objective, 1),
        }
      : undefined;
  const finalDependencies = qualityReview === undefined ? leaves : [...leaves, qualityReview.key];
  return [
    ...executionTasks,
    ...(qualityReview === undefined ? [] : [qualityReview]),
    {
      key: "nexus_final_synthesis",
      profile: finalProfile,
      fallback_profiles: fallbackOrder(finalProfile, profiles),
      depends_on: finalDependencies,
      timeout_seconds: settings.task_timeout_seconds,
      max_attempts: Math.min(settings.max_attempts, profiles.length),
      retry_delay_seconds: settings.retry_delay_seconds,
      context_budget_chars: Math.max(settings.context_budget_chars, 80_000),
      instruction: `Tu es le synthétiseur final de NEXUS. Réponds directement à la mission initiale ci-dessous en français. Les résultats vérifiés des autres agents sont injectés après cette instruction. Confronte-les, corrige leurs contradictions, n'invente pas de réussite non démontrée et livre une réponse claire et exploitable.\n\nMISSION INITIALE :\n${objective}`,
    },
  ];
}

function qualityReviewInstruction(objective: string, cycle: number): string {
  return `Tu es le contrôleur qualité de NEXUS, cycle ${cycle}. Évalue uniquement si les résultats amont permettent de répondre correctement à la mission. Vérifie les contradictions, preuves, tests et critères de réussite. Réponds avec un objet JSON strict, sans markdown ni texte autour : {"verdict":"pass"|"revise","summary":"résumé factuel","corrective_instruction":"instruction précise ou chaîne vide"}. Choisis "revise" seulement si une correction concrète peut améliorer le résultat. N'inclus aucun secret.\n\nMISSION INITIALE :\n${objective}`;
}

function fallbackPlan(
  objective: string,
  profiles: string[],
  settings: RuntimeSettings,
): z.infer<typeof plannedMissionSchema> {
  const researcher = preferred(profiles, settings.research_priority);
  const critic = preferred(profiles, settings.review_priority);
  const tasks: z.infer<typeof plannedTaskSchema>[] = [
    {
      key: "investigate",
      profile: researcher,
      depends_on: [],
      instruction: `Analyse cette mission, rassemble les faits nécessaires et propose une solution vérifiable. N'expose aucun identifiant.\n\n${objective}`,
    },
  ];
  if (profiles.length > 1) {
    tasks.push({
      key: "critical_review",
      profile: critic,
      depends_on: ["investigate"],
      instruction: `Effectue une revue critique indépendante de la mission et du résultat amont. Repère les erreurs, risques et éléments non prouvés, puis propose les corrections nécessaires.\n\n${objective}`,
    });
  }
  return { title: objective.slice(0, 120), tasks };
}

function preferred(profiles: string[], order: string[]): string {
  return order.find((candidate) => profiles.includes(candidate)) ?? profiles[0] ?? "";
}

function fallbackOrder(primary: string, profiles: string[]): string[] {
  const preferredOrder = ["claude", "antigravity", "codex"];
  return [...preferredOrder, ...profiles].filter(
    (candidate, index, values) =>
      candidate !== primary && profiles.includes(candidate) && values.indexOf(candidate) === index,
  );
}

function ownerPrefix(userId: string): string {
  return `nexus-${createHash("sha256").update(userId).digest("hex").slice(0, 24)}`;
}

function presentMission(mission: MissionSnapshot): OrchestratedMission {
  const finalTask = mission.tasks.find((task) => task.task_key === "nexus_final_synthesis");
  const failed = mission.tasks.find((task) => task.state === "failed");
  return {
    missionId: mission.id,
    title: mission.title,
    state: mission.state,
    profiles: [...new Set(mission.tasks.map((task) => task.profile_key))],
    completedTasks: mission.tasks.filter((task) => task.state === "succeeded").length,
    totalTasks: mission.tasks.length,
    response: responseFrom(finalTask?.result_json),
    error: failed === undefined ? null : "Un agent n'a pas pu terminer sa tâche.",
  };
}

function responseFrom(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value !== null && typeof value === "object" && "response" in value) {
      const response = (value as { response?: unknown }).response;
      return typeof response === "string" ? response : null;
    }
  } catch {
    return null;
  }
  return null;
}
