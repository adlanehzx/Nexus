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
 * Assertions de mission.
 *
 * Cette surface existe pour qu'un service puisse agir *au nom* d'un
 * utilisateur sans jamais détenir ses droits. Les tests portent donc d'abord
 * sur ce qu'elle refuse : se faire passer pour un jeton d'accès, survivre à sa
 * mission, ou être forgée par qui ne possède que la clé publique.
 */
describe("assertions de mission", () => {
  it("émet une assertion que le service relit, portée à une mission", () => {
    const service = makeService();
    const { token, grantId } = service.issueMissionGrant({
      userId: "u1",
      service: "mission-engine",
      missionExternalKey: "nexus-abc-1",
    });

    expect(service.verifyMissionGrant(token)).toMatchObject({
      sub: "u1",
      svc: "mission-engine",
      mek: "nexus-abc-1",
      aud: "nexus-mission-grant",
      jti: grantId,
    });
  });

  it("refuse une assertion présentée comme jeton d'accès", () => {
    // La confusion de surfaces est le risque principal d'une troisième identité :
    // une assertion qui passerait pour un jeton d'accès donnerait les droits
    // complets du compte au lieu de la seule portée de la mission.
    const service = makeService();
    const { token } = service.issueMissionGrant({
      userId: "u1",
      service: "mission-engine",
      missionExternalKey: "nexus-abc-1",
    });

    expect(() => service.verifyAccessToken(token)).toThrow(/audience|claims/i);
  });

  it("refuse un jeton d'accès présenté comme assertion de mission", () => {
    const service = makeService();
    const { token } = service.issueAccessToken({ userId: "u1", sessionId: "s1" });

    expect(() => service.verifyMissionGrant(token)).toThrow(/claims de mission/i);
  });

  it("refuse une assertion signée par une autre clé", () => {
    const foreign = new TokenService({ privateKeyPem: generateSigningKeyPair().privateKeyPem });
    const { token } = foreign.issueMissionGrant({
      userId: "u1",
      service: "mission-engine",
      missionExternalKey: "nexus-abc-1",
    });

    expect(() => makeService().verifyMissionGrant(token)).toThrow();
  });

  it("expire l'assertion au terme de sa durée de vie", () => {
    let instant = new Date("2026-09-02T10:00:00.000Z");
    const service = new TokenService({
      privateKeyPem: keys.privateKeyPem,
      missionGrantTtlSeconds: 60,
      now: () => instant,
    });
    const { token } = service.issueMissionGrant({
      userId: "u1",
      service: "mission-engine",
      missionExternalKey: "nexus-abc-1",
    });

    expect(service.verifyMissionGrant(token)).toMatchObject({ sub: "u1" });
    instant = new Date("2026-09-02T10:01:01.000Z");
    expect(() => service.verifyMissionGrant(token)).toThrow(/expir/i);
  });

  it("lie l'assertion à une mission et à une seule", () => {
    const service = makeService();
    const first = service.issueMissionGrant({
      userId: "u1",
      service: "mission-engine",
      missionExternalKey: "nexus-abc-1",
    });
    const second = service.issueMissionGrant({
      userId: "u1",
      service: "mission-engine",
      missionExternalKey: "nexus-abc-2",
    });

    expect(service.verifyMissionGrant(first.token).mek).toBe("nexus-abc-1");
    expect(service.verifyMissionGrant(second.token).mek).toBe("nexus-abc-2");
    expect(first.grantId).not.toBe(second.grantId);
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

/**
 * Jetons de service.
 *
 * Quatrième surface. Elle existe parce que le port de Mission Engine n'était
 * protégé que par la boucle locale : suffisant pour une installation
 * personnelle sur une machine, insuffisant dès qu'il y a Docker, plusieurs
 * machines ou des workers distants.
 *
 * Les tests portent surtout sur la séparation : la même clé signe les quatre
 * sortes de jetons, et c'est l'audience qui empêche l'un de tenir le rôle d'un
 * autre.
 */
describe("jetons de service", () => {
  it("émet un jeton que le service relit pour la bonne audience", () => {
    const service = makeService();
    const { token } = service.issueServiceToken({
      service: "nexus-api",
      audience: "nexus-mission-engine",
    });

    expect(service.verifyServiceToken(token, "nexus-mission-engine")).toMatchObject({
      sub: "nexus-api",
      aud: "nexus-mission-engine",
    });
  });

  it("refuse un jeton présenté pour une autre audience", () => {
    const service = makeService();
    const { token } = service.issueServiceToken({
      service: "nexus-api",
      audience: "nexus-mission-engine",
    });

    // Signature valide, mais destiné à un autre service : sans ce refus, un
    // jeton émis pour un composant servirait à en piloter un autre.
    expect(() => service.verifyServiceToken(token, "nexus-autre-service")).toThrow(/audience/i);
  });

  it("ne tient pas lieu de jeton d'accès ni d'assertion de mission", () => {
    const service = makeService();
    const { token } = service.issueServiceToken({
      service: "nexus-api",
      audience: "nexus-mission-engine",
    });

    expect(() => service.verifyAccessToken(token)).toThrow();
    expect(() => service.verifyMissionGrant(token)).toThrow();
  });

  it("refuse une assertion de mission présentée comme jeton de service", () => {
    const service = makeService();
    const { token } = service.issueMissionGrant({
      userId: "u1",
      service: "mission-engine",
      missionExternalKey: "nexus-abc-1",
    });

    expect(() => service.verifyServiceToken(token, "nexus-mission-engine")).toThrow();
  });

  it("expire en quelques minutes, pas en heures", () => {
    let instant = new Date("2026-09-02T10:00:00.000Z");
    const service = new TokenService({
      privateKeyPem: keys.privateKeyPem,
      serviceTtlSeconds: 120,
      now: () => instant,
    });
    const { token } = service.issueServiceToken({
      service: "nexus-api",
      audience: "nexus-mission-engine",
    });

    instant = new Date("2026-09-02T10:01:00.000Z");
    expect(service.verifyServiceToken(token, "nexus-mission-engine")).toBeDefined();
    // Un jeton émis par appel n'a aucune raison de survivre à la requête :
    // c'est ce qui dispense d'un registre de révocation.
    instant = new Date("2026-09-02T10:03:00.000Z");
    expect(() => service.verifyServiceToken(token, "nexus-mission-engine")).toThrow(/expir/i);
  });

  it("refuse un jeton signé par une autre clé", () => {
    const foreign = new TokenService({ privateKeyPem: generateSigningKeyPair().privateKeyPem });
    const { token } = foreign.issueServiceToken({
      service: "nexus-api",
      audience: "nexus-mission-engine",
    });

    expect(() => makeService().verifyServiceToken(token, "nexus-mission-engine")).toThrow();
  });
});
