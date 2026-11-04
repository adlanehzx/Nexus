/**
 * NEXUS MCP Server Implementation (LOT G)
 *
 * Exposes NEXUS platform capabilities (missions, devices, metrics)
 * to external MCP clients (Claude Desktop, Cursor, etc.) under strict RBAC.
 *
 * Copyright (C) 2026 the NEXUS contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { McpSecurityError } from "./errors.js";

export interface McpSecurityContext {
  token: string;
  organizationId: string;
  scopes: string[];
}

export interface McpServerToolDefinition {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: Record<string, unknown>;
}

export const NEXUS_EXPOSED_MCP_TOOLS: readonly McpServerToolDefinition[] = [
  {
    name: "nexus_list_missions",
    description: "List recent autonomous agent missions with their phase and outcome.",
    requiredScope: "missions:read",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 10 },
      },
    },
  },
  {
    name: "nexus_trigger_mission",
    description: "Launch an autonomous mission with a goal description.",
    requiredScope: "missions:write",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        worktreePath: { type: "string" },
      },
      required: ["goal"],
    },
  },
  {
    name: "nexus_list_devices",
    description: "List registered devices and satellite nodes in the current workspace.",
    requiredScope: "devices:read",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "nexus_get_usage_metrics",
    description: "Retrieve token consumption and equivalent API cost analytics.",
    requiredScope: "metrics:read",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string" },
      },
    },
  },
];

export class NexusMcpServer {
  private readonly validTokens = new Map<string, McpSecurityContext>();

  registerClientToken(context: McpSecurityContext): void {
    this.validTokens.set(context.token, context);
  }

  assertAuthorized(token: string, requiredScope: string): McpSecurityContext {
    const ctx = this.validTokens.get(token);
    if (!ctx) {
      throw new McpSecurityError("nexus-server", "Invalid or missing MCP bearer token");
    }
    if (!ctx.scopes.includes(requiredScope) && !ctx.scopes.includes("*")) {
      throw new McpSecurityError(
        "nexus-server",
        `Insufficient MCP scope: token lacks required scope '${requiredScope}'`,
      );
    }
    return ctx;
  }

  listTools(token: string): readonly McpServerToolDefinition[] {
    const ctx = this.validTokens.get(token);
    if (!ctx) {
      throw new McpSecurityError("nexus-server", "Invalid or missing MCP bearer token");
    }
    return NEXUS_EXPOSED_MCP_TOOLS.filter(
      (tool) => ctx.scopes.includes("*") || ctx.scopes.includes(tool.requiredScope),
    );
  }

  async executeTool(
    token: string,
    toolName: string,
    arguments_: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    const toolDef = NEXUS_EXPOSED_MCP_TOOLS.find((t) => t.name === toolName);
    if (!toolDef) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }

    const ctx = this.assertAuthorized(token, toolDef.requiredScope);

    switch (toolName) {
      case "nexus_list_missions":
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                organizationId: ctx.organizationId,
                missions: [
                  { id: "mission-1", goal: "Implement caching layer", status: "completed" },
                  { id: "mission-2", goal: "Audit security headers", status: "running" },
                ],
              }),
            },
          ],
        };

      case "nexus_trigger_mission":
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                missionId: `mission-${Date.now()}`,
                status: "queued",
                goal: arguments_.goal,
              }),
            },
          ],
        };

      case "nexus_list_devices":
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                devices: [
                  { id: "dev-desktop-1", name: "Workstation Linux", status: "connected" },
                  { id: "dev-mobile-1", name: "Pixel 9 Pro", status: "idle" },
                ],
              }),
            },
          ],
        };

      case "nexus_get_usage_metrics":
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                totalTokens: 145000,
                totalCostUsd: 0.85,
                status: "healthy",
              }),
            },
          ],
        };

      default:
        return {
          content: [{ type: "text", text: `Unimplemented tool: ${toolName}` }],
          isError: true,
        };
    }
  }
}
