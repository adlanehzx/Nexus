import { describe, expect, it } from "vitest";
import { CrashReporter, InMemoryCrashStore } from "../src/crash.js";
import { UpdatePolicy, type ReleaseEntry } from "../src/updater.js";

/**
 * Une mise à jour automatique est un canal d'exécution de code : les refus sont
 * le contenu réel du module, donc le sujet des tests. Un rapport de crash, lui,
 * contient des chemins, des noms et parfois des fragments de données — ce qui
 * est testé est qu'il ne porte pas de secret et qu'il ne remplit pas le disque.
 */

const release = (overrides: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  version: "1.3.0",
  channel: "stable",
  signature: "sig",
  url: "https://exemple.test/nexus-1.3.0.AppImage",
  publishedAt: 1,
  ...overrides,
});

describe("mise à jour : ce qui est proposé", () => {
  it("propose la plus récente du canal", () => {
    const policy = new UpdatePolicy({ currentVersion: "1.0.0" });
    const decision = policy.decide([release({ version: "1.1.0" }), release({ version: "1.2.0" })]);
    expect(decision.kind).toBe("disponible");
    if (decision.kind === "disponible") expect(decision.release.version).toBe("1.2.0");
  });

  it("ne dit rien quand on est à jour", () => {
    const policy = new UpdatePolicy({ currentVersion: "1.3.0" });
    expect(policy.decide([release()]).kind).toBe("aucune");
  });
});

describe("mise à jour : les refus", () => {
  it("refuse une version non signée", () => {
    // Un flux sans signature n'est pas incomplet : il est non fiable. Qui le
    // sert peut y mettre n'importe quel binaire.
    const policy = new UpdatePolicy({ currentVersion: "1.0.0" });
    const decision = policy.decide([release({ signature: null })]);
    expect(decision).toMatchObject({ kind: "refusée", reason: "version non signée" });
  });

  it("refuse une signature vide, qui est la même chose", () => {
    const policy = new UpdatePolicy({ currentVersion: "1.0.0" });
    expect(policy.decide([release({ signature: "" })]).kind).toBe("refusée");
  });

  it("ne revient jamais en arrière", () => {
    // Proposer une version plus ancienne permet de réinstaller une faille
    // corrigée.
    const policy = new UpdatePolicy({ currentVersion: "2.0.0" });
    expect(policy.decide([release({ version: "1.9.0" })]).kind).toBe("aucune");
  });

  it("ne change pas de canal en silence", () => {
    const policy = new UpdatePolicy({ currentVersion: "1.0.0", channel: "stable" });
    // Une installation stable ne doit pas se retrouver en bêta parce que le flux
    // en a proposé une.
    expect(policy.decide([release({ version: "2.0.0", channel: "beta" })]).kind).toBe("aucune");
  });

  it("exige un accord pour une version majeure", () => {
    const policy = new UpdatePolicy({ currentVersion: "1.5.0" });
    const decision = policy.decide([release({ version: "2.0.0" })]);
    // Une majeure peut demander une migration ; l'appliquer pendant la nuit
    // serait une mauvaise surprise au réveil.
    expect(decision.kind).toBe("accord-requis");
  });

  it("applique une majeure quand l'accord est donné", () => {
    const policy = new UpdatePolicy({ currentVersion: "1.5.0", allowMajor: true });
    expect(policy.decide([release({ version: "2.0.0" })]).kind).toBe("disponible");
  });

  it("refuse de décider si la version installée est illisible", () => {
    const policy = new UpdatePolicy({ currentVersion: "pas-une-version" });
    expect(policy.decide([release()]).kind).toBe("refusée");
  });

  it("ignore une entrée malformée au lieu d'abandonner", () => {
    // Un flux abîmé ne doit pas empêcher toute mise à jour, y compris celle qui
    // corrige le problème.
    const policy = new UpdatePolicy({ currentVersion: "1.0.0" });
    const decision = policy.decide([release({ version: "pas-une-version" }), release()]);
    expect(decision.kind).toBe("disponible");
  });

  it("n'expose aucun moyen d'installer", () => {
    const policy = new UpdatePolicy({ currentVersion: "1.0.0" });
    // Un module qui déciderait **et** appliquerait serait un installeur, la
    // pièce la plus sensible de la chaîne. Celui-ci décide.
    for (const method of ["install", "apply", "download", "run"]) {
      expect(method in policy, method).toBe(false);
    }
  });
});

describe("télémétrie de crash", () => {
  const reporter = (options: { capacity?: number } = {}) =>
    new CrashReporter({
      store: new InMemoryCrashStore(),
      version: "1.2.3",
      now: () => 1_000,
      newId: (() => {
        let index = 0;
        return () => {
          index += 1;
          return `crash-${String(index)}`;
        };
      })(),
      ...options,
    });

  it("enregistre le type, le message et la pile", async () => {
    const crashes = reporter();
    const report = await crashes.record(new TypeError("x.y n'est pas une fonction"));
    expect(report.kind).toBe("TypeError");
    expect(report.message).toContain("n'est pas une fonction");
    expect(report.version).toBe("1.2.3");
  });

  it("rédige les secrets du message, de la pile et du contexte", async () => {
    const crashes = reporter();
    const token = `sk-${"a".repeat(32)}`;
    const report = await crashes.record(new Error(`échec avec ${token}`), {
      url: `https://exemple.test/?token=${token}`,
    });

    // Une trace contient des en-têtes, des URL avec jeton, un mot de passe passé
    // en argument. La rédaction passe par celle du reste du dépôt.
    expect(report.message).not.toContain(token);
    expect(report.message).toContain("[REDACTED]");
    expect(JSON.stringify(report.context)).not.toContain(token);
  });

  it("compte les répétitions au lieu d'empiler", async () => {
    const crashes = reporter();
    const boom = new Error("toujours la même");
    await crashes.record(boom);
    await crashes.record(boom);
    const reports = await crashes.list();

    // Cent fois la même pile n'apporte rien de plus que la première, et noie la
    // seconde cause — qui est souvent la vraie.
    expect(reports).toHaveLength(1);
    expect(reports[0]?.occurrences).toBe(2);
  });

  it("borne le nombre de rapports", async () => {
    const crashes = reporter({ capacity: 2 });
    for (const index of [1, 2, 3]) await crashes.record(new Error(`erreur ${String(index)}`));
    // Un plantage en boucle écrirait mille rapports et remplirait le disque :
    // il transformerait un bug en panne.
    expect(await crashes.list()).toHaveLength(2);
  });

  it("borne la longueur d'une pile", async () => {
    const crashes = new CrashReporter({
      store: new InMemoryCrashStore(),
      version: "1.2.3",
      maxStackChars: 100,
    });
    const error = new Error("longue");
    error.stack = "x".repeat(5_000);
    const report = await crashes.record(error);
    // `truncate` ajoute une marque qui dit combien a été coupé : la longueur
    // dépasse donc légèrement le plafond, et c'est voulu — savoir qu'une pile a
    // été tronquée, et de combien, change la façon de la lire.
    expect(report.stack).toContain("tronqué");
    expect(report.stack.length).toBeLessThan(200);
  });

  it("rend un rapport lisible, sans pouvoir l'envoyer", async () => {
    const crashes = reporter();
    const report = await crashes.record(new Error("plantage"), { écran: "conversation" });
    const text = await crashes.share(report.id);

    expect(text).toContain("NEXUS 1.2.3");
    expect(text).toContain("plantage");
    expect(text).toContain("écran : conversation");
    // Le module n'a pas de réseau : il ne peut donc pas envoyer par accident.
    expect("send" in crashes).toBe(false);
    expect("upload" in crashes).toBe(false);
  });

  it("rend undefined pour un rapport inconnu", async () => {
    const crashes = reporter();
    expect(await crashes.share("absent")).toBeUndefined();
  });

  it("s'efface sur demande", async () => {
    const crashes = reporter();
    await crashes.record(new Error("x"));
    await crashes.clear();
    expect(await crashes.list()).toHaveLength(0);
  });
});
