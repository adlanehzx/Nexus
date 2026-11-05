import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@nexus/database";
import { NEXUS_EXPOSED_MCP_TOOLS, type McpServerToolDefinition } from "@nexus/mcp";

/**
 * NEXUS as an MCP server for external clients.
 *
 * A token acts for the user who created it, within its scopes, and every call runs
 * the same services the API uses, so it can never reach more than that user can.
 * Only a hash of the token is stored; the value is shown once, at creation.
 */

export const MCP_SCOPES = [
  "missions:read",
  "missions:write",
  "devices:read",
  "metrics:read",
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export interface McpTokenRecord {
  id: string;
  userId: string;
  name: string;
  scopes: string[];
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

export interface McpActivityRecord {
  id: string;
  tokenId: string;
  userId: string;
  tool: string;
  outcome: "success" | "error" | "denied";
  errorCode: string | null;
  durationMs: number;
  createdAt: Date;
}

export interface McpAccessStore {
  createToken(record: McpTokenRecord): Promise<void>;
  findTokenByHash(tokenHash: string): Promise<McpTokenRecord | undefined>;
  listTokens(userId: string): Promise<McpTokenRecord[]>;
  /** Returns false when the token does not exist or belongs to someone else. */
  revokeToken(userId: string, id: string, at: Date): Promise<boolean>;
  touchToken(id: string, at: Date): Promise<void>;
  recordActivity(record: McpActivityRecord): Promise<void>;
  listActivity(userId: string, limit: number): Promise<McpActivityRecord[]>;
}

/** For tests and installations without a database. Tokens do not survive a restart. */
export class InMemoryMcpAccessStore implements McpAccessStore {
  readonly #tokens = new Map<string, McpTokenRecord>();
  readonly #activity: McpActivityRecord[] = [];

  createToken(record: McpTokenRecord): Promise<void> {
    this.#tokens.set(record.id, { ...record });
    return Promise.resolve();
  }

  findTokenByHash(tokenHash: string): Promise<McpTokenRecord | undefined> {
    return Promise.resolve([...this.#tokens.values()].find((t) => t.tokenHash === tokenHash));
  }

  listTokens(userId: string): Promise<McpTokenRecord[]> {
    return Promise.resolve(
      [...this.#tokens.values()]
        .filter((token) => token.userId === userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    );
  }

  revokeToken(userId: string, id: string, at: Date): Promise<boolean> {
    const token = this.#tokens.get(id);
    if (token?.userId !== userId) return Promise.resolve(false);
    token.revokedAt ??= at;
    return Promise.resolve(true);
  }

  touchToken(id: string, at: Date): Promise<void> {
    const token = this.#tokens.get(id);
    if (token !== undefined) token.lastUsedAt = at;
    return Promise.resolve();
  }

  recordActivity(record: McpActivityRecord): Promise<void> {
    this.#activity.push(record);
    return Promise.resolve();
  }

  listActivity(userId: string, limit: number): Promise<McpActivityRecord[]> {
    return Promise.resolve(
      this.#activity
        .filter((entry) => entry.userId === userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit),
    );
  }
}

export class PrismaMcpAccessStore implements McpAccessStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async createToken(record: McpTokenRecord): Promise<void> {
    await this.#prisma.mcpAccessToken.create({ data: record });
  }

  async findTokenByHash(tokenHash: string): Promise<McpTokenRecord | undefined> {
    return (await this.#prisma.mcpAccessToken.findUnique({ where: { tokenHash } })) ?? undefined;
  }

  listTokens(userId: string): Promise<McpTokenRecord[]> {
    return this.#prisma.mcpAccessToken.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  async revokeToken(userId: string, id: string, at: Date): Promise<boolean> {
    const found = await this.#prisma.mcpAccessToken.findFirst({ where: { id, userId } });
    if (found === null) return false;
    if (found.revokedAt === null) {
      await this.#prisma.mcpAccessToken.update({ where: { id }, data: { revokedAt: at } });
    }
    return true;
  }

  async touchToken(id: string, at: Date): Promise<void> {
    await this.#prisma.mcpAccessToken.update({ where: { id }, data: { lastUsedAt: at } });
  }

  async recordActivity(record: McpActivityRecord): Promise<void> {
    await this.#prisma.mcpActivity.create({ data: record });
  }

  async listActivity(userId: string, limit: number): Promise<McpActivityRecord[]> {
    const rows = await this.#prisma.mcpActivity.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((row) => ({ ...row, outcome: row.outcome as McpActivityRecord["outcome"] }));
  }
}

/** The NEXUS services a tool may call. Each one is already scoped to `userId`. */
export interface McpBackend {
  listMissions(userId: string, limit: number): Promise<unknown>;
  triggerMission(userId: string, goal: string): Promise<unknown>;
  listDevices(userId: string): Promise<unknown>;
  usageMetrics(userId: string, days: number): Promise<unknown>;
}

export class McpToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export const MCP_TOKEN_MAX_DAYS = 365;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

export class McpGateway {
  readonly #store: McpAccessStore;
  readonly #backend: McpBackend;
  readonly #now: () => Date;

  constructor(options: { store: McpAccessStore; backend: McpBackend; now?: () => Date }) {
    this.#store = options.store;
    this.#backend = options.backend;
    this.#now = options.now ?? (() => new Date());
  }

  async issueToken(
    userId: string,
    input: { name: string; scopes: McpScope[]; expiresInDays: number },
  ): Promise<{ token: string; record: McpTokenRecord }> {
    const token = `nxm_${randomBytes(32).toString("base64url")}`;
    const now = this.#now();
    const record: McpTokenRecord = {
      id: randomUUID(),
      userId,
      name: input.name,
      scopes: [...new Set(input.scopes)],
      tokenHash: hashToken(token),
      createdAt: now,
      expiresAt: new Date(now.getTime() + input.expiresInDays * 86_400_000),
      revokedAt: null,
      lastUsedAt: null,
    };
    await this.#store.createToken(record);
    return { token, record };
  }

  listTokens(userId: string): Promise<McpTokenRecord[]> {
    return this.#store.listTokens(userId);
  }

  revokeToken(userId: string, id: string): Promise<boolean> {
    return this.#store.revokeToken(userId, id, this.#now());
  }

  listActivity(userId: string, limit: number): Promise<McpActivityRecord[]> {
    return this.#store.listActivity(userId, limit);
  }

  /** Undefined for an unknown, revoked or expired token: callers cannot tell which. */
  async authenticate(token: string): Promise<McpTokenRecord | undefined> {
    const record = await this.#store.findTokenByHash(hashToken(token));
    const now = this.#now();
    if (record?.revokedAt !== null || record.expiresAt <= now) {
      return undefined;
    }
    await this.#store.touchToken(record.id, now);
    return record;
  }

  listTools(token: McpTokenRecord): readonly McpServerToolDefinition[] {
    return NEXUS_EXPOSED_MCP_TOOLS.filter((tool) => token.scopes.includes(tool.requiredScope));
  }

  async callTool(
    token: McpTokenRecord,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const startedAt = this.#now().getTime();
    const finish = async (
      outcome: McpActivityRecord["outcome"],
      errorCode: string | null,
      result: McpToolResult,
    ): Promise<McpToolResult> => {
      await this.#store.recordActivity({
        id: randomUUID(),
        tokenId: token.id,
        userId: token.userId,
        tool: name,
        outcome,
        errorCode,
        durationMs: this.#now().getTime() - startedAt,
        createdAt: this.#now(),
      });
      return result;
    };
    const failure = (code: string, message: string): McpToolResult => ({
      content: [{ type: "text", text: JSON.stringify({ code, message }) }],
      isError: true,
    });

    const tool = NEXUS_EXPOSED_MCP_TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      return finish("error", "UNKNOWN_TOOL", failure("UNKNOWN_TOOL", `Unknown tool: ${name}`));
    }
    if (!token.scopes.includes(tool.requiredScope)) {
      return finish(
        "denied",
        "INSUFFICIENT_SCOPE",
        failure("INSUFFICIENT_SCOPE", `This token lacks the ${tool.requiredScope} scope.`),
      );
    }
    try {
      const data = await this.#dispatch(token.userId, name, args);
      return await finish("success", null, {
        content: [{ type: "text", text: JSON.stringify(data) }],
      });
    } catch (cause) {
      const code = cause instanceof McpToolError ? cause.code : "NEXUS_SERVICE_UNAVAILABLE";
      // An unexpected internal message may carry details an external client must not see.
      const message =
        cause instanceof McpToolError ? cause.message : "The NEXUS service could not answer.";
      return finish("error", code, failure(code, message));
    }
  }

  #dispatch(userId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "nexus_list_missions":
        return this.#backend.listMissions(userId, positiveInt(args.limit, 10, 100));
      case "nexus_trigger_mission": {
        const goal = typeof args.goal === "string" ? args.goal.trim() : "";
        if (goal.length === 0 || goal.length > 32_000) {
          throw new McpToolError("INVALID_ARGUMENTS", "goal must be 1 to 32000 characters.");
        }
        return this.#backend.triggerMission(userId, goal);
      }
      case "nexus_list_devices":
        return this.#backend.listDevices(userId);
      case "nexus_get_usage_metrics":
        return this.#backend.usageMetrics(userId, positiveInt(args.days, 30, 366));
      default:
        throw new McpToolError("UNKNOWN_TOOL", `Unknown tool: ${name}`);
    }
  }
}
