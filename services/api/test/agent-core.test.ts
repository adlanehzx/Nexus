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
    const llm = new ScriptedLLMProvider(
      responses.map((text) => ({ kind: "final" as const, text })),
    );
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

/**
 * Lecture d'un run par le moteur.
 *
 * C'est la moitié « le moteur interroge » de la suspension durable. Le risque
 * propre à cette route n'est pas la lecture mais sa portée : une assertion ne
 * doit ouvrir que les runs de sa mission, et surtout pas ceux que le
 * propriétaire a lancés depuis ses conversations privées.
 */
describe("lecture d'un run de mission", () => {
  let harness: ApiHarness | undefined;

  afterEach(async () => harness?.close());

  const MISSION = "nexus-mission-lecture";

  async function setup() {
    const llm = new ScriptedLLMProvider([{ kind: "final", text: "Fait." }]);
    harness = await makeApi({ llmProvider: llm });
    const account = await createAccount(harness);
    const grant = harness.services.tokens.issueMissionGrant({
      userId: account.userId,
      service: "mission-engine",
      missionExternalKey: MISSION,
    });
    return { account, grant, api: harness };
  }

  it("relit le run qu'elle a lancé, dans sa mission", async () => {
    const { grant, api } = await setup();
    const started = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: { missionExternalKey: MISSION, taskKey: "t", instruction: "Agis" },
    });
    const runId = started.json<{ data: { runId: string } }>().data.runId;

    const reread = await api.app.inject({
      method: "GET",
      url: `/api/v1/agent-core/mission-runs/${runId}`,
      headers: { authorization: `Bearer ${grant.token}` },
    });

    expect(reread.statusCode).toBe(200);
    expect(reread.json<{ data: { runId: string } }>().data.runId).toBe(runId);
  });

  it("refuse de relire un run lancé par une personne", async () => {
    const { account, grant, api } = await setup();
    const created = await api.app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers: account.authorization,
      payload: { title: "Conversation privée" },
    });
    const conversationId = created.json<{ data: { id: string } }>().data.id;
    const personal = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/runs",
      headers: account.authorization,
      payload: { conversationId, message: "Travaille" },
    });
    const runId = personal.json<{ data: { runId: string } }>().data.runId;

    const attempted = await api.app.inject({
      method: "GET",
      url: `/api/v1/agent-core/mission-runs/${runId}`,
      headers: { authorization: `Bearer ${grant.token}` },
    });

    // Même propriétaire, même signature valide — mais ce run n'appartient à
    // aucune mission. Sans ce refus, une assertion lirait les conversations
    // privées du compte.
    expect(attempted.statusCode).toBe(403);
  });

  it("refuse une assertion émise pour une autre mission", async () => {
    const { account, grant, api } = await setup();
    const started = await api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${grant.token}` },
      payload: { missionExternalKey: MISSION, taskKey: "t", instruction: "Agis" },
    });
    const runId = started.json<{ data: { runId: string } }>().data.runId;

    const other = api.services.tokens.issueMissionGrant({
      userId: account.userId,
      service: "mission-engine",
      missionExternalKey: "nexus-mission-voisine",
    });
    const attempted = await api.app.inject({
      method: "GET",
      url: `/api/v1/agent-core/mission-runs/${runId}`,
      headers: { authorization: `Bearer ${other.token}` },
    });

    expect(attempted.statusCode).toBe(403);
  });
});

/**
 * Unicité d'un run par tentative.
 *
 * Le risque est concret : un run Agent Core dure facilement plus longtemps
 * qu'un bail de trente secondes. Quand le bail expire pendant l'appel, un
 * second worker reprend la tâche et redemande un run. Sans réservation, le
 * modèle est rappelé et les outils rejouent leurs effets — un message envoyé
 * deux fois, un fichier écrit deux fois.
 *
 * La granularité est la tentative, et c'est ce que ces tests fixent : deux
 * workers sur la même tentative convergent, un vrai réessai obtient un run neuf.
 */
describe("unicité d'un run de mission", () => {
  let harness: ApiHarness | undefined;

  afterEach(async () => harness?.close());

  const MISSION = "nexus-mission-unicite";

  async function setup(responses: string[]) {
    const llm = new ScriptedLLMProvider(
      responses.map((text) => ({ kind: "final" as const, text })),
    );
    harness = await makeApi({ llmProvider: llm });
    const account = await createAccount(harness);
    const grant = harness.services.tokens.issueMissionGrant({
      userId: account.userId,
      service: "mission-engine",
      missionExternalKey: MISSION,
    });
    return { account, grant, api: harness, llm };
  }

  const request = (api: ApiHarness, token: string, payload: Record<string, unknown>) =>
    api.app.inject({
      method: "POST",
      url: "/api/v1/agent-core/mission-runs",
      headers: { authorization: `Bearer ${token}` },
      payload: { missionExternalKey: MISSION, taskKey: "deleguee", ...payload },
    });

  it("rend le même run pour une tentative redemandée, sans rappeler le modèle", async () => {
    const { grant, api, llm } = await setup(["Travail unique."]);

    const first = await request(api, grant.token, {
      instruction: "Range mes mails",
      attemptId: "attempt-1",
    });
    const second = await request(api, grant.token, {
      instruction: "Range mes mails",
      attemptId: "attempt-1",
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstRun = first.json<{ data: { runId: string } }>().data.runId;
    const secondRun = second.json<{ data: { runId: string } }>().data.runId;
    expect(secondRun).toBe(firstRun);

    // Le point qui compte vraiment : un seul appel au modèle. Un second aurait
    // rejoué les outils du run, et coûté des jetons pour un travail déjà fait.
    expect(llm.requests).toHaveLength(1);
  });

  it("lance un run neuf pour une tentative différente", async () => {
    const { grant, api, llm } = await setup(["Premier essai.", "Second essai."]);

    const first = await request(api, grant.token, {
      instruction: "Range mes mails",
      attemptId: "attempt-1",
    });
    const second = await request(api, grant.token, {
      instruction: "Range mes mails",
      attemptId: "attempt-2",
    });

    const firstRun = first.json<{ data: { runId: string } }>().data.runId;
    const secondRun = second.json<{ data: { runId: string } }>().data.runId;
    // Un réessai après échec est un travail neuf : le confondre avec un doublon
    // bloquerait la tâche sur son premier résultat.
    expect(secondRun).not.toBe(firstRun);
    expect(llm.requests).toHaveLength(2);
  });

  it("réserve le run sous l'identifiant qu'il portera vraiment", async () => {
    const { grant, api } = await setup(["Travail unique."]);

    const response = await request(api, grant.token, {
      instruction: "Range mes mails",
      attemptId: "attempt-1",
    });
    const runId = response.json<{ data: { runId: string } }>().data.runId;

    const claim = await api.services.agentRunClaims.find({
      missionExternalKey: MISSION,
      taskKey: "deleguee",
      attemptId: "attempt-1",
    });
    // Si la réservation désignait un autre identifiant, elle ne protégerait
    // rien : la seconde requête rendrait un run introuvable.
    expect(claim?.runId).toBe(runId);
  });

  it("isole les réservations par tâche et par mission", async () => {
    const { account, grant, api, llm } = await setup(["A.", "B."]);

    await request(api, grant.token, {
      instruction: "Tâche A",
      taskKey: "tache-a",
      attemptId: "attempt-1",
    });
    await request(api, grant.token, {
      instruction: "Tâche B",
      taskKey: "tache-b",
      attemptId: "attempt-1",
    });

    // Même identifiant de tentative, mais deux tâches : la clé est composite,
    // donc ce sont deux réservations distinctes.
    expect(llm.requests).toHaveLength(2);
    expect(account.userId).toBeDefined();
  });

  it("n'exige pas de tentative, mais ne garantit alors plus rien", async () => {
    const { grant, api, llm } = await setup(["Sans tentative.", "Encore."]);

    const first = await request(api, grant.token, { instruction: "Range mes mails" });
    const second = await request(api, grant.token, { instruction: "Range mes mails" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Documenté plutôt que corrigé : un appelant qui n'envoie pas de tentative
    // ne peut pas être protégé, et le prétendre serait pire.
    expect(second.json<{ data: { runId: string } }>().data.runId).not.toBe(
      first.json<{ data: { runId: string } }>().data.runId,
    );
    expect(llm.requests).toHaveLength(2);
  });
});
