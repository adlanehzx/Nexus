import { z } from "zod";
import { uuidv7 } from "@nexus/shared";

export const workflowStepSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  requiredPermissions: z.array(z.string()).default([]),
  requiresConfirmation: z.boolean().default(false),
});
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const versionedWorkflowSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  steps: z.array(workflowStepSchema).min(1),
  author: z.string().optional(),
  createdAt: z.string().default(() => new Date().toISOString()),
});
export type VersionedWorkflow = z.infer<typeof versionedWorkflowSchema>;
export type VersionedWorkflowInput = z.input<typeof versionedWorkflowSchema>;

export interface WorkflowPreview {
  workflowId: string;
  name: string;
  version: string;
  stepsCount: number;
  allRequiredPermissions: string[];
  confirmationSteps: string[];
}

export class SharedWorkflowEngine {
  private workflows = new Map<string, VersionedWorkflow[]>(); // workflowId -> version history

  registerWorkflow(
    workflowInput: Omit<VersionedWorkflowInput, "id" | "createdAt"> & {
      id?: string | undefined;
      createdAt?: string | undefined;
    },
  ): VersionedWorkflow {
    const id = workflowInput.id ?? `wf-${uuidv7()}`;
    const workflow: VersionedWorkflowInput = {
      ...workflowInput,
      id,
      createdAt: workflowInput.createdAt ?? new Date().toISOString(),
    };

    const validated = versionedWorkflowSchema.parse(workflow);
    const history = this.workflows.get(id) ?? [];
    history.push(validated);
    this.workflows.set(id, history);
    return validated;
  }

  getWorkflow(id: string, version?: string): VersionedWorkflow | undefined {
    const history = this.workflows.get(id);
    if (!history || history.length === 0) return undefined;
    if (version) {
      return history.find((w) => w.version === version);
    }
    return history[history.length - 1]; // latest
  }

  exportWorkflow(id: string, version?: string): string {
    const wf = this.getWorkflow(id, version);
    if (!wf) {
      throw new Error(`Workflow with id '${id}' not found`);
    }
    return JSON.stringify(wf, null, 2);
  }

  importWorkflow(jsonString: string): VersionedWorkflow {
    const parsed = JSON.parse(jsonString) as unknown;
    const validated = versionedWorkflowSchema.parse(parsed);

    const history = this.workflows.get(validated.id) ?? [];
    // If version already exists, reject duplicate import
    if (history.some((w) => w.version === validated.version)) {
      throw new Error(
        `Workflow '${validated.id}' version '${validated.version}' already exists in registry`,
      );
    }

    history.push(validated);
    this.workflows.set(validated.id, history);
    return validated;
  }

  previewExecution(id: string): WorkflowPreview {
    const wf = this.getWorkflow(id);
    if (!wf) {
      throw new Error(`Workflow '${id}' not found`);
    }

    const perms = new Set<string>();
    const confirmSteps: string[] = [];

    for (const step of wf.steps) {
      for (const p of step.requiredPermissions) perms.add(p);
      if (step.requiresConfirmation) {
        confirmSteps.push(step.name);
      }
    }

    return {
      workflowId: wf.id,
      name: wf.name,
      version: wf.version,
      stepsCount: wf.steps.length,
      allRequiredPermissions: Array.from(perms),
      confirmationSteps: confirmSteps,
    };
  }

  rollbackWorkflow(id: string): VersionedWorkflow {
    const history = this.workflows.get(id);
    if (!history || history.length < 2) {
      throw new Error(`Workflow '${id}' has no previous version to roll back to`);
    }

    history.pop(); // Remove latest
    const previous = history[history.length - 1]!;
    this.workflows.set(id, history);
    return previous;
  }
}
