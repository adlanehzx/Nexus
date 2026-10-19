import { afterEach, describe, expect, it } from "vitest";
import { ScriptedLLMProvider } from "@nexus/llm/testing";
import { createAccount, makeApi, type ApiHarness } from "./harness.js";

describe("Agent Core HTTP", () => {
  let harness: ApiHarness | undefined;

  afterEach(async () => harness?.close());

  it("execute une reponse, persiste le run et le transcript", async () => {
    const llm = new ScriptedLLMProvider([
      { kind: "final", text: "Réponse effective d'Agent Core." },
    ]);
    harness = await makeApi({
      llmProvider: llm,
    });
    const account = await createAccount(harness);
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers: account.authorization,
      payload: { title: "Agent Core" },
    });
    const conversationId = created.json<{ data: { id: string } }>().data.id;

    const executed = await harness.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/runs",
      headers: account.authorization,
      payload: { conversationId, message: "Réponds maintenant" },
    });

    expect(executed.statusCode).toBe(200);
    const body = executed.json<{ data: { runId: string; status: string; response: string } }>();
    expect(body.data.status).toBe("completed");
    expect(body.data.response).toBe("Réponse effective d'Agent Core.");
    const occurrences = llm.requests[0]?.messages.filter(
      (message) =>
        message.role === "user" &&
        message.content.some(
          (block) => block.type === "text" && block.text === "Réponds maintenant",
        ),
    );
    expect(occurrences).toHaveLength(1);

    const loaded = await harness.app.inject({
      method: "GET",
      url: `/api/v1/agent-core/runs/${body.data.runId}`,
      headers: account.authorization,
    });
    expect(loaded.statusCode).toBe(200);

    const transcript = await harness.services.conversations.listMessages(conversationId, {
      limit: 10,
    });
    expect(transcript.items.map((message) => [message.role, message.content])).toEqual([
      ["user", "Réponds maintenant"],
      ["assistant", "Réponse effective d'Agent Core."],
    ]);
  });
});
