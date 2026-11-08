import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { NEXUS_EXPOSED_MCP_TOOLS } from "@nexus/mcp";
import { currentUser } from "../../plugins/authentication.js";
import { ok, okSchema } from "../../lib/response.js";
import { NotFoundError } from "../../services/stores.js";
import {
  MCP_SCOPES,
  MCP_TOKEN_MAX_DAYS,
  McpGateway,
  type McpTokenRecord,
} from "../../services/mcp-gateway.js";
import { missionOwnerPrefix } from "../../services/acp-orchestrator.js";
import { buildAcpOrchestrator } from "./orchestrator.js";

const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

const tokenViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.date(),
  expiresAt: z.date(),
  revokedAt: z.date().nullable(),
  lastUsedAt: z.date().nullable(),
});

function tokenView(token: McpTokenRecord): z.infer<typeof tokenViewSchema> {
  return {
    id: token.id,
    name: token.name,
    scopes: token.scopes,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    lastUsedAt: token.lastUsedAt,
  };
}

const rpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length).trim() : undefined;
}

function refuseMethod(_request: FastifyRequest, reply: FastifyReply) {
  // This server answers each POST directly and keeps no stream or session to open or close.
  return reply.code(405).header("allow", "POST").send();
}

export const mcpRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const orchestrator = buildAcpOrchestrator(app);

  const gateway = new McpGateway({
    store: app.services.mcpAccessStore,
    backend: {
      listMissions: async (userId, limit) => {
        const client = app.services.missionControl;
        if (client === undefined) throw new Error("Mission Engine is not configured.");
        return client.listMissions(limit, `${missionOwnerPrefix(userId)}-`);
      },
      triggerMission: async (userId, goal) => {
        app.services.pause.assertRunning();
        if (orchestrator === undefined) throw new Error("Mission Engine is not configured.");
        return orchestrator.submit(userId, goal, "UTC");
      },
      listDevices: async (userId) => {
        const devices = await app.services.deviceRegistry.listDevices(userId);
        return devices.map((device) => ({
          id: device.id,
          name: device.name,
          type: device.type,
          status: device.status,
        }));
      },
      usageMetrics: async (userId, days) => ({
        source: "agent_run_records",
        days,
        buckets: await app.services.runStore.summarizeForUser(
          userId,
          new Date(Date.now() - days * 86_400_000),
        ),
      }),
    },
  });

  app.get(
    "/mcp/tokens",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["mcp"],
        summary: "External MCP connections created by the signed-in user",
        response: {
          200: okSchema(
            z.object({ tokens: z.array(tokenViewSchema), availableScopes: z.array(z.string()) }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const tokens = await gateway.listTokens(userId);
      return ok({ tokens: tokens.map(tokenView), availableScopes: [...MCP_SCOPES] }, request.id);
    },
  );

  app.post(
    "/mcp/tokens",
    {
      preHandler: app.requireUser,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["mcp"],
        summary: "Creates a scoped, expiring token. Its value is returned only here.",
        body: z.object({
          name: z.string().trim().min(1).max(120),
          scopes: z.array(z.enum(MCP_SCOPES)).min(1),
          expiresInDays: z.number().int().min(1).max(MCP_TOKEN_MAX_DAYS),
        }),
        response: {
          201: okSchema(z.object({ token: z.string(), record: tokenViewSchema })),
        },
      },
    },
    async (request, reply) => {
      const { userId } = currentUser(request);
      const { token, record } = await gateway.issueToken(userId, request.body);
      return reply.code(201).send(ok({ token, record: tokenView(record) }, request.id));
    },
  );

  app.delete(
    "/mcp/tokens/:tokenId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["mcp"],
        summary: "Revokes a token immediately",
        params: z.object({ tokenId: z.string().uuid() }),
        response: { 200: okSchema(z.object({ revoked: z.literal(true) })) },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const revoked = await gateway.revokeToken(userId, request.params.tokenId);
      if (!revoked) throw new NotFoundError("MCP token", request.params.tokenId);
      return ok({ revoked: true as const }, request.id);
    },
  );

  app.get(
    "/mcp/activity",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["mcp"],
        summary: "Recent tool calls made with the signed-in user's tokens",
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: {
          200: okSchema(
            z.object({
              activity: z.array(
                z.object({
                  id: z.string(),
                  tokenId: z.string(),
                  tool: z.string(),
                  outcome: z.string(),
                  errorCode: z.string().nullable(),
                  durationMs: z.number(),
                  createdAt: z.date(),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => {
      const { userId } = currentUser(request);
      const activity = await gateway.listActivity(userId, request.query.limit);
      return ok(
        {
          activity: activity.map(
            ({ id, tokenId, tool, outcome, errorCode, durationMs, createdAt }) => ({
              id,
              tokenId,
              tool,
              outcome,
              errorCode,
              durationMs,
              createdAt,
            }),
          ),
        },
        request.id,
      );
    },
  );

  app.get("/mcp/tools", { preHandler: app.requireUser, schema: { tags: ["mcp"] } }, (request) =>
    ok({ tools: NEXUS_EXPOSED_MCP_TOOLS }, request.id),
  );

  app.get(
    "/mcp/oauth/providers",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["mcp"],
        summary: "Lists all available turnkey OAuth MCP providers with connection status",
        response: {
          200: okSchema(
            z.object({
              providers: z.array(
                z.object({
                  id: z.string(),
                  name: z.string(),
                  description: z.string(),
                  icon: z.string(),
                  docUrl: z.string(),
                  defaultScopes: z.array(z.string()),
                  supportsPkce: z.boolean(),
                  connected: z.boolean(),
                  activeInRuntime: z.boolean(),
                  clientIdConfigured: z.boolean(),
                  vaultRef: z.string(),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => {
      if (!app.services.mcpOAuth) {
        return ok({ providers: [] }, request.id);
      }
      const providers = await app.services.mcpOAuth.listProviders();
      return ok({ providers }, request.id);
    },
  );

  app.post(
    "/mcp/oauth/authorize",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["mcp"],
        summary: "Starts OAuth PKCE flow for an MCP provider",
        body: z.object({
          providerId: z.string(),
          clientId: z.string().optional(),
          redirectUri: z.string().optional(),
          scopes: z.array(z.string()).optional(),
        }),
        response: {
          200: okSchema(
            z.object({
              authorizationUrl: z.string(),
              state: z.string(),
              providerId: z.string(),
            }),
          ),
        },
      },
    },
    async (request) => {
      if (!app.services.mcpOAuth) {
        throw new Error("MCP OAuth service is not enabled.");
      }
      const result = await app.services.mcpOAuth.startAuthorization(request.body.providerId, {
        clientId: request.body.clientId,
        redirectUri: request.body.redirectUri,
        scopes: request.body.scopes,
      });
      return ok(result, request.id);
    },
  );

  app.post(
    "/mcp/oauth/callback",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["mcp"],
        summary: "Completes OAuth authorization code exchange and mounts the MCP server",
        body: z.object({
          providerId: z.string(),
          code: z.string(),
          state: z.string(),
          clientId: z.string().optional(),
          clientSecret: z.string().optional(),
          redirectUri: z.string().optional(),
        }),
        response: {
          200: okSchema(
            z.object({
              success: z.boolean(),
              providerId: z.string(),
              connected: z.boolean(),
            }),
          ),
        },
      },
    },
    async (request) => {
      if (!app.services.mcpOAuth) {
        throw new Error("MCP OAuth service is not enabled.");
      }
      const result = await app.services.mcpOAuth.completeAuthorization(request.body.providerId, {
        code: request.body.code,
        state: request.body.state,
        clientId: request.body.clientId,
        clientSecret: request.body.clientSecret,
        redirectUri: request.body.redirectUri,
      });
      return ok(result, request.id);
    },
  );

  app.delete(
    "/mcp/oauth/:providerId",
    {
      preHandler: app.requireUser,
      schema: {
        tags: ["mcp"],
        summary: "Disconnects an OAuth MCP server and revokes its tokens from vault",
        params: z.object({ providerId: z.string() }),
        response: {
          200: okSchema(
            z.object({
              success: z.boolean(),
              providerId: z.string(),
            }),
          ),
        },
      },
    },
    async (request) => {
      if (!app.services.mcpOAuth) {
        throw new Error("MCP OAuth service is not enabled.");
      }
      const result = await app.services.mcpOAuth.disconnect(request.params.providerId);
      return ok(result, request.id);
    },
  );

  app.get("/mcp", { schema: { tags: ["mcp"], hide: true } }, refuseMethod);
  app.delete("/mcp", { schema: { tags: ["mcp"], hide: true } }, refuseMethod);

  /** MCP Streamable HTTP endpoint, authenticated by a token rather than a user session. */
  app.post(
    "/mcp",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: { tags: ["mcp"], summary: "MCP endpoint for external clients" },
    },
    async (request, reply) => {
      const raw = bearerToken(request);
      const token = raw === undefined ? undefined : await gateway.authenticate(raw);
      if (token === undefined) {
        return reply
          .code(401)
          .header("www-authenticate", "Bearer")
          .send({ code: "UNAUTHORIZED", message: "A valid MCP token is required." });
      }

      const parsed = rpcRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.send({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid request" },
        });
      }
      const { id, method, params } = parsed.data;
      // Notifications have no id and expect no answer.
      if (id === undefined) return reply.code(202).send();

      const respond = (result: unknown) => reply.send({ jsonrpc: "2.0", id, result });
      switch (method) {
        case "initialize": {
          const requested = params?.protocolVersion;
          return respond({
            protocolVersion:
              typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
                ? requested
                : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "nexus", version: "1.0.0" },
          });
        }
        case "ping":
          return respond({});
        case "tools/list":
          return respond({
            tools: gateway.listTools(token).map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          });
        case "tools/call": {
          const call = z
            .object({
              name: z.string(),
              arguments: z.record(z.string(), z.unknown()).default({}),
            })
            .safeParse(params);
          if (!call.success) {
            return reply.send({
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "Invalid tool call" },
            });
          }
          return respond(await gateway.callTool(token, call.data.name, call.data.arguments));
        }
        default:
          return reply.send({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "Method not found" },
          });
      }
    },
  );

  done();
};
