import { describe, expect, it } from "vitest";
import { InMemoryMemoryProvider } from "../src/in-memory.js";

/**
 * Le magasin de souvenirs.
 *
 * Deux propriétés dominent ce fichier, et elles sont de nature différente :
 *
 *  - **la frontière entre utilisateurs**, qui est une garantie de sécurité et
 *    n'admet aucune exception ;
 *  - **la supersession**, qui est une décision de modélisation : corriger un
 *    fait ne l'efface pas, il le date.
 */

const ADLAN = "user-example";
const AUTRE = "user-autre";

function makeProvider(now = new Date("2026-09-03T10:00:00.000Z")) {
  let clock = now;
  return {
    provider: new InMemoryMemoryProvider({ now: () => clock }),
    // Propriété-fonction et non méthode : c'est une fermeture sur `clock`, elle
    // ne dépend d'aucun `this`, et les tests la déstructurent.
    advance: (days: number) => {
      clock = new Date(clock.getTime() + days * 86_400_000);
    },
  };
}

describe("store", () => {
  it("enregistre un souvenir avec ses valeurs par défaut", async () => {
    const { provider } = makeProvider();

    const record = await provider.store({
      userId: ADLAN,
      kind: "SEMANTIC",
      content: "Alex préfère le train à l'avion",
    });

    expect(record.layer).toBe("LONG_TERM");
    expect(record.origin).toBe("USER");
    expect(record.sensitivity).toBe("ORDINARY");
    expect(record.supersededById).toBeNull();
    expect(record.validUntil).toBeNull();
  });

  it("distingue une préférence d'un souvenir ordinaire", async () => {
    // La couche n'est pas une étiquette : une préférence est une consigne
    // permanente, qu'on remonte quel que soit le sujet du jour.
    const { provider } = makeProvider();

    await provider.store({
      userId: ADLAN,
      kind: "PROCEDURAL",
      content: "Réponds toujours en français",
      layer: "PREFERENCE",
    });
    await provider.store({ userId: ADLAN, kind: "SEMANTIC", content: "Habite à Lyon" });

    const preferences = await provider.search({
      userId: ADLAN,
      query: "",
      layers: ["PREFERENCE"],
    });

    expect(preferences).toHaveLength(1);
    expect(preferences[0]?.record.content).toBe("Réponds toujours en français");
  });

  it("retient qui a voulu le souvenir", async () => {
    const { provider } = makeProvider();

    const deduit = await provider.store({
      userId: ADLAN,
      kind: "SEMANTIC",
      content: "Travaille probablement sur NEXUS",
      origin: "AGENT",
    });

    // Un fait dicté et un fait déduit n'ont pas la même autorité. L'interface
    // et le contexte les présentent différemment.
    expect(deduit.origin).toBe("AGENT");
  });
});

describe("search", () => {
  it("trouve par chevauchement de termes", async () => {
    const { provider } = makeProvider();
    await provider.store({ userId: ADLAN, kind: "SEMANTIC", content: "Préfère le train" });
    await provider.store({ userId: ADLAN, kind: "SEMANTIC", content: "Aime le café serré" });

    const hits = await provider.search({ userId: ADLAN, query: "train" });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.record.content).toBe("Préfère le train");
  });

  it("une requête vide parcourt tout, du plus récent au plus ancien", async () => {
    // C'est l'écran de gestion : l'utilisateur veut voir ce que NEXUS retient
    // de lui, sans avoir à deviner un mot-clé.
    const { provider, advance } = makeProvider();
    await provider.store({ userId: ADLAN, kind: "SEMANTIC", content: "Premier" });
    advance(1);
    await provider.store({ userId: ADLAN, kind: "SEMANTIC", content: "Second" });

    const hits = await provider.search({ userId: ADLAN, query: "" });

    expect(hits.map((hit) => hit.record.content)).toEqual(["Second", "Premier"]);
  });

  it("le plus récent devance à pertinence égale", async () => {
    const { provider, advance } = makeProvider();
    await provider.store({ userId: ADLAN, kind: "SEMANTIC", content: "Réunion le lundi" });
    advance(60);
    await provider.store({ userId: ADLAN, kind: "SEMANTIC", content: "Réunion le mardi" });

    const hits = await provider.search({ userId: ADLAN, query: "réunion" });

    expect(hits[0]?.record.content).toBe("Réunion le mardi");
  });

  it("filtre par nature de souvenir", async () => {
    const { provider } = makeProvider();
    await provider.store({ userId: ADLAN, kind: "SEMANTIC", content: "Habite à Lyon" });
    await provider.store({ userId: ADLAN, kind: "EPISODIC", content: "A visité Lyon en mai" });

    const hits = await provider.search({ userId: ADLAN, query: "lyon", kinds: ["EPISODIC"] });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.record.kind).toBe("EPISODIC");
  });

  it("respecte la limite", async () => {
    const { provider } = makeProvider();
    for (let index = 0; index < 10; index += 1) {
      await provider.store({ userId: ADLAN, kind: "SEMANTIC", content: `Note ${String(index)}` });
    }

    expect(await provider.search({ userId: ADLAN, query: "note", limit: 3 })).toHaveLength(3);
  });
});

describe("update", () => {
  it("corriger un fait le supersède au lieu de l'écraser", async () => {
    // « Où j'habitais l'an dernier » est une question ordinaire. Un écrasement
    // rend toute réponse impossible, et personne ne s'en aperçoit avant qu'on
    // la pose.
    const { provider } = makeProvider();
    const ancien = await provider.store({
      userId: ADLAN,
      kind: "SEMANTIC",
      content: "Habite à Lyon",
    });

    const neuf = await provider.update({
      userId: ADLAN,
      id: ancien.id,
      content: "Habite à Paris",
    });

    expect(neuf?.content).toBe("Habite à Paris");
    expect(neuf?.supersedesId).toBe(ancien.id);
    expect(neuf?.id).not.toBe(ancien.id);
  });

  it("le fait supersédé ne remonte plus, mais reste consultable", async () => {
    const { provider } = makeProvider();
    const ancien = await provider.store({
      userId: ADLAN,
      kind: "SEMANTIC",
      content: "Habite à Lyon",
    });
    await provider.update({ userId: ADLAN, id: ancien.id, content: "Habite à Paris" });

    const courant = await provider.search({ userId: ADLAN, query: "habite" });
    expect(courant.map((hit) => hit.record.content)).toEqual(["Habite à Paris"]);

    const histoire = await provider.search({
      userId: ADLAN,
      query: "habite",
      includeSuperseded: true,
    });
    expect(histoire.map((hit) => hit.record.content).sort()).toEqual([
      "Habite à Lyon",
      "Habite à Paris",
    ]);
  });

  it("corriger une métadonnée s'applique sur place", async () => {
    // Changer l'importance ne change pas ce qui est affirmé : superséder ici
    // encombrerait l'historique de versions qui ne disent rien de neuf.
    const { provider } = makeProvider();
    const record = await provider.store({
      userId: ADLAN,
      kind: "SEMANTIC",
      content: "Préfère le train",
    });

    const patched = await provider.update({
      userId: ADLAN,
      id: record.id,
      importance: 0.95,
      tags: ["transport"],
    });

    expect(patched?.id).toBe(record.id);
    expect(patched?.importance).toBe(0.95);
    expect(patched?.tags).toEqual(["transport"]);
    expect(patched?.supersedesId).toBeNull();
  });

  it("réécrire à l'identique ne supersède pas", async () => {
    const { provider } = makeProvider();
    const record = await provider.store({
      userId: ADLAN,
      kind: "SEMANTIC",
      content: "Préfère le train",
    });

    const patched = await provider.update({
      userId: ADLAN,
      id: record.id,
      content: "Préfère le train",
    });

    expect(patched?.id).toBe(record.id);
  });

  it("rend undefined pour un identifiant inconnu", async () => {
    const { provider } = makeProvider();
    expect(
      await provider.update({ userId: ADLAN, id: "inexistant", content: "x" }),
    ).toBeUndefined();
  });
});

describe("delete", () => {
  it("supprime un souvenir", async () => {
    const { provider } = makeProvider();
    const record = await provider.store({ userId: ADLAN, kind: "SEMANTIC", content: "À oublier" });

    expect(await provider.delete({ userId: ADLAN, id: record.id })).toBe(true);
    expect(await provider.search({ userId: ADLAN, query: "oublier" })).toEqual([]);
  });

  it("rend faux pour un identifiant inconnu", async () => {
    const { provider } = makeProvider();
    expect(await provider.delete({ userId: ADLAN, id: "inexistant" })).toBe(false);
  });
});

describe("frontière entre utilisateurs", () => {
  it("une recherche ne traverse jamais la frontière", async () => {
    const { provider } = makeProvider();
    await provider.store({ userId: AUTRE, kind: "SEMANTIC", content: "Secret d'un autre" });

    expect(await provider.search({ userId: ADLAN, query: "secret" })).toEqual([]);
    expect(await provider.search({ userId: ADLAN, query: "" })).toEqual([]);
  });

  it("un identifiant deviné ne donne pas accès au souvenir d'un autre", async () => {
    // L'identifiant est un UUID v7 : il porte un horodatage, donc une partie en
    // est prévisible. Il ne doit jamais suffire à lui seul.
    const { provider } = makeProvider();
    const record = await provider.store({
      userId: AUTRE,
      kind: "SEMANTIC",
      content: "Secret d'un autre",
    });

    expect(
      await provider.update({ userId: ADLAN, id: record.id, content: "détourné" }),
    ).toBeUndefined();
    expect(await provider.delete({ userId: ADLAN, id: record.id })).toBe(false);

    // Et le souvenir de l'autre est intact.
    const intact = await provider.search({ userId: AUTRE, query: "secret" });
    expect(intact[0]?.record.content).toBe("Secret d'un autre");
  });
});

describe("summarize", () => {
  it("coupe entre les phrases, pas au milieu", async () => {
    const { provider } = makeProvider();

    const resume = await provider.summarize({
      userId: ADLAN,
      text: "Première phrase. Deuxième phrase. Troisième phrase.",
      maxChars: 35,
    });

    expect(resume).toBe("Première phrase. Deuxième phrase.");
  });

  it("rend un texte tronqué quand aucune phrase n'entre", async () => {
    const { provider } = makeProvider();

    const resume = await provider.summarize({
      userId: ADLAN,
      text: "Une phrase très longue sans ponctuation intermédiaire du tout",
      maxChars: 20,
    });

    expect(resume).toHaveLength(20);
  });
});
