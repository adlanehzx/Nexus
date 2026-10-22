import { z } from "zod";
import type { LLMProvider, LlmMessage } from "@nexus/llm";
import { riskLevelSchema } from "@nexus/tools";
import type { CreateTaskPlanInput, TaskStepInput } from "@nexus/devices";

export const llmTaskStepSchema = z.object({
  id: z.string().describe("Unique identifier of the step (e.g. 'step-1')"),
  description: z.string().describe("Clear description of the action to perform"),
  requiredCapabilities: z
    .array(z.string())
    .describe("Capabilities required for this step (strictly from the provided list)"),
  tool: z
    .string()
    .describe("The tool to invoke (must always match 'device.<capability>')"),
  arguments: z
    .record(z.string(), z.unknown())
    .describe("Specific arguments to pass to the tool"),
  dependsOn: z
    .array(z.string())
    .describe("List of step IDs that must succeed before this one"),
  riskLevel: riskLevelSchema.describe(
    "Estimated risk level of the step. Never use MEDIUM if SAFE, LOW, HIGH or CRITICAL is more appropriate.",
  ),
});

export const llmTaskPlanSchema = z.object({
  title: z.string().describe("Overall title of the planned task"),
  steps: z
    .array(llmTaskStepSchema)
    .describe("Ordered sequence of steps to accomplish the task"),
  reasoning: z.string().describe("Reasoning explaining why the plan was constructed this way"),
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
 * Transforms a natural language instruction into a structured plan (TaskPlan)
 * for deferred or asynchronous execution by workers, via the TaskCoordinator.
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
You are an expert task planner for the NEXUS system.
Your role is to translate the user instruction into a structured and valid execution plan.

Device capabilities currently registered in the system:
${this.#availableCapabilities.map((c) => `- ${c}`).join("\n")}

ABSOLUTE RULES:
1. Do NOT invent ANY capability. Use only those listed above.
2. For each step, 'tool' MUST ALWAYS match 'device.<capability>'. For example, for capability 'browser.navigate', the tool is 'device.browser.navigate'.
3. The 'dependsOn' field must use the exact IDs of prerequisite steps, creating an execution DAG.
4. Accurately evaluate 'riskLevel' (SAFE, LOW, MEDIUM, HIGH, CRITICAL). E.g.: Reading a file is SAFE. Executing a shell script is HIGH.
5. If the request is too ambiguous, unsafe without context, or technically impossible with the available capabilities, you MUST generate an EMPTY step list (steps: []) and explain why in 'reasoning'.
`;

    const request = {
      messages: [
        { role: "user", content: [{ type: "text", text: input.instruction }] },
      ] as LlmMessage[],
      system: systemPrompt,
    };

    let result: LlmTaskPlan;
    try {
      result = await this.#llm.structuredOutput(request, llmTaskPlanSchema);
    } catch (err: unknown) {
      throw new TaskPlannerError(
        "Error during plan generation by LLM: " +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    if (!result.steps || result.steps.length === 0) {
      throw new TaskPlannerError(
        "Ambiguous instruction or impossible to plan: " + result.reasoning,
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
