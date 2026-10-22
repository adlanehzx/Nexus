import type { PrismaClient } from "@nexus/database";
import { uuidv7 } from "@nexus/shared";
import type { AgentRunClaim, AgentRunClaimStore } from "../agent-run-claims.js";

/** Prisma code for a unique constraint violation. */
const UNIQUE_VIOLATION = "P2002";

export class PrismaAgentRunClaimStore implements AgentRunClaimStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  /**
   * Claims by **inserting**, and treats database rejection as the answer.
   *
   * Reading then inserting would be cleaner to read but incorrect: between the two, a second
   * request slips in, and both workers believe they hold the reservation. Here
   * the unique index decides, so exactly one caller wins, regardless of
   * concurrency interleaving.
   */
  async claim(
    input: Omit<AgentRunClaim, "createdAt">,
  ): Promise<{ claimed: true } | { claimed: false; existing: AgentRunClaim }> {
    try {
      await this.#prisma.agentCoreRunClaim.create({
        data: {
          id: uuidv7(),
          missionExternalKey: input.missionExternalKey,
          taskKey: input.taskKey,
          attemptId: input.attemptId,
          runId: input.runId,
          userId: input.userId,
        },
      });
      return { claimed: true };
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;

      const existing = await this.find(input);
      if (existing === undefined) {
        // The claim disappeared between the rejection and the re-read. Nothing
        // deletes it today, so this path signals unexpected behavior:
        // failing is safer than claiming twice.
        throw error;
      }
      return { claimed: false, existing };
    }
  }

  async find(key: {
    missionExternalKey: string;
    taskKey: string;
    attemptId: string;
  }): Promise<AgentRunClaim | undefined> {
    const row = await this.#prisma.agentCoreRunClaim.findUnique({
      where: {
        missionExternalKey_taskKey_attemptId: {
          missionExternalKey: key.missionExternalKey,
          taskKey: key.taskKey,
          attemptId: key.attemptId,
        },
      },
    });
    if (row === null) return undefined;
    return {
      missionExternalKey: row.missionExternalKey,
      taskKey: row.taskKey,
      attemptId: row.attemptId,
      runId: row.runId,
      userId: row.userId,
      createdAt: row.createdAt,
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
