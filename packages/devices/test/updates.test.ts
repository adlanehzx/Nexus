import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion, updateAdvice } from "../src/updates.js";

/**
 * Comparer des numéros de version est un classique des erreurs silencieuses :
 * `"10" < "9"` en comparaison de chaînes, et une pré-version passe facilement
 * pour plus récente que la version finale. Les cas limites sont donc le sujet.
 */

const v = (value: string) => {
  const parsed = parseVersion(value);
  if (parsed === undefined) throw new Error(`version illisible dans le test : ${value}`);
  return parsed;
};

describe("lecture d'une version", () => {
  it("lit les formes usuelles", () => {
    expect(parseVersion("1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("v1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion(" 1.2.3 ")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("1.2.3-rc.1")).toMatchObject({ prerelease: "rc.1" });
    expect(parseVersion("1.2.3+build.5")).toMatchObject({ major: 1, patch: 3 });
  });

  it("rend undefined au lieu de lever", () => {
    // Une version illisible est une observation — un worker a annoncé n'importe
    // quoi — pas une erreur de programmation.
    for (const bad of ["", "1.2", "abc", "1.2.3.4", null, undefined]) {
      expect(parseVersion(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("comparaison", () => {
  it("ordonne par majeure, mineure, correctif", () => {
    expect(compareVersions(v("2.0.0"), v("1.9.9"))).toBeGreaterThan(0);
    expect(compareVersions(v("1.3.0"), v("1.2.9"))).toBeGreaterThan(0);
    expect(compareVersions(v("1.2.4"), v("1.2.3"))).toBeGreaterThan(0);
    expect(compareVersions(v("1.2.3"), v("1.2.3"))).toBe(0);
  });

  it("ne compare pas des chaînes", () => {
    // Le piège : `"10" < "9"` lexicographiquement.
    expect(compareVersions(v("1.10.0"), v("1.9.0"))).toBeGreaterThan(0);
    expect(compareVersions(v("0.1.10"), v("0.1.9"))).toBeGreaterThan(0);
  });

  it("place une pré-version avant la version finale", () => {
    expect(compareVersions(v("1.2.0-rc.1"), v("1.2.0"))).toBeLessThan(0);
    expect(compareVersions(v("1.2.0"), v("1.2.0-rc.1"))).toBeGreaterThan(0);
  });
});

describe("avis de mise à jour", () => {
  it("dit « à jour » sans rien demander", () => {
    const advice = updateAdvice("1.2.3", "1.2.3");
    expect(advice.status).toBe("a-jour");
    expect(advice.action).toBeNull();
  });

  it("dit « en retard » et nomme un geste local", () => {
    const advice = updateAdvice("1.0.0", "1.2.0");
    expect(advice.status).toBe("en-retard");
    // Le geste est local : NEXUS n'a pas de canal pour mettre à jour un poste,
    // et la phrase ne doit pas laisser croire qu'un bouton le ferait.
    expect(advice.action).toMatch(/sur sa machine/);
    expect(advice.action).toContain("1.2.0");
  });

  it("reconnaît un exécutant en avance", () => {
    expect(updateAdvice("2.0.0", "1.9.0").status).toBe("en-avance");
  });

  it("n'affirme rien quand aucune version n'est attendue", () => {
    // Inventer « à jour » serait affirmer ce qu'on ne sait pas.
    const advice = updateAdvice("1.2.3", null);
    expect(advice.status).toBe("inconnu");
    expect(advice.action).toBeNull();
  });

  it("signale un exécutant dont la version est illisible", () => {
    const advice = updateAdvice(null, "1.2.0");
    expect(advice.status).toBe("inconnu");
    expect(advice.action).toMatch(/inconnue/);
  });

  it("garde les chaînes d'origine, pour l'affichage", () => {
    expect(updateAdvice("v1.0.0", "1.2.0")).toMatchObject({
      current: "v1.0.0",
      expected: "1.2.0",
    });
  });
});
