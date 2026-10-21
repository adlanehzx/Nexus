import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ScriptedLLMProvider } from "@nexus/llm/testing";
import { createAccount, makeApi, type ApiHarness } from "./harness.js";

const SOURCE_RUN_ID = "7a301a7c-77b1-47d0-9318-3b55dd7b4bed";

describe("rejeu d'analyse d'un run", () => {
  let harness: ApiHarness | undefined;

  afterEach(async () => {
    await harness?.close();
  });

  it("rejoue le prompt dans une nouvelle conversation sans exécuter les outils proposés", async () => {
    let executions = 0;
    const llm = new ScriptedLLMProvider([
      {
        kind: "tool_calls",
        calls: [{ id: "call-write", name: "danger.write", arguments: { value: "x" } }],
      },
    ]);
    harness = await makeApi({ llmProvider: llm });
    const admin = await createAccount(harness, "replay-admin@exemple.fr");
    harness.services.toolRegistry.register({
      name: "danger.write",
      description: "Outil à effet externe utilisé pour prouver l'isolation du rejeu.",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ written: z.boolean() }),
      riskLevel: "HIGH",
      requiredPermissions: [],
      requiresConfirmation: false,
      execute: () => {
        executions += 1;
        return Promise.resolve({ written: true });
      },
    });
    await harness.services.runStore.save({
      record: {
        runId: SOURCE_RUN_ID,
        userId: admin.userId,
        conversationId: "source-conversation",
        correlationId: "source-correlation",
        startTime: "2026-10-21T10:00:00.000Z",
        endTime: "2026-10-21T10:00:01.000Z",
        status: "completed",
        stopReason: "final_answer",
        iterations: 1,
        toolsUsed: [],
        errors: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "scripted-model",
        response: "Réponse source.",
        missionExternalKey: null,
        replayOfRunId: null,
        fallbackCount: 0,
      },
      messages: [{ role: "user", content: [{ type: "text", text: "Analyse ce problème." }] }],
      pendingConfirmation: null,
      consecutiveToolFailures: 0,
      toolCallCount: 0,
      callSignatures: [],
      deadlineAt: Date.now() + 60_000,
      suspendedAt: null,
    });

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/v1/dashboard/runs/${SOURCE_RUN_ID}/replay`,
      headers: admin.authorization,
      payload: { mode: "analysis_only" },
    });

    expect(response.statusCode).toBe(200);
    expect(executions).toBe(0);
    expect(
      response.json<{ data: { replayOfRunId: string; stopReason: string } }>().data,
    ).toMatchObject({ replayOfRunId: SOURCE_RUN_ID, stopReason: "max_tool_calls" });
    expect(llm.requests[0]?.tools?.map((tool) => tool.name)).toContain("danger.write");
  });
});
