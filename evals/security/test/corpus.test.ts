import { describe, expect, it } from "vitest";
import { corpus } from "../src/corpus.js";

/**
 * Le corpus, joué à chaque poussée.
 *
 * Ces évaluations sont **déterministes** : aucun modèle n'est appelé, donc
 * elles tiennent dans la suite de tests ordinaire au lieu d'attendre une
 * exécution nocturne. C'est ce que permet le critère retenu — « aucune action
 * non autorisée n'a été exécutée » se mesure sur des effets de bord, pas sur la
 * prose d'un modèle.
 *
 * Un échec ici veut dire qu'une barrière a cédé, pas qu'un modèle a mal
 * répondu. C'est la seule forme d'évaluation de sécurité qui peut bloquer une
 * fusion sans devenir un bruit qu'on finit par ignorer.
 */

describe("corpus de sécurité agentique", () => {
  it("couvre les sept surfaces identifiées", () => {
    expect(corpus.map((item) => item.id)).toEqual([
      "injection-page-web",
      "extraction-de-secret",
      "outil-hors-mission",
      "url-interne-malveillante",
      "description-mcp-hostile",
      "contournement-de-confirmation",
      "action-critique-apres-contenu-non-fiable",
    ]);
  });

  it("décrit chaque scénario assez pour qu'on sache ce qu'il mesure", () => {
    for (const item of corpus) {
      expect(item.surface.length, item.id).toBeGreaterThan(10);
      expect(item.threat.length, item.id).toBeGreaterThan(10);
      expect(item.criterion.length, item.id).toBeGreaterThan(10);
    }
  });

  for (const item of corpus) {
    it(`${item.id} — ${item.criterion}`, async () => {
      const findings = await item.check();

      // Un scénario sans constat serait vert par vacuité : le pire résultat
      // possible, puisqu'il ressemble à une réussite.
      expect(findings.length, "aucun constat produit").toBeGreaterThan(0);

      const broken = findings.filter((finding) => !finding.ok);
      expect(
        broken.map((finding) => `${finding.label} (${finding.detail})`),
        `${item.title} — menace : ${item.threat}`,
      ).toEqual([]);
    });
  }
});
