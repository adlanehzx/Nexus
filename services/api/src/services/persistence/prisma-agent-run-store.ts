import type { PrismaClient } from "@nexus/database";
import type { AgentState, RunUsageBucket } from "@nexus/agent-core";
import { NotFoundError } from "@nexus/shared";
import type { QueryableAgentRunStore } from "../container.js";

export class PrismaAgentRunStore implements QueryableAgentRunStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async save(state: AgentState): Promise<void> {
    await this.#prisma.agentRunSnapshot.upsert({
      where: { id: state.record.runId },
      create: {
        id: state.record.runId,
        userId: state.record.userId,
        status: state.record.status,
        startTime: new Date(state.record.startTime),
        state: state as never,
        missionExternalKey: state.record.missionExternalKey,
      },
      update: {
        status: state.record.status,
        state: state as never,
      },
    });
  }

  async load(runId: string): Promise<AgentState | undefined> {
    const row = await this.#prisma.agentRunSnapshot.findUnique({ where: { id: runId } });
    return row === null ? undefined : (row.state as unknown as AgentState);
  }

  async require(runId: string): Promise<AgentState> {
    const state = await this.load(runId);
    if (state === undefined) {
      throw new NotFoundError({
        message: `Run inconnu : ${runId}`,
        userMessage: "This task no longer exists.",
        context: { runId },
      });
    }
    return state;
  }

  async listByStatus(status: AgentState["record"]["status"]): Promise<AgentState[]> {
    const rows = await this.#prisma.agentRunSnapshot.findMany({
      where: { status },
      orderBy: { startTime: "desc" },
    });
    return rows.map((row) => row.state as unknown as AgentState);
  }

  async listForUser(
    userId: string,
    since: Date,
    offset: number,
    limit: number,
  ): Promise<AgentState[]> {
    const rows = await this.#prisma.agentRunSnapshot.findMany({
      where: { userId, startTime: { gte: since } },
      orderBy: [{ startTime: "desc" }, { id: "desc" }],
      skip: offset,
      take: limit,
    });
    return rows.map((row) => row.state as unknown as AgentState);
  }

  /** Aggregated in SQL: a year of runs must not be loaded to draw one chart. */
  async summarizeForUser(userId: string, since: Date): Promise<RunUsageBucket[]> {
    const rows = await this.#prisma.$queryRaw<
      {
        day: string;
        model: string;
        runs: number;
        failedRuns: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number | null;
        cacheWriteTokens: number | null;
      }[]
    >`
      SELECT to_char("startTime" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
             COALESCE(state #>> '{record,model}', '') AS model,
             COUNT(*)::float8 AS "runs",
             (COUNT(*) FILTER (WHERE status = 'failed'))::float8 AS "failedRuns",
             COALESCE(SUM((state #>> '{record,usage,inputTokens}')::float8), 0)::float8 AS "inputTokens",
             COALESCE(SUM((state #>> '{record,usage,outputTokens}')::float8), 0)::float8 AS "outputTokens",
             SUM((state #>> '{record,usage,cacheReadTokens}')::float8)::float8 AS "cacheReadTokens",
             SUM((state #>> '{record,usage,cacheWriteTokens}')::float8)::float8 AS "cacheWriteTokens"
        FROM agent_run_snapshots
       WHERE "userId" = ${userId}::uuid AND "startTime" >= ${since}
       GROUP BY 1, 2
       ORDER BY 1, 2`;
    return rows;
  }

  async listAll(): Promise<AgentState[]> {
    const rows = await this.#prisma.agentRunSnapshot.findMany({
      orderBy: { startTime: "desc" },
    });
    return rows.map((row) => row.state as unknown as AgentState);
  }
}
