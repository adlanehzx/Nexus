import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactText, truncate } from "../src/index.js";

describe("redact", () => {
  it("masque les clés dont le nom trahit un secret", () => {
    const result = redact({
      user: "adlan",
      password: "hunter2",
      apiKey: "abc",
      access_token: "xyz",
      nested: { clientSecret: "s" },
    });

    expect(result).toEqual({
      user: "adlan",
      password: REDACTED,
      apiKey: REDACTED,
      access_token: REDACTED,
      nested: { clientSecret: REDACTED },
    });
  });

  it("masque une valeur qui a la forme d'un secret, quel que soit son nom", () => {
    // Un secret finit toujours par se retrouver dans un champ innocemment nommé.
    const result = redact({
      note: "sk-abcdefghijklmnopqrstuvwxyz123456",
      other: "ghp_abcdefghijklmnopqrstuvwxyz1234",
      header: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
      innocent: "bonjour",
    });

    expect(result).toEqual({
      note: REDACTED,
      other: REDACTED,
      header: REDACTED,
      innocent: "bonjour",
    });
  });

  it("traverse les tableaux", () => {
    expect(redact([{ token: "a" }, { ok: "b" }])).toEqual([{ token: REDACTED }, { ok: "b" }]);
  });

  it("survit à une référence circulaire", () => {
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;

    // La journalisation ne doit pas tomber précisément quand ça va mal.
    expect(() => redact(cyclic)).not.toThrow();
    expect(redact(cyclic)).toMatchObject({ name: "x", self: "[référence circulaire]" });
  });

  it("borne la profondeur", () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };

    expect(JSON.stringify(redact(deep))).toContain("profondeur maximale");
  });

  it("laisse intactes les valeurs ordinaires", () => {
    expect(redact({ n: 1, b: true, nil: null, s: "texte" })).toEqual({
      n: 1,
      b: true,
      nil: null,
      s: "texte",
    });
  });
});

describe("truncate", () => {
  it("ne touche pas à un texte court", () => {
    expect(truncate("court", 100)).toBe("court");
  });

  it("annonce la troncature et la taille réelle", () => {
    const result = truncate("x".repeat(500), 10);
    expect(result).toContain("tronqué");
    expect(result).toContain("500");
  });
});

describe("redactText", () => {
  it("masque une valeur derriere un nom de cle prefixe", () => {
    // Le nom porte un prefixe : c'est la forme courante dans un fichier .env,
    // et celle qu'une limite de mot laisserait passer.
    const result = redactText("env: DATABASE_PASSWORD=motdepassesecret");
    expect(result).not.toContain("motdepassesecret");
    expect(result).toContain(REDACTED);
  });

  it("masque une valeur entre guillemets sans avaler la ligne", () => {
    const result = redactText('api_key: "sk-quelquechosedelong123456"');
    expect(result).not.toContain("sk-quelquechosedelong123456");
    expect(result).toContain("api_key");
  });

  it("masque un jeton reconnaissable a sa seule forme", () => {
    expect(redactText("clone https://github.com ghp_abcdefghijklmnopqrstuvwxyz01")).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz01",
    );
  });

  it("masque les identifiants d'une URL sans perdre l'hote", () => {
    const result = redactText("remote: https://utilisateur:motdepasse@github.com/a/b.git");
    expect(result).not.toContain("motdepasse");
    expect(result).toContain("github.com");
  });

  it("masque un en-tete Authorization", () => {
    expect(redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).not.toContain(
      "abcdefghijklmnopqrstuvwxyz",
    );
  });

  it("masque une cle privee complete", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nMIIBVQ==\n-----END PRIVATE KEY-----";
    expect(redactText(`cle: ${key}`)).not.toContain("MIIBVQ==");
  });

  it("laisse le texte ordinaire intact", () => {
    const text = "build reussi en 12s, 240 tests passes";
    expect(redactText(text)).toBe(text);
  });
});
