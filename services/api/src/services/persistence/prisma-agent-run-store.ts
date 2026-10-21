import type { PrismaClient } from "@nexus/database";
import type { AgentState } from "@nexus/agent-core";
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

  async listAll(): Promise<AgentState[]> {
    const rows = await this.#prisma.agentRunSnapshot.findMany({
      orderBy: { startTime: "desc" },
    });
    return rows.map((row) => row.state as unknown as AgentState);
  }
}
