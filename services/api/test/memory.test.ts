import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccount, makeApi, type Account, type ApiHarness } from "./harness.js";

/**
 * La mémoire, à travers l'API.
 *
 * Ce fichier éprouve ce que les tests du paquet `@nexus/memory` ne peuvent pas
 * voir : que le service est bien **le seul chemin**. Une route qui appellerait
 * le magasin directement contournerait la règle du silence sans qu'aucun test
 * unitaire ne s'en aperçoive.
 *
 * Et la frontière entre utilisateurs, éprouvée ici avec deux vrais comptes et
 * deux vrais jetons.
 */

let harness: ApiHarness;
let example: Account;
let autre: Account;

beforeEach(async () => {
  harness = await makeApi();
  example = await createAccount(harness, "alex@example.test");
  autre = await createAccount(harness, "autre@exemple.fr");
});

afterEach(async () => {
  await harness.close();
});

function store(account: Account, payload: Record<string, unknown>) {
  return harness.app.inject({
    method: "POST",
    url: "/api/v1/memory",
    headers: account.authorization,
    payload,
  });
}

async function storeOk(account: Account, content: string, extra: Record<string, unknown> = {}) {
  const response = await store(account, { content, ...extra });
  return response.json<{ data: { id: string; content: string } }>().data;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("store", () => {
  it("enregistre un souvenir", async () => {
    const response = await store(example, { content: "Alex préfère le train" });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ data: { content: string } }>().data.content).toBe(
      "Alex préfère le train",
    );
  });

  it("distingue une préférence d'un souvenir", async () => {
    await storeOk(example, "Réponds toujours en français", { layer: "PREFERENCE" });
    await storeOk(example, "Habite à Lyon");

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/memory?layer=PREFERENCE",
      headers: example.authorization,
    });

    const data = response.json<{ data: { content: string }[] }>().data;
    expect(data.map((record) => record.content)).toEqual(["Réponds toujours en français"]);
  });

  it("refuse un secret, et le dit", async () => {
    // La route ne doit pas pouvoir court-circuiter le service : si elle
    // appelait le magasin directement, ce test passerait en 201.
    const response = await store(example, { content: "Mon mot de passe est Tr0ub4dor3xy" });

    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("MEMORY_SENSITIVE_REFUSED");
    expect(body.error.message).toContain("password manager");
  });

  it("le refus ne renvoie pas le secret", async () => {
    const response = await store(example, { content: "Ma clé API est sk-abcdefghijklmnopqrstuv" });

    expect(response.body).not.toContain("sk-abcdefghijklmnopqrstuv");
  });

  it("exige un accord pour une information personnelle", async () => {
    const response = await store(example, { content: "J'ai été diagnostiqué diabétique" });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("MEMORY_CONSENT_REQUIRED");
  });

  it("accepte une fois l'accord donné, et le conserve", async () => {
    const response = await store(example, {
      content: "J'ai été diagnostiqué diabétique",
      acknowledgedSensitive: true,
    });

    expect(response.statusCode).toBe(201);
    const data = response.json<{ data: { sensitivity: string; sensitiveCategories: string[] } }>()
      .data;
    expect(data.sensitivity).toBe("PERSONAL");
    expect(data.sensitiveCategories).toContain("sante");
  });

  it("l'accord n'est jamais implicite", async () => {
    // Le schéma déclare `acknowledgedSensitive` avec un défaut à `false`. Ne
    // rien envoyer doit donc valoir « non », pas « oui ».
    const response = await store(example, { content: "Mon IBAN figure sur le relevé" });

    expect(response.statusCode).toBe(409);
  });
});

describe("search", () => {
  it("trouve un souvenir par mot-clé", async () => {
    await storeOk(example, "Alex préfère le train");
    await storeOk(example, "Alex aime le café serré");

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/memory/search?q=train",
      headers: example.authorization,
    });

    const hits = response.json<{ data: { hits: { content: string }[] } }>().data.hits;
    expect(hits.map((hit) => hit.content)).toEqual(["Alex préfère le train"]);
  });

  it("ne trouve rien chez quelqu'un d'autre", async () => {
    await storeOk(autre, "Le secret de l'autre utilisateur");

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/v1/memory/search?q=secret",
      headers: example.authorization,
    });

    expect(response.json<{ data: { hits: unknown[] } }>().data.hits).toEqual([]);
  });
});

describe("update", () => {
  it("corriger supersède au lieu d'écraser", async () => {
    const record = await storeOk(example, "Habite à Lyon");

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/v1/memory/${record.id}`,
      headers: example.authorization,
      payload: { content: "Habite à Paris" },
    });

    expect(response.statusCode).toBe(200);
    const data = response.json<{ data: { id: string; supersedesId: string | null } }>().data;
    expect(data.supersedesId).toBe(record.id);
    expect(data.id).not.toBe(record.id);
  });

  it("reclasse le contenu révisé", async () => {
    // Ne contrôler qu'à la création laisserait la modification comme porte
    // ouverte.
    const record = await storeOk(example, "Une note anodine");

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/v1/memory/${record.id}`,
      headers: example.authorization,
      payload: { content: "Mon mot de passe est Tr0ub4dor3xy" },
    });

    expect(response.statusCode).toBe(422);
  });

  it("ne corrige pas le souvenir de quelqu'un d'autre", async () => {
    const record = await storeOk(autre, "Souvenir de l'autre");

    const response = await harness.app.inject({
      method: "PATCH",
      url: `/api/v1/memory/${record.id}`,
      headers: example.authorization,
      payload: { content: "détourné" },
    });

    // 404, pas 403 : distinguer « inconnu » de « pas à vous » indiquerait à un
    // curieux quels identifiants existent.
    expect(response.statusCode).toBe(404);
  });
});

describe("delete", () => {
  it("oublie un souvenir et rend ce qui a disparu", async () => {
    const record = await storeOk(example, "Habite à Lyon");

    const response = await harness.app.inject({
      method: "DELETE",
      url: `/api/v1/memory/${record.id}`,
      headers: example.authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ data: { forgotten: { content: string }[] } }>().data.forgotten[0]?.content,
    ).toBe("Habite à Lyon");
  });

  it("n'oublie pas le souvenir de quelqu'un d'autre", async () => {
    const record = await storeOk(autre, "Souvenir de l'autre");

    const response = await harness.app.inject({
      method: "DELETE",
      url: `/api/v1/memory/${record.id}`,
      headers: example.authorization,
    });

    expect(response.statusCode).toBe(404);

    // Et il est toujours là pour son propriétaire.
    const reste = await harness.app.inject({
      method: "GET",
      url: "/api/v1/memory",
      headers: autre.authorization,
    });
    expect(reste.json<{ data: unknown[] }>().data).toHaveLength(1);
  });
});

describe("forget", () => {
  it("oublie par correspondance de texte", async () => {
    await storeOk(example, "Habite à Lyon");
    await storeOk(example, "Préfère le café serré");

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      headers: example.authorization,
      payload: { match: "habite lyon" },
    });

    expect(response.json<{ data: { forgotten: unknown[] } }>().data.forgotten).toHaveLength(1);
  });

  it("rend les candidats plutôt que de deviner", async () => {
    await storeOk(example, "Réunion équipe le lundi");
    await storeOk(example, "Réunion équipe le mardi");

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      headers: example.authorization,
      payload: { match: "réunion équipe" },
    });

    const data = response.json<{ data: { forgotten: unknown[]; ambiguous: unknown[] } }>().data;
    expect(data.forgotten).toEqual([]);
    expect(data.ambiguous).toHaveLength(2);
  });

  it("exige une confirmation pour tout effacer", async () => {
    await storeOk(example, "Un souvenir");

    const sans = await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      headers: example.authorization,
      payload: { all: true },
    });
    expect(sans.json<{ data: { needsConfirmation: boolean } }>().data.needsConfirmation).toBe(true);

    const avec = await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      headers: example.authorization,
      payload: { all: true, confirmed: true },
    });
    expect(avec.json<{ data: { forgotten: unknown[] } }>().data.forgotten).toHaveLength(1);
  });

  it("« tout » veut dire « tout le mien »", async () => {
    await storeOk(example, "Souvenir d'Alex");
    await storeOk(autre, "Souvenir de l'autre");

    await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/forget",
      headers: example.authorization,
      payload: { all: true, confirmed: true },
    });

    const reste = await harness.app.inject({
      method: "GET",
      url: "/api/v1/memory",
      headers: autre.authorization,
    });
    expect(reste.json<{ data: unknown[] }>().data).toHaveLength(1);
  });
});

describe("commandes explicites", () => {
  it("exécute « retiens que… »", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/command",
      headers: example.authorization,
      payload: { text: "Retiens que je préfère le train" },
    });

    const data = response.json<{
      data: { recognized: boolean; kind: string; stored: { content: string } | null };
    }>().data;

    expect(data.recognized).toBe(true);
    expect(data.kind).toBe("remember");
    expect(data.stored?.content).toBe("je préfère le train");
  });

  it("exécute « oublie… »", async () => {
    await storeOk(example, "j'habite à Lyon");

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/command",
      headers: example.authorization,
      payload: { text: "Oublie que j'habite à Lyon" },
    });

    expect(response.json<{ data: { forgotten: unknown[] } }>().data.forgotten).toHaveLength(1);
  });

  it("une commande dictée subit la même classification", async () => {
    // Le chemin ne change pas la règle : l'utilisateur qui dicte son mot de
    // passe se le voit refuser comme s'il l'avait saisi dans l'écran de gestion.
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/command",
      headers: example.authorization,
      payload: { text: "Retiens que mon mot de passe est Tr0ub4dor3xy" },
    });

    expect(response.statusCode).toBe(422);
  });

  it("ne reconnaît rien dans un message ordinaire", async () => {
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/memory/command",
      headers: example.authorization,
      payload: { text: "Quelle est la météo à Lyon ?" },
    });

    expect(response.json<{ data: { recognized: boolean } }>().data.recognized).toBe(false);
  });
});

describe("frontière d'authentification", () => {
  it("refuse un appel sans jeton", async () => {
    // Les charges utiles sont **valides** : on veut mesurer l'authentification,
    // pas la validation. Fastify valide avant le `preHandler`, si bien qu'un
    // corps incomplet rendrait 400 et masquerait ce qu'on cherche a verifier.
    for (const [method, url, payload] of [
      ["GET", "/api/v1/memory", undefined],
      ["POST", "/api/v1/memory", { content: "quelque chose" }],
      ["POST", "/api/v1/memory/forget", { match: "quelque chose" }],
      ["POST", "/api/v1/memory/command", { text: "Retiens que X" }],
      ["GET", "/api/v1/memory/search?q=x", undefined],
    ] as const) {
      const response = await harness.app.inject({
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode).toBe(401);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("assemblage du contexte", () => {
  it("relie les six couches sans les mélanger", async () => {
    // Le test de bout en bout de la séparation : chaque couche vient de son
    // propriétaire réel — le magasin de mémoire, le contexte de session, le
    // magasin de conversations, le registre d'appareils, le magasin de plans.
    await storeOk(example, "Réponds toujours en français", { layer: "PREFERENCE" });
    await storeOk(example, "Habite à Lyon");

    const conversation = await harness.services.conversations.create({
      userId: example.userId,
      title: "Essai",
    });
    await harness.services.conversations.appendMessage({
      conversationId: conversation.id,
      role: "user",
      content: "Bonjour NEXUS",
      originClientDeviceId: null,
    });

    harness.services.shortTerm.set(conversation.id, "fichier-courant", "src/memory.ts");

    const assembled = await harness.services.context.assemble({
      userId: example.userId,
      conversationId: conversation.id,
      query: "où habite Alex",
    });

    expect(assembled.text).toContain("Réponds toujours en français");
    expect(assembled.text).toContain("Habite à Lyon");
    expect(assembled.text).toContain("src/memory.ts");
    expect(assembled.text).toContain("Bonjour NEXUS");

    // Et chaque chose est dans sa section.
    const preferences = assembled.sections.find((s) => s.name === "preferences");
    expect(preferences?.lines.join()).toContain("français");
    expect(preferences?.lines.join()).not.toContain("Lyon");
  });

  it("n'assemble jamais le contexte de quelqu'un d'autre", async () => {
    await storeOk(autre, "Le secret de l'autre utilisateur");

    const assembled = await harness.services.context.assemble({
      userId: example.userId,
      conversationId: "conv-inconnue",
      query: "secret",
    });

    expect(assembled.text).not.toContain("secret de l'autre");
  });

  it("ne lit pas la conversation d'un autre utilisateur", async () => {
    // L'identifiant de conversation vient du client. Sans la vérification de
    // propriété dans l'adaptateur, il suffirait d'en deviner un.
    const conversation = await harness.services.conversations.create({
      userId: autre.userId,
      title: "Privé",
    });
    await harness.services.conversations.appendMessage({
      conversationId: conversation.id,
      role: "user",
      content: "Message confidentiel",
      originClientDeviceId: null,
    });

    const assembled = await harness.services.context.assemble({
      userId: example.userId,
      conversationId: conversation.id,
      query: "quoi de neuf",
    });

    expect(assembled.text).not.toContain("Message confidentiel");
  });
});
