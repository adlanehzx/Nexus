import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const PG_CONTAINER = process.env.NEXUS_E2E_PG_CONTAINER ?? "nexus-integration-pg";

/** Runs SQL inside the disposable database container of `scripts/e2e-stack.sh`. */
export function sql(statement: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", PG_CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-tA"],
    { input: statement, encoding: "utf8" },
  ).trim();
}

export function promoteToAdmin(userId: string): void {
  sql(`UPDATE users SET role = 'ADMIN' WHERE id = '${userId}';`);
}

/**
 * Inserts a finished run with the same persisted shape Agent Core saves.
 *
 * No model provider is available to E2E, so the row is a labelled fixture: this
 * proves database → API → screen, not that a provider reported these counters.
 */
export function seedRun(
  userId: string,
  run: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number },
): string {
  const runId = randomUUID();
  const startTime = new Date().toISOString();
  const state = {
    record: {
      runId,
      userId,
      conversationId: randomUUID(),
      correlationId: randomUUID(),
      startTime,
      endTime: startTime,
      status: "completed",
      stopReason: "end_turn",
      iterations: 1,
      toolsUsed: [],
      errors: [],
      usage: {
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        ...(run.cacheReadTokens === undefined ? {} : { cacheReadTokens: run.cacheReadTokens }),
      },
      model: run.model,
      response: "PRIVATE-RESPONSE-TEXT",
      missionExternalKey: null,
    },
  };
  const json = JSON.stringify(state).replaceAll("'", "''");
  sql(
    `INSERT INTO agent_run_snapshots (id, "userId", status, "startTime", state, "updatedAt")
     VALUES ('${runId}', '${userId}', 'completed', '${startTime}', '${json}'::jsonb, now());`,
  );
  return runId;
}
