import { describe, expect, it } from "vitest";
import {
  InMemoryPairingTicketStore,
  PairingService,
  PairingPayloadError,
  PairingTicketInvalidError,
  PAIRING_TICKET_TTL_MS,
  decodePairingPayload,
  encodePairingPayload,
  hashPairingCode,
  newPairingCode,
  pairingCodesEqual,
} from "../src/pairing.js";

/**
 * Ce qui est éprouvé ici est la **promesse**, pas l'implémentation : un ticket
 * ne sert qu'une fois, ne survit pas à sa durée de vie, n'est jamais au repos
 * en clair, et ne laisse pas son porteur choisir le propriétaire de l'appareil.
 */

function makeService(options: { now?: () => Date; code?: string } = {}) {
  const store = new InMemoryPairingTicketStore();
  const service = new PairingService({
    store,
    ...(options.now ? { now: options.now } : {}),
    ...(options.code === undefined ? {} : { randomCode: () => options.code! }),
  });
  return { store, service };
}

describe("émission d'un ticket", () => {
  it("rend le code une seule fois et ne stocke que son empreinte", async () => {
    const { store, service } = makeService();
    const { ticket, code } = await service.issue({ userId: "u1" });

    expect(code.length).toBeGreaterThanOrEqual(40);
    expect(ticket.codeHash).toBe(hashPairingCode(code));

    // Le point qui compte : le code en clair n'est nulle part dans le magasin.
    const stored = JSON.stringify(await store.listByUser("u1"));
    expect(stored).not.toContain(code);
    expect(stored).toContain(ticket.codeHash);
  });

  it("porte l'identité du propriétaire, que le scanneur ne choisit pas", async () => {
    const { service } = makeService();
    const { code } = await service.issue({ userId: "proprietaire" });
    const redeemed = await service.redeem(code);
    expect(redeemed.userId).toBe("proprietaire");
  });

  it("expire cinq minutes après son émission", async () => {
    const start = new Date("2026-10-21T10:00:00Z");
    const { service } = makeService({ now: () => start });
    const { ticket } = await service.issue({ userId: "u1" });
    expect(ticket.expiresAt.getTime() - start.getTime()).toBe(PAIRING_TICKET_TTL_MS);
  });

  it("tire un code différent à chaque émission", async () => {
    const { service } = makeService();
    const first = await service.issue({ userId: "u1" });
    const second = await service.issue({ userId: "u1" });
    expect(first.code).not.toBe(second.code);
    expect(first.ticket.codeHash).not.toBe(second.ticket.codeHash);
  });
});

describe("usage d'un ticket", () => {
  it("refuse un code inconnu", async () => {
    const { service } = makeService();
    await expect(service.redeem(newPairingCode())).rejects.toBeInstanceOf(
      PairingTicketInvalidError,
    );
  });

  it("refuse un second usage", async () => {
    const { service } = makeService();
    const { ticket, code } = await service.issue({ userId: "u1" });
    await service.complete(await service.redeem(code), "appareil-1");

    await expect(service.redeem(code)).rejects.toMatchObject({
      code: "PAIRING_TICKET_INVALID",
    });
    const [summary] = await service.list(ticket.userId);
    expect(summary?.status).toBe("consumed");
    expect(summary?.deviceId).toBe("appareil-1");
  });

  it("refuse un ticket périmé", async () => {
    let instant = new Date("2026-10-21T10:00:00Z");
    const { service } = makeService({ now: () => instant });
    const { code } = await service.issue({ userId: "u1" });

    instant = new Date(instant.getTime() + PAIRING_TICKET_TTL_MS + 1);
    await expect(service.redeem(code)).rejects.toMatchObject({
      code: "PAIRING_TICKET_INVALID",
    });
  });

  it("ne dit pas au porteur pourquoi son code est refusé", async () => {
    const { service } = makeService();
    const { code } = await service.issue({ userId: "u1" });
    await service.complete(await service.redeem(code), "appareil-1");

    const consumed = await service.redeem(code).catch((error: unknown) => error);
    const unknown = await service.redeem(newPairingCode()).catch((error: unknown) => error);

    // Deux motifs distincts dans le contexte, un seul message pour le porteur :
    // « expiré » apprendrait à qui tâtonne qu'il a touché un vrai ticket.
    expect((consumed as PairingTicketInvalidError).context).toMatchObject({ reason: "consumed" });
    expect((unknown as PairingTicketInvalidError).context).toMatchObject({ reason: "unknown" });
    expect((consumed as PairingTicketInvalidError).userMessage).toBe(
      (unknown as PairingTicketInvalidError).userMessage,
    );
  });

  it("l'état d'un ticket non utilisé bascule à « expiré » sans intervention", async () => {
    let instant = new Date("2026-10-21T10:00:00Z");
    const { service } = makeService({ now: () => instant });
    await service.issue({ userId: "u1" });

    expect((await service.list("u1"))[0]?.status).toBe("pending");
    instant = new Date(instant.getTime() + PAIRING_TICKET_TTL_MS + 1);
    expect((await service.list("u1"))[0]?.status).toBe("expired");
  });
});

describe("nettoyage", () => {
  it("efface les tickets consommés et périmés, garde ceux en cours", async () => {
    let instant = new Date("2026-10-21T10:00:00Z");
    const { store, service } = makeService({ now: () => instant });

    const consumed = await service.issue({ userId: "u1" });
    await service.complete(await service.redeem(consumed.code), "appareil-1");
    await service.issue({ userId: "u1" }); // périmera
    instant = new Date(instant.getTime() + PAIRING_TICKET_TTL_MS + 1);
    await service.issue({ userId: "u1" }); // encore valable

    expect(await service.prune()).toBe(2);
    expect(store.size).toBe(1);
    expect((await service.list("u1"))[0]?.status).toBe("pending");
  });
});

describe("charge utile du QR", () => {
  it("fait l'aller-retour", () => {
    const payload = { apiUrl: "https://nexus.exemple.test", token: "jeton-abc" };
    expect(decodePairingPayload(encodePairingPayload(payload))).toEqual(payload);
  });

  it("n'est pas une URL web", () => {
    const text = encodePairingPayload({ apiUrl: "https://a.test", token: "t" });
    expect(text.startsWith("nexus://pair")).toBe(true);
  });

  it("refuse un QR qui n'est pas un QR d'appairage", () => {
    expect(() => decodePairingPayload("https://exemple.test/?token=t&api=https://a.test")).toThrow(
      PairingPayloadError,
    );
    expect(() => decodePairingPayload("pas une url")).toThrow(PairingPayloadError);
    expect(() => decodePairingPayload("nexus://autre?api=https://a.test&token=t")).toThrow(
      PairingPayloadError,
    );
  });

  it("refuse une adresse d'API qui n'est pas http(s)", () => {
    // Le QR est une donnée : sans ce garde-fou, il choisirait où l'appareil
    // envoie sa clé publique.
    for (const api of ["file:///etc/passwd", "ftp://a.test", "javascript:alert(1)"]) {
      const text = `nexus://pair?api=${encodeURIComponent(api)}&token=t`;
      expect(() => decodePairingPayload(text), api).toThrow(PairingPayloadError);
    }
  });

  it("refuse une charge utile incomplète", () => {
    expect(() => decodePairingPayload("nexus://pair?api=https://a.test")).toThrow(
      PairingPayloadError,
    );
    expect(() => decodePairingPayload("nexus://pair?token=t")).toThrow(PairingPayloadError);
  });
});

describe("comparaison de codes", () => {
  it("reconnaît deux codes identiques et distingue les autres", () => {
    const code = newPairingCode();
    expect(pairingCodesEqual(code, code)).toBe(true);
    expect(pairingCodesEqual(code, newPairingCode())).toBe(false);
    // Longueurs différentes : la comparaison ne doit pas lever.
    expect(pairingCodesEqual("court", code)).toBe(false);
  });
});
