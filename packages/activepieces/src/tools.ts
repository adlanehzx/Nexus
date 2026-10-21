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
  flowId: z.string().optional().describe("Identifiant du flux Activepieces"),
  webhookUrl: z.string().url().optional().describe("URL directe du webhook de déclenchement"),
  payload: z.record(z.string(), z.unknown()).default({}).describe("Données transmises au flux"),
  waitForCompletion: z.boolean().default(true).describe("Attendre la fin de l'exécution du flux"),
  isSensitive: z.boolean().default(false).describe("Indique si le flux produit des effets externes sensibles"),
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
  pieceName: z.string().min(1).describe("Nom de la pièce SaaS (ex: slack, notion, stripe, github)"),
  actionName: z.string().min(1).describe("Nom de l'action à exécuter (ex: send_message, create_customer)"),
  input: z.record(z.string(), z.unknown()).describe("Paramètres d'entrée de l'action"),
  pieceVersion: z.string().optional().describe("Version optionnelle de la pièce"),
  isSensitive: z.boolean().optional().describe("Force la demande de confirmation humaine si true"),
});

export const activepiecesExecuteActionOutputSchema = z.object({
  success: z.boolean(),
  pieceName: z.string(),
  actionName: z.string(),
  output: z.unknown(),
  error: z.string().optional(),
});

export const activepiecesGetRunInputSchema = z.object({
  runId: z.string().min(1).describe("Identifiant unique de l'exécution de flux"),
});

export const activepiecesGetRunOutputSchema = activepiecesTriggerFlowOutputSchema;

/**
 * Crée les outils d'automatisation et de pont SaaS Activepieces pour NEXUS.
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
      description: "Liste tous les flux d'automatisation locaux enregistrés dans Activepieces.",
      inputSchema: activepiecesListFlowsInputSchema,
      outputSchema: activepiecesListFlowsOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["terminal.execute"],
      requiresConfirmation: false,
      timeoutMs: 15_000,
      summarize: () => "Consultation des flux Activepieces disponibles",
      execute: async (_input: z.infer<typeof activepiecesListFlowsInputSchema>, context: ToolContext) => {
        const flows = await client.listFlows(context.signal);
        return { flows };
      },
    },

    // 2. activepieces.trigger_flow
    {
      name: "activepieces.trigger_flow",
      version: "1.0.0",
      description:
        "Déclenche un flux d'automatisation Activepieces via webhook ou identifiant. Requiert une confirmation si marqué sensible.",
      inputSchema: activepiecesTriggerFlowInputSchema,
      outputSchema: activepiecesTriggerFlowOutputSchema,
      riskLevel: "HIGH",
      requiredPermissions: ["terminal.execute"],
      requiresConfirmation: (input: z.infer<typeof activepiecesTriggerFlowInputSchema>) =>
        input.isSensitive === true,
      timeoutMs: 60_000,
      summarize: (input: z.infer<typeof activepiecesTriggerFlowInputSchema>) =>
        `Déclenchement du flux Activepieces « ${input.flowId ?? "webhook externe"} »`,
      execute: async (input: z.infer<typeof activepiecesTriggerFlowInputSchema>, context: ToolContext) => {
        return client.triggerFlow(input, context.signal);
      },
    },

    // 3. activepieces.execute_action (CONFIRMATION DYNAMIQUE)
    {
      name: "activepieces.execute_action",
      version: "1.0.0",
      description:
        "Exécute une action directe sur un connecteur SaaS (Slack, Notion, Stripe, GitHub, Airtable, etc.). Les actions d'envoi externe ou financières exigent une confirmation humaine.",
      inputSchema: activepiecesExecuteActionInputSchema,
      outputSchema: activepiecesExecuteActionOutputSchema,
      riskLevel: "HIGH",
      requiredPermissions: ["terminal.execute"],
      requiresConfirmation: (input: z.infer<typeof activepiecesExecuteActionInputSchema>) =>
        isSensitiveSaaSAction(input.pieceName, input.actionName, input.input),
      timeoutMs: 45_000,
      summarize: (input: z.infer<typeof activepiecesExecuteActionInputSchema>) =>
        summarizeSaaSAction(input.pieceName, input.actionName, input.input),
      execute: async (input: z.infer<typeof activepiecesExecuteActionInputSchema>, context: ToolContext) => {
        return client.executePieceAction(input, context.signal);
      },
    },

    // 4. activepieces.get_run
    {
      name: "activepieces.get_run",
      version: "1.0.0",
      description: "Interroge le statut et le résultat d'une exécution de flux Activepieces.",
      inputSchema: activepiecesGetRunInputSchema,
      outputSchema: activepiecesGetRunOutputSchema,
      riskLevel: "SAFE",
      requiredPermissions: ["terminal.execute"],
      requiresConfirmation: false,
      timeoutMs: 15_000,
      summarize: (input: z.infer<typeof activepiecesGetRunInputSchema>) =>
        `Consultation de l'exécution Activepieces ${input.runId}`,
      execute: async (input: z.infer<typeof activepiecesGetRunInputSchema>, context: ToolContext) => {
        return client.getRun(input.runId, context.signal);
      },
    },
  ];

  return tools as unknown as ToolDefinition<never, unknown>[];
}
