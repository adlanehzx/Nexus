import { describe, expect, it } from "vitest";
import { TokenService, generateSigningKeyPair } from "@nexus/auth";
import {
  InMemoryMissionGrantRegistry,
  MissionGrantService,
} from "../src/services/mission-grants.js";

/**
 * Cycle de vie d'une assertion de mission.
 *
 * Trois défauts motivent ce fichier, et chacun a son test :
 *
 *  1. une assertion expirait au bout de vingt-quatre heures sans que rien ne la
 *     renouvelle, donc une mission plus longue devenait irreprenable ;
 *  2. le `jti` identifiait l'assertion sans qu'aucun registre ne soit consulté,
 *     donc une assertion volée restait exploitable jusqu'à son terme ;
 *  3. rien ne retirait les assertions d'une mission terminée.
 *
 * Tout est piloté par une **horloge injectée**. Faire autrement obligerait à
 * attendre des heures pour éprouver une expiration, et un test qu'on ne peut
 * pas lancer ne protège rien.
 */

const keys = generateSigningKeyPair();
const HOUR = 60 * 60 * 1000;

function build(options: { renewWithinMs?: number } = {}) {
  let instant = new Date("2026-10-20T08:00:00.000Z");
  const now = () => instant;
  const registry = new InMemoryMissionGrantRegistry();
  const service = new MissionGrantService({
    signer: new TokenService({ privateKeyPem: keys.privateKeyPem, now }),
    registry,
    now,
    ...(options.renewWithinMs === undefined ? {} : { renewWithinMs: options.renewWithinMs }),
  });
  const verifier = new TokenService({ privateKeyPem: keys.privateKeyPem, now });

  return {
    service,
    registry,
    verifier,
    // Fonction fléchée et non méthode : elle est déstructurée par chaque test,
    // donc détachée de son objet.
    advance: (ms: number) => {
      instant = new Date(instant.getTime() + ms);
    },
  };
}

const SCOPE = {
  userId: "11111111-1111-7111-8111-111111111111",
  service: "mission-engine",
  missionExternalKey: "nexus-mission-grants",
};

describe("émission et registre", () => {
  it("inscrit toute assertion émise", async () => {
    const { service, registry } = build();
    const granted = await service.issue(SCOPE);

    const recorded = await registry.find(granted.grantId);
    expect(recorded?.status).toBe("ACTIVE");
    expect(recorded?.missionExternalKey).toBe(SCOPE.missionExternalKey);
    expect(recorded?.expiresAt).toEqual(granted.expiresAt);
  });

  it("refuse une assertion signée mais absente du registre", async () => {
    const { service, verifier } = build();
    // Signature parfaitement valide : seule la trace manque. C'est le cas d'une
    // clé compromise, ou d'un enregistrement perdu — aucun des deux ne doit
    // ouvrir, d'où le refus par défaut.
    const orphan = verifier.issueMissionGrant(SCOPE);

    await expect(service.assertUsable(verifier.verifyMissionGrant(orphan.token))).rejects.toThrow(
      /registre/i,
    );
  });

  it("accepte une assertion active", async () => {
    const { service, verifier } = build();
    const granted = await service.issue(SCOPE);

    const claims = verifier.verifyMissionGrant(granted.token);
    await expect(service.assertUsable(claims)).resolves.toMatchObject({
      status: "ACTIVE",
      userId: SCOPE.userId,
    });
  });
});

describe("retrait", () => {
  it("refuse une assertion retirée alors que sa signature reste valide", async () => {
    const { service, verifier } = build();
    const granted = await service.issue(SCOPE);
    const claims = verifier.verifyMissionGrant(granted.token);

    expect(await service.retire(SCOPE.missionExternalKey)).toBe(1);

    // La signature n'a pas changé et l'assertion n'est pas expirée : c'est bien
    // le registre, et lui seul, qui ferme la porte.
    await expect(service.assertUsable(claims)).rejects.toThrow(/retirée/i);
  });

  it("retire toutes les assertions d'une mission, pas seulement la dernière", async () => {
    // La rotation en laisse plusieurs valides en même temps. Ne retirer que
    // celle qu'on a sous la main laisserait les autres ouvertes — c'est pour ça
    // que le retrait porte sur la mission.
    const { service, verifier, advance } = build({ renewWithinMs: 20 * HOUR });
    const first = await service.issue(SCOPE);
    advance(5 * HOUR);
    const rotated = await service.renewById(first.grantId);
    expect(rotated).toBeDefined();

    expect(await service.retire(SCOPE.missionExternalKey)).toBe(2);
    for (const token of [first.token, rotated!.token]) {
      await expect(service.assertUsable(verifier.verifyMissionGrant(token))).rejects.toThrow(
        /retirée/i,
      );
    }
  });

  it("distingue une fin de mission d'une révocation d'incident", async () => {
    const { service } = build();
    await service.issue(SCOPE);
    await service.retire(SCOPE.missionExternalKey, "REVOKED");

    const grants = await service.listByMission(SCOPE.missionExternalKey);
    expect(grants[0]?.status).toBe("REVOKED");
    expect(grants[0]?.retiredAt).not.toBeNull();
  });

  it("est idempotent et ne déplace pas la date de retrait", async () => {
    const { service, advance } = build();
    await service.issue(SCOPE);
    expect(await service.retire(SCOPE.missionExternalKey)).toBe(1);
    const first = (await service.listByMission(SCOPE.missionExternalKey))[0]?.retiredAt;

    advance(HOUR);
    // Le moteur peut redemander le retrait si son premier appel a échoué sur le
    // réseau : le second ne doit rien réécrire.
    expect(await service.retire(SCOPE.missionExternalKey)).toBe(0);
    expect((await service.listByMission(SCOPE.missionExternalKey))[0]?.retiredAt).toEqual(first);
  });
});

describe("expiration et rotation", () => {
  it("refuse une assertion expirée selon le registre", async () => {
    const { service, verifier, advance } = build();
    const granted = await service.issue(SCOPE);
    const claims = verifier.verifyMissionGrant(granted.token);

    advance(25 * HOUR);
    await expect(service.assertUsable(claims)).rejects.toThrow(/expirée/i);
  });

  it("ne renouvelle pas une assertion encore loin de son terme", async () => {
    const { service, advance } = build({ renewWithinMs: 8 * HOUR });
    const granted = await service.issue(SCOPE);

    advance(2 * HOUR);
    // Vingt-deux heures restantes : renouveler ici multiplierait les assertions
    // valides sans raison.
    expect(await service.renewById(granted.grantId)).toBeUndefined();
  });

  it("renouvelle dans la fenêtre, et la nouvelle assertion est exploitable", async () => {
    const { service, verifier, advance } = build({ renewWithinMs: 8 * HOUR });
    const granted = await service.issue(SCOPE);

    advance(17 * HOUR);
    const renewed = await service.renewById(granted.grantId);
    expect(renewed).toBeDefined();
    expect(renewed!.grantId).not.toBe(granted.grantId);
    expect(renewed!.expiresAt.getTime()).toBeGreaterThan(granted.expiresAt.getTime());

    await expect(
      service.assertUsable(verifier.verifyMissionGrant(renewed!.token)),
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("laisse l'ancienne assertion vivre jusqu'à son terme", async () => {
    const { service, verifier, advance } = build({ renewWithinMs: 8 * HOUR });
    const granted = await service.issue(SCOPE);
    const claims = verifier.verifyMissionGrant(granted.token);

    advance(17 * HOUR);
    await service.renewById(granted.grantId);

    // Retirer l'ancienne au moment de la rotation casserait toute requête déjà
    // en vol avec elle, pour un gain nul.
    await expect(service.assertUsable(claims)).resolves.toMatchObject({
      status: "ACTIVE",
    });
  });

  it("couvre une mission plus longue que la durée de vie d'une assertion", async () => {
    // Le scénario qui motive toute la rotation : une mission qui attend une
    // décision humaine pendant trois jours. Sans renouvellement, elle devenait
    // irreprenable au bout de vingt-quatre heures.
    const { service, verifier, advance } = build({ renewWithinMs: 8 * HOUR });
    let current = await service.issue(SCOPE);

    for (let elapsed = 0; elapsed < 72; elapsed += 6) {
      advance(6 * HOUR);
      const claims = verifier.verifyMissionGrant(current.token);
      // À chaque passage, l'assertion détenue doit encore ouvrir.
      await expect(service.assertUsable(claims)).resolves.toBeDefined();
      const renewed = await service.renewById(current.grantId);
      if (renewed !== undefined) current = renewed;
    }
  });

  it("ne renouvelle pas une assertion déjà retirée", async () => {
    const { service, advance } = build({ renewWithinMs: 8 * HOUR });
    const granted = await service.issue(SCOPE);
    await service.retire(SCOPE.missionExternalKey);

    advance(17 * HOUR);
    // Sans ce refus, le retrait serait contournable : il suffirait de demander
    // une rotation pour obtenir une assertion neuve et active.
    expect(await service.renewById(granted.grantId)).toBeUndefined();
  });
});
