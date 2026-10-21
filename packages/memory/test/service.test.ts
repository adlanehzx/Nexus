import { describe, expect, it } from "vitest";
import { InMemoryMemoryProvider } from "../src/in-memory.js";
import {
  MemoryService,
  SensitiveMemoryNeedsConsentError,
  SensitiveMemoryRefusedError,
} from "../src/service.js";

/**
 * La politique autour du magasin.
 *
 * Le magasin range ce qu'on lui donne — c'est son rôle. Tout ce qui décide de
 * *quoi* lui donner vit ici, et c'est donc ici que se joue la règle centrale :
 * **rien de sensible n'est mémorisé en silence.**
 */

const ADLAN = "user-example";
const AUTRE = "user-autre";

interface Audit {
  action: string;
  userId: string;
  recordId?: string;
  categories?: readonly string[];
}

function makeService() {
  const audit: Audit[] = [];
  const provider = new InMemoryMemoryProvider({
    now: () => new Date("2026-09-03T10:00:00.000Z"),
  });

  return {
    provider,
    audit,
    service: new MemoryService({
      provider,
      onAudit: (event) => audit.push(event),
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mémorisation
// ─────────────────────────────────────────────────────────────────────────────

describe("remember", () => {
  it("mémorise ce qui est anodin", async () => {
    const { service } = makeService();

    const record = await service.remember({
      userId: ADLAN,
      content: "Alex préfère le train",
    });

    expect(record.content).toBe("Alex préfère le train");
    expect(record.sensitivity).toBe("ORDINARY");
  });

  it("refuse un secret, quel que soit le demandeur", async () => {
    // Pas de dérogation « puisque c'est l'utilisateur qui le demande ». NEXUS
    // n'est pas un coffre-fort ; l'y déposer donnerait une fausse impression de
    // sécurité, ce qui est pire que le refus.
    const { service, provider } = makeService();

    await expect(
      service.remember({ userId: ADLAN, content: "Mon mot de passe est Tr0ub4dor3xy" }),
    ).rejects.toThrow(SensitiveMemoryRefusedError);

    expect(provider.size).toBe(0);
  });

  it("le refus n'écrit pas le contenu dans l'audit", async () => {
    // Refuser de stocker un secret pour le recopier dans le journal annulerait
    // le refus.
    const { service, audit } = makeService();

    await service
      .remember({ userId: ADLAN, content: "Mon mot de passe est Tr0ub4dor3xy" })
      .catch(() => undefined);

    const refus = audit.find((event) => event.action === "refuse");
    expect(refus?.categories).toContain("mot-de-passe");
    expect(JSON.stringify(audit)).not.toContain("Tr0ub4dor3xy");
  });

  it("exige un accord pour une information personnelle", async () => {
    const { service, provider } = makeService();

    await expect(
      service.remember({ userId: ADLAN, content: "J'ai été diagnostiqué diabétique" }),
    ).rejects.toThrow(SensitiveMemoryNeedsConsentError);

    expect(provider.size).toBe(0);
  });

  it("mémorise l'information personnelle une fois l'accord donné", async () => {
    const { service } = makeService();

    const record = await service.remember({
      userId: ADLAN,
      content: "J'ai été diagnostiqué diabétique",
      acknowledgedSensitive: true,
    });

    // La sensibilité est **conservée sur l'enregistrement**, pas seulement
    // évaluée au passage : l'interface pourra la signaler des mois plus tard.
    expect(record.sensitivity).toBe("PERSONAL");
    expect(record.sensitiveCategories).toContain("sante");
  });

  it("refuse un contenu vide", async () => {
    const { service } = makeService();
    await expect(service.remember({ userId: ADLAN, content: "   " })).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Correction
// ─────────────────────────────────────────────────────────────────────────────

describe("update", () => {
  it("reclasse le contenu révisé", async () => {
    // Ne contrôler qu'à la création laisserait la modification comme porte
    // ouverte : on mémorise « une note » puis on l'édite pour y glisser un
    // mot de passe.
    const { service } = makeService();
    const record = await service.remember({ userId: ADLAN, content: "Une note anodine" });

    await expect(
      service.update({
        userId: ADLAN,
        id: record.id,
        content: "Mon mot de passe est Tr0ub4dor3xy",
      }),
    ).rejects.toThrow(SensitiveMemoryRefusedError);
  });

  it("laisse passer une correction ordinaire", async () => {
    const { service } = makeService();
    const record = await service.remember({ userId: ADLAN, content: "Habite à Lyon" });

    const corrige = await service.update({
      userId: ADLAN,
      id: record.id,
      content: "Habite à Paris",
    });

    expect(corrige?.content).toBe("Habite à Paris");
    expect(corrige?.supersedesId).toBe(record.id);
  });

  it("n'atteint pas le souvenir d'un autre", async () => {
    const { service } = makeService();
    const record = await service.remember({ userId: AUTRE, content: "Souvenir d'un autre" });

    expect(
      await service.update({ userId: ADLAN, id: record.id, content: "détourné" }),
    ).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Oubli
// ─────────────────────────────────────────────────────────────────────────────

describe("forget", () => {
  it("oublie par identifiant et rend ce qui a disparu", async () => {
    // L'interface doit pouvoir afficher *ce qui* a été oublié, et offrir de le
    // redire.
    const { service } = makeService();
    const record = await service.remember({ userId: ADLAN, content: "Habite à Lyon" });

    const result = await service.forget({ userId: ADLAN, id: record.id });

    expect(result.forgotten.map((r) => r.content)).toEqual(["Habite à Lyon"]);
  });

  it("oublie par texte quand la correspondance est nette", async () => {
    const { service } = makeService();
    await service.remember({ userId: ADLAN, content: "Habite à Lyon" });
    await service.remember({ userId: ADLAN, content: "Préfère le café serré" });

    const result = await service.forget({ userId: ADLAN, match: "habite lyon" });

    expect(result.forgotten).toHaveLength(1);
    expect(result.ambiguous).toEqual([]);
  });

  it("ne devine pas quand plusieurs souvenirs se ressemblent", async () => {
    // Supprimer le mauvais est irréversible ; demander coûte un aller-retour.
    const { service } = makeService();
    await service.remember({ userId: ADLAN, content: "Réunion équipe le lundi" });
    await service.remember({ userId: ADLAN, content: "Réunion équipe le mardi" });

    const result = await service.forget({ userId: ADLAN, match: "réunion équipe" });

    expect(result.forgotten).toEqual([]);
    expect(result.ambiguous).toHaveLength(2);
  });

  it("ne trouve rien sans se plaindre", async () => {
    const { service } = makeService();

    const result = await service.forget({ userId: ADLAN, match: "quelque chose d'absent" });

    expect(result.forgotten).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("exige une confirmation pour tout effacer", async () => {
    // Un souvenir effacé se redit ; une mémoire entière ne se reconstitue pas.
    const { service, provider } = makeService();
    await service.remember({ userId: ADLAN, content: "Un souvenir" });

    const result = await service.forget({ userId: ADLAN, all: true });

    expect(result.needsConfirmation).toBe(true);
    expect(provider.size).toBe(1);
  });

  it("efface tout une fois confirmé, et rien de plus", async () => {
    const { service, provider } = makeService();
    await service.remember({ userId: ADLAN, content: "Souvenir d'Alex" });
    await service.remember({ userId: AUTRE, content: "Souvenir d'un autre" });

    const result = await service.forget({ userId: ADLAN, all: true, confirmed: true });

    expect(result.forgotten).toHaveLength(1);
    // La mémoire de l'autre utilisateur est intacte : « tout » veut dire
    // « tout le mien ».
    expect(provider.size).toBe(1);
  });

  it("n'efface pas le souvenir d'un autre par son identifiant", async () => {
    const { service, provider } = makeService();
    const record = await service.remember({ userId: AUTRE, content: "Souvenir d'un autre" });

    const result = await service.forget({ userId: ADLAN, id: record.id });

    expect(result.forgotten).toEqual([]);
    expect(provider.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Commandes explicites
// ─────────────────────────────────────────────────────────────────────────────

describe("commandes explicites", () => {
  it("exécute « retiens que… »", async () => {
    const { service } = makeService();

    const outcome = await service.handleCommand(ADLAN, "Retiens que je préfère le train");

    expect(outcome?.stored?.content).toBe("je préfère le train");
    expect(outcome?.message).toContain("C'est noté");
  });

  it("ce que l'utilisateur dicte pèse plus qu'une inférence", async () => {
    const { service } = makeService();

    const outcome = await service.handleCommand(ADLAN, "Retiens que je préfère le train");

    expect(outcome?.stored?.origin).toBe("USER");
    expect(outcome?.stored?.importance).toBeGreaterThan(0.5);
  });

  it("exécute « oublie… »", async () => {
    const { service } = makeService();
    await service.remember({ userId: ADLAN, content: "j'habite à Lyon" });

    const outcome = await service.handleCommand(ADLAN, "Oublie que j'habite à Lyon");

    expect(outcome?.forgotten?.forgotten).toHaveLength(1);
    expect(outcome?.message).toContain("Oublié");
  });

  it("une commande dictée subit la même classification qu'un appel d'API", async () => {
    // L'utilisateur qui dicte son mot de passe se le voit refuser comme s'il
    // l'avait saisi dans l'écran de gestion. Le chemin ne change pas la règle.
    const { service } = makeService();

    await expect(
      service.handleCommand(ADLAN, "Retiens que mon mot de passe est Tr0ub4dor3xy"),
    ).rejects.toThrow(SensitiveMemoryRefusedError);
  });

  it("« oublie tout » demande confirmation", async () => {
    const { service } = makeService();
    await service.remember({ userId: ADLAN, content: "Un souvenir" });

    const outcome = await service.handleCommand(ADLAN, "Oublie tout");

    expect(outcome?.forgotten?.needsConfirmation).toBe(true);
    expect(outcome?.message).toContain("irréversible");
  });

  it("rend undefined quand ce n'est pas une commande", async () => {
    const { service } = makeService();

    expect(await service.handleCommand(ADLAN, "Quelle est la météo ?")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lecture
// ─────────────────────────────────────────────────────────────────────────────

describe("lecture", () => {
  it("liste tout ce qui est retenu d'un utilisateur", async () => {
    const { service } = makeService();
    await service.remember({ userId: ADLAN, content: "Souvenir A" });
    await service.remember({ userId: ADLAN, content: "Souvenir B" });
    await service.remember({ userId: AUTRE, content: "Souvenir d'un autre" });

    const hits = await service.list({ userId: ADLAN });

    expect(hits).toHaveLength(2);
  });

  it("liste une seule couche à la fois", async () => {
    const { service } = makeService();
    await service.remember({ userId: ADLAN, content: "Réponds en français", layer: "PREFERENCE" });
    await service.remember({ userId: ADLAN, content: "Habite à Lyon" });

    const preferences = await service.list({ userId: ADLAN, layer: "PREFERENCE" });

    expect(preferences.map((hit) => hit.record.content)).toEqual(["Réponds en français"]);
  });
});
