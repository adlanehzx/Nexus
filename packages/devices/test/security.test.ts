import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { DeviceAuthenticationError, ReplayRejectedError } from "../src/errors.js";
import { DeviceSessionService, hashToken } from "../src/sessions.js";
import { NEXUS_EVENT_TYPES, nexusEventSchema, parseNexusEvent } from "@nexus/protocol";
import { DESKTOP, IPHONE, USER_ID, makeHarness, setupFleet } from "./fixtures.js";

/**
 * Authentification d'appareil, anti-rejeu, rotation.
 *
 * Le principe éprouvé ici : **un identifiant d'appareil n'authentifie rien**. Il
 * est public. Seule la possession de la clé privée fait foi.
 */

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    signNonce: (nonce: string) =>
      sign(null, Buffer.from(nonce, "utf8"), privateKey).toString("base64"),
  };
}

function makeService(h: ReturnType<typeof makeHarness>) {
  return new DeviceSessionService({ registry: h.registry, now: () => h.clock.now });
}

describe("authentification d'appareil", () => {
  it("ouvre une session sur un challenge correctement signé", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const keys = makeKeyPair();
    const service = makeService(h);

    const challenge = await service.createChallenge(DESKTOP.id);
    const { session, token } = await service.authenticate(
      { deviceId: DESKTOP.id, nonce: challenge.nonce, signature: keys.signNonce(challenge.nonce) },
      keys.publicPem,
    );

    expect(session.deviceId).toBe(DESKTOP.id);
    // Seule l'empreinte est conservée : le jeton n'est rendu qu'une fois.
    expect(session.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(session)).not.toContain(token);
    expect((await h.registry.requireDevice(DESKTOP.id)).authenticated).toBe(true);
  });

  it("refuse une signature invalide", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const keys = makeKeyPair();
    const intrus = makeKeyPair();
    const service = makeService(h);

    const challenge = await service.createChallenge(DESKTOP.id);

    await expect(
      service.authenticate(
        {
          deviceId: DESKTOP.id,
          nonce: challenge.nonce,
          signature: intrus.signNonce(challenge.nonce),
        },
        keys.publicPem,
      ),
    ).rejects.toBeInstanceOf(DeviceAuthenticationError);
  });

  it("consomme le nonce, même quand la signature est fausse", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const keys = makeKeyPair();
    const service = makeService(h);

    const challenge = await service.createChallenge(DESKTOP.id);
    await service
      .authenticate(
        { deviceId: DESKTOP.id, nonce: challenge.nonce, signature: "invalide" },
        keys.publicPem,
      )
      .catch(() => undefined);

    // Sinon un attaquant pourrait forcer le même nonce autant de fois qu'il veut.
    await expect(
      service.authenticate(
        {
          deviceId: DESKTOP.id,
          nonce: challenge.nonce,
          signature: keys.signNonce(challenge.nonce),
        },
        keys.publicPem,
      ),
    ).rejects.toBeInstanceOf(ReplayRejectedError);
  });

  it("refuse un challenge expiré", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const keys = makeKeyPair();
    const service = makeService(h);

    const challenge = await service.createChallenge(DESKTOP.id);
    h.clock.now = new Date(h.clock.now.getTime() + 120_000);

    await expect(
      service.authenticate(
        {
          deviceId: DESKTOP.id,
          nonce: challenge.nonce,
          signature: keys.signNonce(challenge.nonce),
        },
        keys.publicPem,
      ),
    ).rejects.toBeInstanceOf(ReplayRejectedError);
  });

  it("refuse d'authentifier un appareil révoqué", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    await h.registry.revokeDevice(DESKTOP.id);
    const service = makeService(h);

    await expect(service.createChallenge(DESKTOP.id)).rejects.toBeInstanceOf(
      DeviceAuthenticationError,
    );
  });

  it("refuse d'authentifier un appareil pas encore approuvé", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [], trusted: [] });
    const keys = makeKeyPair();
    const service = makeService(h);

    const challenge = await service.createChallenge(DESKTOP.id);

    await expect(
      service.authenticate(
        {
          deviceId: DESKTOP.id,
          nonce: challenge.nonce,
          signature: keys.signNonce(challenge.nonce),
        },
        keys.publicPem,
      ),
    ).rejects.toBeInstanceOf(DeviceAuthenticationError);
  });

  it("borne les capacités négociées à celles déclarées", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const keys = makeKeyPair();
    const service = makeService(h);

    const challenge = await service.createChallenge(DESKTOP.id);
    const { session } = await service.authenticate(
      {
        deviceId: DESKTOP.id,
        nonce: challenge.nonce,
        signature: keys.signNonce(challenge.nonce),
        // Le worker réclame une capacité qu'il n'a jamais enregistrée.
        capabilities: ["terminal.execute", "android.notification"],
      },
      keys.publicPem,
    );

    // Il ne peut pas s'accorder de pouvoirs en se connectant.
    expect(session.capabilities).toEqual(["terminal.execute"]);
  });
});

describe("sessions", () => {
  async function openSession(h: ReturnType<typeof makeHarness>) {
    const keys = makeKeyPair();
    const service = makeService(h);
    const challenge = await service.createChallenge(DESKTOP.id);
    const issued = await service.authenticate(
      { deviceId: DESKTOP.id, nonce: challenge.nonce, signature: keys.signNonce(challenge.nonce) },
      keys.publicPem,
    );
    return { service, issued };
  }

  it("résout un jeton valide", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const { service, issued } = await openSession(h);

    expect(await service.resolve(issued.token)).toBeDefined();
    expect(await service.resolve("jeton-inventé")).toBeUndefined();
  });

  it("invalide un jeton expiré", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const { service, issued } = await openSession(h);

    h.clock.now = new Date(h.clock.now.getTime() + 31 * 60_000);
    expect(await service.resolve(issued.token)).toBeUndefined();
  });

  it("invalide immédiatement les sessions d'un appareil révoqué", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const { service, issued } = await openSession(h);
    expect(await service.resolve(issued.token)).toBeDefined();

    await h.registry.revokeDevice(DESKTOP.id);

    // Une révocation prend effet sur une session déjà ouverte, pas à la
    // prochaine reconnexion.
    expect(await service.resolve(issued.token)).toBeUndefined();
  });

  it("fait tourner le jeton et invalide l'ancien", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const { service, issued } = await openSession(h);

    const rotated = await service.rotate(issued.token);

    expect(rotated.token).not.toBe(issued.token);
    expect(rotated.session.rotatedFromId).toBe(issued.session.id);
    // À aucun moment deux jetons ne sont valides pour le même appareil.
    expect(await service.resolve(issued.token)).toBeUndefined();
    expect(await service.resolve(rotated.token)).toBeDefined();
  });

  it("ferme toutes les sessions d'un appareil", async () => {
    const h = makeHarness();
    await setupFleet(h, { devices: [DESKTOP], online: [] });
    const { service, issued } = await openSession(h);

    expect(await service.revokeAllForDevice(DESKTOP.id)).toBe(1);
    expect(await service.resolve(issued.token)).toBeUndefined();
    expect((await h.registry.requireDevice(DESKTOP.id)).authenticated).toBe(false);
  });
});

describe("anti-rejeu", () => {
  it("refuse un identifiant de requête déjà vu", () => {
    const h = makeHarness();
    const service = makeService(h);

    service.assertNotReplayed("req-1", h.clock.now);
    expect(() => service.assertNotReplayed("req-1", h.clock.now)).toThrow(ReplayRejectedError);
  });

  it("refuse un horodatage hors de la fenêtre tolérée", () => {
    const h = makeHarness();
    const service = makeService(h);

    const vieux = new Date(h.clock.now.getTime() - 5 * 60_000);
    expect(() => service.assertNotReplayed("req-2", vieux)).toThrow(ReplayRejectedError);
  });

  it("compare les jetons en temps constant", () => {
    expect(DeviceSessionService.tokensMatch("abc", "abc")).toBe(true);
    expect(DeviceSessionService.tokensMatch("abc", "abd")).toBe(false);
    // Longueurs différentes : refus sans comparaison, donc sans fuite de temps.
    expect(DeviceSessionService.tokensMatch("abc", "abcd")).toBe(false);
  });
});

describe("contrat d'événements", () => {
  it("expose toutes les familles annoncées", () => {
    const familles = new Set(NEXUS_EVENT_TYPES.map((t) => t.split(".")[0]));
    expect([...familles].sort()).toEqual([
      "agent",
      "confirmation",
      "device",
      "notification",
      "task",
      "worker",
    ]);
  });

  it("valide un événement bien formé", () => {
    const event = nexusEventSchema.parse({
      v: 1,
      id: "evt-1",
      type: "task.started",
      at: "2026-09-02T10:00:00.000Z",
      userId: USER_ID,
      correlationId: "corr-1",
      originClientDeviceId: IPHONE.id,
      taskId: "task-1",
    });

    expect(event.type).toBe("task.started");
    expect(event.originClientDeviceId).toBe(IPHONE.id);
  });

  it("refuse une version de schéma différente", () => {
    const result = nexusEventSchema.safeParse({
      v: 2,
      id: "evt-1",
      type: "task.started",
      at: "2026-09-02T10:00:00.000Z",
      userId: USER_ID,
      correlationId: "c",
      originClientDeviceId: null,
      taskId: "t",
    });
    expect(result.success).toBe(false);
  });

  it("ignore un type inconnu au lieu de lever", () => {
    // C'est ce qui permet d'ajouter des événements sans casser un client déjà
    // déployé sur le magasin d'applications.
    expect(
      parseNexusEvent({
        v: 1,
        id: "e",
        type: "quelque.chose.de.futur",
        at: "2026-09-02T10:00:00.000Z",
        userId: USER_ID,
        correlationId: "c",
        originClientDeviceId: null,
      }),
    ).toBeUndefined();
  });
});
