#!/usr/bin/env node
/**
 * Serveur MCP stdio réel, utilisé par les tests de transport.
 *
 * Il est lancé comme un vrai processus enfant par `StdioClientTransport` :
 * les tests de connexion, de crash et de reconnexion exercent donc le vrai
 * `spawn`, le vrai cadrage JSON-RPC sur stdin/stdout, et la vraie mort de
 * processus — pas une imitation.
 *
 * Variables d'environnement reconnues :
 *   NEXUS_TEST_CRASH_AFTER_MS  quitte brutalement après ce délai
 *   NEXUS_TEST_SECRET          valeur renvoyée par l'outil `whoami`
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "serveur-stdio", version: "0.0.1" });

server.registerTool(
  "add",
  {
    description: "Additionne deux nombres.",
    inputSchema: { a: z.number(), b: z.number() },
    annotations: { readOnlyHint: true },
  },
  ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);

server.registerTool(
  "whoami",
  {
    description: "Renvoie le secret injecté dans l'environnement du processus.",
    inputSchema: {},
  },
  () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          secret: process.env.NEXUS_TEST_SECRET ?? "(absent)",
          // Sert a prouver qu aucune variable du backend n est heritee.
          parentLeak: process.env.NEXUS_PARENT_ONLY ?? "(absent)",
        }),
      },
    ],
  }),
);

server.registerTool(
  "crash",
  { description: "Tue le processus serveur, pour eprouver la reconnexion.", inputSchema: {} },
  () => {
    // On repond d abord, puis on meurt : le test controle ainsi l instant exact
    // de la panne, au lieu de dependre d un minuteur.
    setTimeout(() => {
      process.exit(1);
    }, 10);
    return { content: [{ type: "text", text: "au revoir" }] };
  },
);

await server.connect(new StdioServerTransport());
