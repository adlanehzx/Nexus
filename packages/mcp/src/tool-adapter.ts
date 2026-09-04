import { z } from "zod";
import {
  maxRisk,
  riskRank,
  type RiskLevel,
  type ToolDefinition,
  type Permission,
} from "@nexus/tools";
import type { McpClient, McpToolInfo } from "./client.js";
import type { McpServerConfig, McpToolPolicy } from "./config.js";
import { McpSchemaError, McpToolCallError, McpUnavailableError } from "./errors.js";
import { normalizeToolSchema, zodFromJsonSchema } from "./json-schema.js";

/**
 * Adaptation d'un outil MCP en `ToolDefinition`.
 *
 * C'est la seule frontière entre MCP et le reste de NEXUS. En sortie, le cœur
 * agent voit un outil ordinaire : même contrat, mêmes permissions, mêmes
 * confirmations, même exécuteur. Il ignore jusqu'à l'existence de MCP.
 */

/** Sortie normalisée d'un appel MCP. */
export const mcpToolOutputSchema = z.object({
  text: z.string(),
  structured: z.unknown(),
});
export type McpToolOutput = z.infer<typeof mcpToolOutputSchema>;

const MAX_DESCRIPTION_CHARS = 1_000;

/** Nom canonique d'un outil MCP dans le registre. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp.${server}.${tool}`;
}

/**
 * Nettoie une description fournie par un serveur tiers.
 *
 * C'est une **entrée non fiable** : elle sera placée dans le prompt et peut
 * contenir une injection. On la borne, on neutralise les balises qui
 * ressembleraient à des marqueurs de prompt, et on l'annonce comme provenant du
 * serveur — le modèle est instruit de traiter ce contenu comme une donnée.
 */
export function sanitizeDescription(server: string, tool: McpToolInfo): string {
  const raw = tool.description ?? tool.title ?? tool.name;
  const cleaned = raw
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);

  return `[serveur MCP « ${server} », description fournie par le serveur] ${cleaned}`;
}

/**
 * Détermine le niveau de risque.
 *
 * Deux règles, dans cet ordre :
 *
 *  1. Une politique **humaine** (configuration) fait autorité. C'est le seul
 *     moyen d'abaisser le risque d'un outil MCP.
 *  2. À défaut, on part du défaut du serveur (`MEDIUM`) et les annotations du
 *     serveur ne peuvent que l'**élever**. Le SDK MCP le dit lui-même :
 *     « Clients should never make tool use decisions based on ToolAnnotations
 *     received from untrusted servers. » Un `readOnlyHint: true` venant d'un
 *     serveur compromis ne doit pas transformer une suppression en lecture.
 */
export function resolveRisk(
  config: McpServerConfig,
  tool: McpToolInfo,
  policy: McpToolPolicy | undefined,
): RiskLevel {
  if (policy?.risk !== undefined) return policy.risk;

  const base = config.defaultRisk;
  const destructive = tool.annotations?.destructiveHint === true;
  const openWorld = tool.annotations?.openWorldHint === true;

  if (destructive) return maxRisk(base, "HIGH");
  if (openWorld) return maxRisk(base, "MEDIUM");
  return base;
}

export interface AdaptToolOptions {
  client: McpClient;
  config: McpServerConfig;
  tool: McpToolInfo;
  /** Vrai si le serveur est utilisable maintenant — évalué à chaque appel. */
  isAvailable: () => boolean;
  /** Motif d'indisponibilité, pour une erreur exploitable par l'agent. */
  unavailableReason: () => { status: string; detail?: string };
}

/**
 * Construit la `ToolDefinition` correspondant à un outil MCP.
 *
 * @throws {McpSchemaError} si le schéma d'entrée est inexploitable — on refuse
 *   l'outil plutôt que d'en deviner la forme.
 */
export function adaptMcpTool(options: AdaptToolOptions): ToolDefinition<unknown, McpToolOutput> {
  const { client, config, tool, isAvailable, unavailableReason } = options;
  const policy = config.toolPolicies[tool.name];

  const jsonSchema = normalizeToolSchema(tool.inputSchema);
  let inputSchema: z.ZodType<unknown>;
  try {
    inputSchema = zodFromJsonSchema(jsonSchema);
  } catch (error) {
    throw new McpSchemaError(
      config.name,
      tool.name,
      error instanceof Error ? error.message : String(error),
    );
  }

  const risk = resolveRisk(config, tool, policy);
  const permissions = (policy?.permissions ?? config.defaultPermissions) as Permission[];
  const timeoutMs = policy?.timeoutMs ?? config.requestTimeoutMs;

  // Un outil n'est rejoué automatiquement que si un humain l'a classé SAFE ou
  // LOW. On ne se fie pas à `idempotentHint` : une reprise sur un outil qui a
  // déjà agi produirait un doublon d'effet de bord.
  const idempotent = riskRank(risk) <= riskRank("LOW");

  return {
    name: mcpToolName(config.name, tool.name),
    description: sanitizeDescription(config.name, tool),
    version: "1",
    inputSchema,
    // Le modèle reçoit le schéma d'origine du serveur, pas une traduction.
    inputJsonSchema: jsonSchema,
    outputSchema: mcpToolOutputSchema,
    riskLevel: risk,
    requiredPermissions: permissions,
    requiresConfirmation: policy?.requiresConfirmation ?? riskRank(risk) >= riskRank("MEDIUM"),
    idempotent,
    timeoutMs,
    summarize: (input) =>
      `${tool.title ?? tool.name} via le serveur MCP « ${config.name} » — ${JSON.stringify(input).slice(0, 200)}`,

    execute: async (input, context): Promise<McpToolOutput> => {
      // L'indisponibilité est vérifiée à l'appel, pas à l'enregistrement : un
      // serveur peut tomber entre la découverte et l'exécution.
      if (!isAvailable()) {
        const reason = unavailableReason();
        throw new McpUnavailableError(config.name, reason.status, reason.detail);
      }

      const result = await client.callTool(tool.name, input, {
        signal: context.signal,
        timeoutMs,
      });

      if (result.isError) {
        throw new McpToolCallError(
          config.name,
          tool.name,
          result.text.length > 0 ? result.text : "le serveur a signalé un échec sans détail",
        );
      }

      return { text: result.text, structured: result.structured };
    },
  };
}
