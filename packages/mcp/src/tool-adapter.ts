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
 * Adapts an MCP tool into a `ToolDefinition`.
 *
 * This is the bridge between MCP and the rest of NEXUS. To the agent core,
 * an MCP tool behaves like any standard tool with contract, permissions,
 * confirmations, and executor.
 */

/** Normalized output of an MCP tool invocation. */
export const mcpToolOutputSchema = z.object({
  text: z.string(),
  structured: z.unknown(),
});
export type McpToolOutput = z.infer<typeof mcpToolOutputSchema>;

const MAX_DESCRIPTION_CHARS = 1_000;

/** Canonical name of an MCP tool in the registry. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp.${server}.${tool}`;
}

/**
 * Sanitizes description provided by an external MCP server.
 * Bounded and tags sanitized to prevent prompt injection.
 */
export function sanitizeDescription(server: string, tool: McpToolInfo): string {
  const raw = tool.description ?? tool.title ?? tool.name;
  const cleaned = raw
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);

  return `[MCP server "${server}", description provided by server] ${cleaned}`;
}

/**
 * Determines risk level for an MCP tool.
 *
 * Explicit human config policy takes precedence. Otherwise default server risk
 * is used, and tool annotations may only escalate risk.
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
  isAvailable: () => boolean;
  unavailableReason: () => { status: string; detail?: string };
}

/**
 * Constructs a `ToolDefinition` from an MCP tool.
 *
 * @throws {McpSchemaError} if the input schema is uninterpretable.
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

  const idempotent = riskRank(risk) <= riskRank("LOW");

  return {
    name: mcpToolName(config.name, tool.name),
    description: sanitizeDescription(config.name, tool),
    version: "1",
    inputSchema,
    inputJsonSchema: jsonSchema,
    outputSchema: mcpToolOutputSchema,
    riskLevel: risk,
    requiredPermissions: permissions,
    requiresConfirmation: policy?.requiresConfirmation ?? riskRank(risk) >= riskRank("MEDIUM"),
    idempotent,
    timeoutMs,
    summarize: (input) =>
      `${tool.title ?? tool.name} via MCP server "${config.name}" — ${JSON.stringify(input).slice(0, 200)}`,

    execute: async (input, context): Promise<McpToolOutput> => {
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
          result.text.length > 0 ? result.text : "server reported failure without details",
        );
      }

      return { text: result.text, structured: result.structured };
    },
  };
}
