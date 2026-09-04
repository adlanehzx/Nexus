import { describe, expect, it } from "vitest";
import {
  TokenService,
  generateSigningKeyPair,
  hashPassword,
  needsRehash,
  verifyPassword,
  assertPasswordAcceptable,
} from "../src/index.js";

/**
 * Jetons et mots de passe.
 *
 * Ce sont les deux endroits où une erreur ne se voit pas : un jeton mal vérifié
 * laisse entrer, un mot de passe mal haché laisse sortir. Les tests portent donc
 * autant sur les refus que sur les acceptations.
 */

const keys = generateSigningKeyPair();

function makeService(now = () => new Date("2026-09-02T10:00:00.000Z")) {
  return new TokenService({ privateKeyPem: keys.privateKeyPem, now });
}

describe("jetons d'accès", () => {
  it("émet un jeton que le service relit", () => {
    const service = makeService();
    const { token } = service.issueAccessToken({ userId: "u1", sessionId: "s1" });

    expect(service.verifyAccessToken(token)).toMatchObject({ sub: "u1", sid: "s1" });
  });

  it("refuse un jeton signé par une autre clé", () => {
    const other = new TokenService({ privateKeyPem: generateSigningKeyPair().privateKeyPem });
    const { token } = other.issueAccessToken({ userId: "u1", sessionId: "s1" });

    expect(() => makeService().verifyAccessToken(token)).toThrow(
      expect.objectContaining({ code: "TOKEN_INVALID" }),
    );
  });

  it("refuse un jeton dont la charge utile a été modifiée", () => {
    const service = makeService();
    const { token } = service.issueAccessToken({ userId: "u1", sessionId: "s1" });

    const [header, , signature] = token.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ sub: "admin", sid: "s1" })).toString("base64url");

    expect(() => service.verifyAccessToken(`${header}.${forged}.${signature}`)).toThrow(
      expect.objectContaining({ code: "TOKEN_INVALID" }),
    );
  });

  it("refuse un en-tête annonçant un autre algorithme", () => {
    // Confusion d'algorithme : un jeton `alg: none` doit être refusé avant même
    // qu'on regarde la signature.
    const service = makeService();
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "admin" })).toString("base64url");

    expect(() => service.verifyAccessToken(`${header}.${payload}.`)).toThrow(
      expect.objectContaining({ code: "TOKEN_INVALID" }),
    );
  });

  it("distingue un jeton expiré d'un jeton invalide", () => {
    // La distinction compte pour le client : rafraîchir suffit, il n'a pas à
    // redemander le mot de passe.
    let now = new Date("2026-09-02T10:00:00.000Z");
    const service = new TokenService({
      privateKeyPem: keys.privateKeyPem,
      accessTtlSeconds: 60,
      now: () => now,
    });

    const { token } = service.issueAccessToken({ userId: "u1", sessionId: "s1" });
    now = new Date("2026-09-02T10:05:00.000Z");

    expect(() => service.verifyAccessToken(token)).toThrow(
      expect.objectContaining({ code: "TOKEN_EXPIRED", retryable: true }),
    );
  });

  it("refuse une forme qui n'est pas un jeton", () => {
    const service = makeService();
    for (const invalid of ["", "abc", "a.b", "a.b.c.d"]) {
      expect(() => service.verifyAccessToken(invalid)).toThrow(
        expect.objectContaining({ code: "TOKEN_INVALID" }),
      );
    }
  });

  it("refuse un jeton d'appareil présenté comme jeton d'accès", () => {
    // Les deux surfaces sont séparées pour éviter la confusion de privilèges :
    // un appareil ne doit pas pouvoir agir comme l'utilisateur.
    const service = makeService();
    const { token } = service.issueDeviceToken({
      deviceId: "d1",
      userId: "u1",
      capabilities: ["terminal.execute"],
    });

    expect(() => service.verifyAccessToken(token)).toThrow(
      expect.objectContaining({ code: "TOKEN_INVALID" }),
    );
  });

  it("refuse un jeton d'accès présenté comme jeton d'appareil", () => {
    const service = makeService();
    const { token } = service.issueAccessToken({ userId: "u1", sessionId: "s1" });

    expect(() => service.verifyDeviceToken(token)).toThrow(
      expect.objectContaining({ code: "TOKEN_INVALID" }),
    );
  });

  it("refuse un émetteur ou une audience inattendus", () => {
    const foreign = new TokenService({
      privateKeyPem: keys.privateKeyPem,
      issuer: "autre",
    });
    const { token } = foreign.issueAccessToken({ userId: "u1", sessionId: "s1" });

    expect(() => makeService().verifyAccessToken(token)).toThrow(
      expect.objectContaining({ code: "TOKEN_INVALID" }),
    );
  });

  it("expose une clé publique qui vérifie sans pouvoir émettre", () => {
    // C'est la raison d'être d'EdDSA ici : la passerelle WebSocket vérifie, elle
    // n'émet pas.
    const service = makeService();
    expect(service.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(service.publicKeyPem).not.toContain("PRIVATE");
  });

  it("porte les capacités négociées dans le jeton d'appareil", () => {
    const service = makeService();
    const { token } = service.issueDeviceToken({
      deviceId: "d1",
      userId: "u1",
      capabilities: ["filesystem.read"],
    });

    expect(service.verifyDeviceToken(token)).toMatchObject({
      sub: "d1",
      userId: "u1",
      capabilities: ["filesystem.read"],
    });
  });
});

/**
 * Le hachage coûte volontairement cher — environ 350 ms par appel. C'est le
 * but : c'est ce qui rend une attaque hors ligne pénible. Les tests qui hachent
 * ont donc besoin de plus que le délai par défaut de Vitest.
 */
describe("mots de passe", { timeout: 30_000 }, () => {
  it("vérifie un mot de passe correct", async () => {
    const encoded = await hashPassword("un mot de passe correct");
    await expect(verifyPassword("un mot de passe correct", encoded)).resolves.toBe(true);
  });

  it("refuse un mot de passe incorrect", async () => {
    const encoded = await hashPassword("un mot de passe correct");
    await expect(verifyPassword("un autre mot de passe", encoded)).resolves.toBe(false);
  });

  it("produit une empreinte différente à chaque fois", async () => {
    // Sel aléatoire : deux utilisateurs avec le même mot de passe n'ont pas la
    // même empreinte, et une table précalculée ne sert à rien.
    const a = await hashPassword("le meme mot de passe");
    const b = await hashPassword("le meme mot de passe");
    expect(a).not.toBe(b);
  });

  it("inscrit ses paramètres dans l'empreinte", async () => {
    const encoded = await hashPassword("un mot de passe correct");
    expect(encoded.split("$").slice(0, 4)).toEqual(["scrypt", "65536", "8", "1"]);
  });

  it("refuse un mot de passe trop court", () => {
    expect(() => assertPasswordAcceptable("court")).toThrow(
      expect.objectContaining({ code: "PASSWORD_TOO_WEAK" }),
    );
  });

  it("refuse un mot de passe démesuré sans le recopier dans l'erreur", () => {
    // Sans borne haute, une chaîne d'un mégaoctet ferait travailler scrypt
    // pendant des secondes — un déni de service à coût nul.
    const long = "x".repeat(2_000);
    let caught: { context?: Record<string, unknown> } | undefined;
    try {
      assertPasswordAcceptable(long);
    } catch (cause) {
      caught = cause as { context?: Record<string, unknown> };
    }

    expect(JSON.stringify(caught?.context)).not.toContain("xxxx");
  });

  it("retourne faux sur une empreinte corrompue au lieu de lever", async () => {
    // Un enregistrement corrompu ne doit pas produire une erreur différente d'un
    // mauvais mot de passe : la réponse elle-même renseignerait un attaquant.
    for (const broken of ["", "pasdutout", "scrypt$x$y$z$a$b", "bcrypt$1$2$3$4$5"]) {
      await expect(verifyPassword("un mot de passe correct", broken)).resolves.toBe(false);
    }
  });

  it("refuse une empreinte annonçant des paramètres absurdes", async () => {
    // Une empreinte falsifiée avec N = 2^30 ferait épuiser la mémoire du serveur
    // à la première tentative de connexion.
    const absurd = `scrypt$${String(1 << 25)}$8$1$c2VsCg$Y2xlCg`;
    await expect(verifyPassword("un mot de passe correct", absurd)).resolves.toBe(false);
  });

  it("signale une empreinte à recalculer", async () => {
    expect(needsRehash(`scrypt$16384$8$1$c2VsCg$Y2xlCg`)).toBe(true);
    expect(needsRehash(await hashPassword("un mot de passe correct"))).toBe(false);
  });
});
