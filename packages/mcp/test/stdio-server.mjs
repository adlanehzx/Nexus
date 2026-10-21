#!/usr/bin/env node
/**
 * Real stdio MCP server used for transport tests.
 * Runs as a real child process spawned by `StdioClientTransport`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "stdio-server", version: "0.0.1" });

server.registerTool(
  "add",
  {
    description: "Adds two numbers.",
    inputSchema: { a: z.number(), b: z.number() },
    annotations: { readOnlyHint: true },
  },
  ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);

server.registerTool(
  "whoami",
  {
    description: "Returns secret injected into process environment.",
    inputSchema: {},
  },
  () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          secret: process.env.NEXUS_TEST_SECRET ?? "(absent)",
          parentLeak: process.env.NEXUS_PARENT_ONLY ?? "(absent)",
        }),
      },
    ],
  }),
);

server.registerTool(
  "crash",
  { description: "Kills server process to test reconnection.", inputSchema: {} },
  () => {
    setTimeout(() => {
      process.exit(1);
    }, 10);
    return { content: [{ type: "text", text: "goodbye" }] };
  },
);

await server.connect(new StdioServerTransport());
