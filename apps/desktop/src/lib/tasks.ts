/**
 * Task request composition from UI.
 *
 * Core rule: declare required capabilities, never target execution hosts.
 */

export interface TaskStepDraft {
  description: string;
  /** What capability is required, not where to execute. */
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
    throw new InvalidTaskDraftError("A task must have a title.");
  }
  if (draft.steps.length === 0) {
    throw new InvalidTaskDraftError("A task must have at least one step.");
  }

  return {
    title: draft.title.trim(),
    originClientDeviceId,
    ...(draft.conversationId === undefined ? {} : { conversationId: draft.conversationId }),
    steps: draft.steps.map((step) => {
      if (step.requiredCapabilities.length === 0) {
        throw new InvalidTaskDraftError(
          `Step "${step.description}" declares no required capabilities. ` +
            "Without capabilities, the core cannot route to a worker.",
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
