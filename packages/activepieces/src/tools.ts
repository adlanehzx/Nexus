import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@nexus/tools";
import type { ActivepiecesBridgeClient } from "./client.js";
import { isSensitiveSaaSAction, summarizeSaaSAction } from "./security.js";

export const activepiecesListFlowsInputSchema = z.object({});

export const activepiecesListFlowsOutputSchema = z.object({
  flows: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.enum(["ENABLED", "DISABLED"]),
      webhookUrl: z.string().optional(),
      updatedAt: z.string().optional(),
    }),
  ),
});

export const activepiecesTriggerFlowInputSchema = z.object({
  flowId: z.string().optional().describe("Activepieces flow identifier"),
  webhookUrl: z.string().url().optional().describe("Direct triggering webhook URL"),
  payload: z.record(z.string(), z.unknown()).default({}).describe("Payload passed to flow"),
  waitForCompletion: z.boolean().default(true).describe("Wait for flow execution to finish"),
  isSensitive: z
    .boolean()
    .default(false)
    .describe("Indicates whether flow triggers sensitive external effects"),
});

export const activepiecesTriggerFlowOutputSchema = z.object({
  runId: z.string(),
  flowId: z.string(),
  status: z.enum(["RUNNING", "SUCCEEDED", "FAILED", "PAUSED"]),
  output: z.unknown().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
});

export const activepiecesExecuteActionInputSchema = z.object({
  pieceName: z.string().min(1).describe("SaaS piece name (e.g. slack, notion, stripe, github)"),
  actionName: z
    .string()
    .min(1)
    .describe("Action name to execute (e.g. send_message, create_customer)"),
  input: z.record(z.string(), z.unknown()).describe("Action input parameters"),
  pieceVersion: z.string().optional().describe("Optional piece version"),
  isSensitive: z.boolean().optional().describe("Forces human confirmation request if true"),
});

export const activepiecesExecuteActionOutputSchema = z.object({
  success: z.boolean(),
  pieceName: z.string(),
  actionName: z.string(),
  output: z.unknown(),
  error: z.string().optional(),
});

export const activepiecesGetRunInputSchema = z.object({
  runId: z.string().min(1).describe("Unique flow run identifier"),
});

export const activepiecesGetRunOutputSchema = activepiecesTriggerFlowOutputSchema;

/**
 * Creates Activepieces SaaS automation and bridge tools for NEXUS.
 */
export function createActivepiecesTools(options: {
  client: ActivepiecesBridgeClient;
}): ToolDefinition<never, unknown>[] {
  const { client } = options;

  const tools = [
    // 1. activepieces.list_flows
    {
      name: "activepieces.list_flows",
      version: "1.0.0",
      description: "Lists all local automation flows configured in Activepieces.",
      inputSchema: activepiecesListFlowsInputSchema,
      outputSchema: activepiecesListFlowsOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["terminal.execute"],
      requiresConfirmation: false,
      timeoutMs: 15_000,
      summarize: () => "View available Activepieces flows",
      execute: async (
        _input: z.infer<typeof activepiecesListFlowsInputSchema>,
        context: ToolContext,
      ) => {
        const flows = await client.listFlows(context.signal);
        return { flows };
      },
    },

    // 2. activepieces.trigger_flow
    {
      name: "activepieces.trigger_flow",
      version: "1.0.0",
      description:
        "Triggers an Activepieces automation flow via webhook or flow ID. Requires confirmation if marked sensitive.",
      inputSchema: activepiecesTriggerFlowInputSchema,
      outputSchema: activepiecesTriggerFlowOutputSchema,
      riskLevel: "HIGH",
      requiredPermissions: ["terminal.execute"],
      requiresConfirmation: (input: z.infer<typeof activepiecesTriggerFlowInputSchema>) =>
        input.isSensitive === true,
      timeoutMs: 60_000,
      summarize: (input: z.infer<typeof activepiecesTriggerFlowInputSchema>) =>
        `Trigger Activepieces flow "${input.flowId ?? "external webhook"}"`,
      execute: async (
        input: z.infer<typeof activepiecesTriggerFlowInputSchema>,
        context: ToolContext,
      ) => {
        return client.triggerFlow(input, context.signal);
      },
    },

    // 3. activepieces.execute_action (DYNAMIC CONFIRMATION)
    {
      name: "activepieces.execute_action",
      version: "1.0.0",
      description:
        "Executes a direct action on a SaaS connector (Slack, Notion, Stripe, GitHub, Airtable, etc.). Outbound messaging and financial actions require human confirmation.",
      inputSchema: activepiecesExecuteActionInputSchema,
      outputSchema: activepiecesExecuteActionOutputSchema,
      riskLevel: "HIGH",
      requiredPermissions: ["terminal.execute"],
      requiresConfirmation: (input: z.infer<typeof activepiecesExecuteActionInputSchema>) =>
        isSensitiveSaaSAction(input.pieceName, input.actionName, input.input),
      timeoutMs: 45_000,
      summarize: (input: z.infer<typeof activepiecesExecuteActionInputSchema>) =>
        summarizeSaaSAction(input.pieceName, input.actionName, input.input),
      execute: async (
        input: z.infer<typeof activepiecesExecuteActionInputSchema>,
        context: ToolContext,
      ) => {
        return client.executePieceAction(input, context.signal);
      },
    },

    // 4. activepieces.get_run
    {
      name: "activepieces.get_run",
      version: "1.0.0",
      description: "Polls status and result of an Activepieces flow execution.",
      inputSchema: activepiecesGetRunInputSchema,
      outputSchema: activepiecesGetRunOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["terminal.execute"],
      requiresConfirmation: false,
      timeoutMs: 15_000,
      summarize: (input: z.infer<typeof activepiecesGetRunInputSchema>) =>
        `View Activepieces run ${input.runId}`,
      execute: async (
        input: z.infer<typeof activepiecesGetRunInputSchema>,
        context: ToolContext,
      ) => {
        return client.getRun(input.runId, context.signal);
      },
    },
  ];

  return tools as unknown as ToolDefinition<never, unknown>[];
}
