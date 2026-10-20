import type { PrismaClient } from "@nexus/database";
import { uuidv7 } from "@nexus/shared";
import type { AgentRunClaim, AgentRunClaimStore } from "../agent-run-claims.js";

/** Code Prisma d'une violation de contrainte d'unicité. */
const UNIQUE_VIOLATION = "P2002";

export class PrismaAgentRunClaimStore implements AgentRunClaimStore {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  /**
   * Réserve en **insérant**, et traite le refus de la base comme la réponse.
   *
   * Lire puis insérer serait plus lisible et faux : entre les deux, une seconde
   * requête passe, et les deux workers croient détenir la réservation. Ici
   * c'est l'index unique qui tranche, donc exactement un appelant gagne, quel
   * que soit l'entrelacement.
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
        // La réservation a disparu entre le refus et la relecture. Rien ne la
        // supprime aujourd'hui, donc ce chemin signale un comportement qu'on
        // ne comprend pas : mieux vaut échouer que réserver en double.
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
