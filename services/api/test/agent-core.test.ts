import { randomUUID } from "node:crypto";
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

/**
 * Pont Mission Engine → Agent Core.
 *
 * La surface est ouverte à un service, pas à une personne. Ce qui est testé en
 * priorité, c'est donc ce qu'elle refuse : un jeton d'utilisateur ordinaire, une
 * assertion hors de sa portée, et une conversation qui n'appartient pas au
 * propriétaire de la mission.
 */
describe("pont Mission Engine vers Agent Core", () => {
  let harness: ApiHarness | undefined;

  afterEach(async () => harness?.close());

  const MISSION = "nexus-mission-sous-test";

  async function setup(responses = ["Travail délégué effectué."]) {
    const llm = new ScriptedLLMProvider(responses.map((text) => ({ kind: "final" as const, text })));
    harness = await makeApi({ llmProvider: llm });
    const account = await createAccount(harness);
    const grant = harness.services.tokens.issueMissionGrant({
      userId: account.userId,
      service: "mission-engine",
      missionExternalKey: MISSION,
    });
    return { account, grant, harness: harness };
  }

  it("exécute un run pour le compte du propriétaire et ouvre une conversation", async () => {
    const { account, grant, harness: api } = await setup();

    const executed = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: {
        missionExternalKey: MISSION,
        taskKey: "deleguee",
        instruction: "Range mes mails",
      },
    });

    expect(executed.statusCode).toBe(200);
    const body = executed.json<{ data: { conversationId: string; response: string } }>();
    expect(body.data.response).toBe("Travail délégué effectué.");

    // La conversation appartient à l'utilisateur, pas au service : c'est ce qui
    // rend le travail de la mission visible dans son tableau de bord.
    const conversation = await api.services.conversations.get(body.data.conversationId);
    expect(conversation?.userId).toBe(account.userId);
  });

  it("prolonge la conversation rendue au lieu d'en ouvrir une seconde", async () => {
    const { grant, harness: api } = await setup(["Premier essai.", "Second essai."]);

    const first = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: { missionExternalKey: MISSION, taskKey: "deleguee", instruction: "Essaie" },
    });
    const conversationId = first.json<{ data: { conversationId: string } }>().data.conversationId;

    const second = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: {
        missionExternalKey: MISSION,
        taskKey: "deleguee",
        instruction: "Réessaie",
        conversationId,
      },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json<{ data: { conversationId: string } }>().data.conversationId).toBe(
      conversationId,
    );
    const transcript = await api.services.conversations.listMessages(conversationId, { limit: 10 });
    expect(transcript.items).toHaveLength(4);
  });

  it("refuse une assertion utilisée pour une autre mission", async () => {
    const { grant, harness: api } = await setup();

    const executed = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: {
        missionExternalKey: "nexus-une-autre-mission",
        taskKey: "deleguee",
        instruction: "Range mes mails",
      },
    });

    // Signature valide, propriétaire valide — mais hors portée. Sans ce refus,
    // une assertion suffirait à piloter toutes les missions du compte.
    expect(executed.statusCode).toBe(403);
  });

  it("refuse un jeton d'accès utilisateur sur la surface de service", async () => {
    const { account, harness: api } = await setup();

    const executed = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: account.authorization,
      payload: {
        missionExternalKey: MISSION,
        taskKey: "deleguee",
        instruction: "Range mes mails",
      },
    });

    expect(executed.statusCode).toBe(401);
  });

  it("refuse une assertion sur la surface utilisateur", async () => {
    const { grant, harness: api } = await setup();

    const executed = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/runs",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: { conversationId: randomUUID(), message: "Range mes mails" },
    });

    expect(executed.statusCode).toBe(401);
  });

  it("refuse de travailler dans la conversation d'un autre compte", async () => {
    const { grant, harness: api } = await setup();
    const other = await createAccount(api, "autre@exemple.fr");
    const foreign = await api.services.conversations.create({
      userId: other.userId,
      title: "Conversation d'un autre",
    });

    const executed = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: {
        missionExternalKey: MISSION,
        taskKey: "deleguee",
        instruction: "Range mes mails",
        conversationId: foreign.id,
      },
    });

    // L'identifiant vient du corps de la requête : la signature prouve le
    // propriétaire, elle ne dit rien de cette conversation-là.
    expect(executed.statusCode).toBe(403);
  });
});
