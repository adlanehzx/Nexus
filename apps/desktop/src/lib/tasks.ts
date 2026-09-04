/**
 * Composition d'une demande de tâche depuis l'interface.
 *
 * Une règle, et tout le reste en découle : **on déclare ce qu'il faut savoir
 * faire, jamais qui doit le faire.** Le corps produit ici ne contient aucun
 * identifiant d'exécutant, et il n'existe pas de champ pour en mettre un.
 *
 * C'est ce qui fait que le portable « pilote » le poste fixe et le Redmi sans
 * jamais leur parler : il demande `android.app.open` ou `docker.execute`, et le
 * sélecteur du cœur trouve la machine qui sait le faire, si l'utilisateur l'a
 * autorisée. Un champ `targetDeviceId` transformerait cette architecture en
 * exécution dirigée depuis un client, ce qui la viderait de son sens : le poste
 * choisirait sa cible et le cœur ne ferait plus que relayer.
 *
 * `originClientDeviceId` est la seule identité transmise, et elle désigne la
 * **source**. Le serveur la remplace de toute façon par l'appareil réellement
 * authentifié — on l'envoie pour que le corps soit complet, pas pour qu'il soit
 * cru.
 */

export interface TaskStepDraft {
  description: string;
  /** Ce qu'il faut savoir faire. Jamais où. */
  requiredCapabilities: string[];
  tool: string;
  arguments?: Record<string, unknown>;
  riskLevel?: "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  dependsOn?: string[];
  id?: string;
}

export interface TaskDraft {
  title: string;
  steps: TaskStepDraft[];
  conversationId?: string;
}

export interface TaskRequestBody {
  title: string;
  originClientDeviceId: string;
  conversationId?: string;
  steps: {
    id?: string;
    description: string;
    requiredCapabilities: string[];
    tool: string;
    arguments?: Record<string, unknown>;
    dependsOn: string[];
    riskLevel?: "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  }[];
}

export class InvalidTaskDraftError extends Error {
  readonly code = "DESKTOP_INVALID_TASK_DRAFT";

  constructor(reason: string) {
    super(reason);
    this.name = "InvalidTaskDraftError";
  }
}

export function taskRequestBody(draft: TaskDraft, originClientDeviceId: string): TaskRequestBody {
  if (draft.title.trim().length === 0) {
    throw new InvalidTaskDraftError("Une tâche doit porter un titre.");
  }
  if (draft.steps.length === 0) {
    throw new InvalidTaskDraftError("Une tâche doit comporter au moins une étape.");
  }

  return {
    title: draft.title.trim(),
    originClientDeviceId,
    ...(draft.conversationId === undefined ? {} : { conversationId: draft.conversationId }),
    steps: draft.steps.map((step) => {
      if (step.requiredCapabilities.length === 0) {
        throw new InvalidTaskDraftError(
          `L'étape « ${step.description} » ne déclare aucune capacité requise. ` +
            "Sans capacité, le cœur n'a aucun moyen de choisir un exécutant.",
        );
      }

      return {
        ...(step.id === undefined ? {} : { id: step.id }),
        description: step.description,
        requiredCapabilities: step.requiredCapabilities,
        tool: step.tool,
        ...(step.arguments === undefined ? {} : { arguments: step.arguments }),
        dependsOn: step.dependsOn ?? [],
        ...(step.riskLevel === undefined ? {} : { riskLevel: step.riskLevel }),
      };
    }),
  };
}
