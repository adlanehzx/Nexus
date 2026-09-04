import { describe, expect, it } from "vitest";
import { classify, safePreview } from "../src/sensitivity.js";
import { parseMemoryCommand } from "../src/commands.js";

/**
 * La règle du silence, et les commandes explicites.
 *
 * Ce fichier éprouve la frontière la plus délicate du système : ce qui peut être
 * retenu, ce qui exige un accord, ce qui ne doit jamais l'être. Les faux
 * positifs y sont assumés — refuser à tort coûte une reformulation, accepter à
 * tort coûte un secret dans une base.
 */

describe("ce qui n'est jamais mémorisé", () => {
  const secrets = [
    "Mon mot de passe est correctchevalbatteriea grafe",
    "Le mot de passe du wifi : Tr0ub4dor&3xy",
    "Ma clé API est sk-abcdefghijklmnopqrstuvwx",
    "password=hunter2hunter2",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "Ma phrase de récupération : witch collapse practice feed",
  ];

  for (const contenu of secrets) {
    it(`refuse : « ${contenu.slice(0, 32)}… »`, () => {
      expect(classify(contenu).verdict).toBe("FORBIDDEN");
    });
  }

  it("refuse un numéro de carte", () => {
    // 4539 1488 0343 6467 satisfait la clé de Luhn.
    expect(classify("Ma carte : 4539 1488 0343 6467").verdict).toBe("FORBIDDEN");
  });

  it("ne refuse pas une longue suite de chiffres quelconque", () => {
    // Un numéro de commande, un ISBN, une référence de colis : autant de choses
    // qu'un utilisateur a de bonnes raisons de vouloir retenir. La clé de Luhn
    // est ce qui distingue.
    expect(classify("Numéro de commande 1234567890123").verdict).toBe("ORDINARY");
  });

  it("explique le refus sans reproduire le contenu", () => {
    const verdict = classify("Mon mot de passe est Tr0ub4dor3xy");

    expect(verdict.explanation).toContain("gestionnaire de mots de passe");
    expect(verdict.explanation).not.toContain("Tr0ub4dor3xy");
    expect(verdict.categories).toContain("mot-de-passe");
  });
});

describe("ce qui exige un accord", () => {
  const personnels = [
    ["sante", "J'ai été diagnostiqué diabétique en 2019"],
    ["finance", "Mon IBAN est celui du compte joint"],
    ["identite", "Mon numéro de sécurité sociale figure sur la fiche"],
    ["adresse", "J'habite 12 rue des Lilas"],
  ] as const;

  for (const [categorie, contenu] of personnels) {
    it(`classe « ${categorie} » comme personnel`, () => {
      const verdict = classify(contenu);

      expect(verdict.verdict).toBe("PERSONAL");
      expect(verdict.categories).toContain(categorie);
    });
  }

  it("nomme les catégories sans citer le contenu", () => {
    const verdict = classify("J'ai été diagnostiqué diabétique");

    expect(verdict.explanation).not.toContain("diabétique");
    expect(verdict.explanation).toContain("sante");
  });
});

describe("ce qui passe sans cérémonie", () => {
  const ordinaires = [
    "Adlan préfère le train à l'avion",
    "Réunion d'équipe tous les mardis à 10 h",
    "Le dépôt NEXUS utilise pnpm et Turborepo",
    "Réponds toujours en français",
  ];

  for (const contenu of ordinaires) {
    it(`accepte : « ${contenu.slice(0, 30)}… »`, () => {
      expect(classify(contenu).verdict).toBe("ORDINARY");
    });
  }
});

describe("aperçu masqué", () => {
  it("masque le secret dans l'aperçu", () => {
    const apercu = safePreview("Ma clé est sk-abcdefghijklmnopqrstuvwx et voilà", 200);

    expect(apercu).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(apercu).toContain("[REDACTED]");
  });

  it("borne la longueur", () => {
    expect(safePreview("a".repeat(500), 20)).toHaveLength(21);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("commande « retiens »", () => {
  const formes = [
    "Retiens que je préfère le train",
    "retiens : je préfère le train",
    "Souviens-toi que je préfère le train",
    "Rappelle-toi que je préfère le train",
    "Mémorise que je préfère le train",
    "Note que je préfère le train",
    "Remember that je préfère le train",
    "Remember this: je préfère le train",
  ];

  for (const forme of formes) {
    it(`reconnaît « ${forme.slice(0, 26)}… »`, () => {
      const commande = parseMemoryCommand(forme);

      expect(commande?.kind).toBe("remember");
      expect(commande).toMatchObject({ content: "je préfère le train" });
    });
  }

  it("retire la ponctuation finale", () => {
    // Sans cela, « Retiens que X. » et « Retiens que X » créeraient deux
    // souvenirs pour la même chose.
    expect(parseMemoryCommand("Retiens que X.")).toMatchObject({ content: "X" });
  });
});

describe("commande « oublie »", () => {
  it("reconnaît une cible", () => {
    expect(parseMemoryCommand("Oublie que j'habite à Lyon")).toEqual({
      kind: "forget",
      target: "j'habite à Lyon",
      all: false,
    });
  });

  it("distingue l'effacement total", () => {
    // Effacer un souvenir se défait en le redisant ; effacer la mémoire entière
    // ne se défait pas. Les deux n'appellent pas la même confirmation.
    for (const forme of ["Oublie tout", "Efface toute ta mémoire", "Forget everything"]) {
      expect(parseMemoryCommand(forme)).toEqual({ kind: "forget", target: "", all: true });
    }
  });
});

describe("ce qui n'est pas une commande", () => {
  const messages = [
    "Je me souviens que le train était en retard",
    "Peux-tu me rappeler mes rendez-vous ?",
    "J'ai oublié mon parapluie dans le train",
    "Il faudrait que je note ça quelque part",
    "Quelle est la météo ?",
    "",
    "   ",
  ];

  for (const message of messages) {
    it(`ignore : « ${message.trim().slice(0, 34) || "(vide)"} »`, () => {
      // Ne rien reconnaître est le comportement **normal**. Prendre un récit
      // pour un ordre remplirait la mémoire de bruit, et l'utilisateur ne
      // saurait pas d'où il vient.
      expect(parseMemoryCommand(message)).toBeUndefined();
    });
  }
});
