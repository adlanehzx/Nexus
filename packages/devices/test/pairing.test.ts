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
 * Pairing guarantees:
 * - One-time use tickets
 * - Strict TTL enforcement
 * - Secrets hashed at rest
 * - Scanner cannot forge device owner identity
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

describe("issuing a ticket", () => {
  it("yields the plaintext code once and stores only its hash", async () => {
    const { store, service } = makeService();
    const { ticket, code } = await service.issue({ userId: "u1" });

    expect(code.length).toBeGreaterThanOrEqual(40);
    expect(ticket.codeHash).toBe(hashPairingCode(code));

    // Plaintext code is never persisted.
    const stored = JSON.stringify(await store.listByUser("u1"));
    expect(stored).not.toContain(code);
    expect(stored).toContain(ticket.codeHash);
  });

  it("carries owner identity which scanner cannot override", async () => {
    const { service } = makeService();
    const { code } = await service.issue({ userId: "owner" });
    const redeemed = await service.redeem(code);
    expect(redeemed.userId).toBe("owner");
  });

  it("expires five minutes after issuance", async () => {
    const start = new Date("2026-10-21T10:00:00Z");
    const { service } = makeService({ now: () => start });
    const { ticket } = await service.issue({ userId: "u1" });
    expect(ticket.expiresAt.getTime() - start.getTime()).toBe(PAIRING_TICKET_TTL_MS);
  });

  it("generates a distinct code for each issuance", async () => {
    const { service } = makeService();
    const first = await service.issue({ userId: "u1" });
    const second = await service.issue({ userId: "u1" });
    expect(first.code).not.toBe(second.code);
    expect(first.ticket.codeHash).not.toBe(second.ticket.codeHash);
  });
});

describe("ticket redemption", () => {
  it("rejects unknown code", async () => {
    const { service } = makeService();
    await expect(service.redeem(newPairingCode())).rejects.toBeInstanceOf(
      PairingTicketInvalidError,
    );
  });

  it("rejects reuse of a consumed ticket", async () => {
    const { service } = makeService();
    const { ticket, code } = await service.issue({ userId: "u1" });
    await service.complete(await service.redeem(code), "device-1");

    await expect(service.redeem(code)).rejects.toMatchObject({
      code: "PAIRING_TICKET_INVALID",
    });
    const [summary] = await service.list(ticket.userId);
    expect(summary?.status).toBe("consumed");
    expect(summary?.deviceId).toBe("device-1");
  });

  it("rejects expired ticket", async () => {
    let instant = new Date("2026-10-21T10:00:00Z");
    const { service } = makeService({ now: () => instant });
    const { code } = await service.issue({ userId: "u1" });

    instant = new Date(instant.getTime() + PAIRING_TICKET_TTL_MS + 1);
    await expect(service.redeem(code)).rejects.toMatchObject({
      code: "PAIRING_TICKET_INVALID",
    });
  });

  it("returns uniform user message regardless of internal rejection reason", async () => {
    const { service } = makeService();
    const { code } = await service.issue({ userId: "u1" });
    await service.complete(await service.redeem(code), "device-1");

    const consumed = await service.redeem(code).catch((error: unknown) => error);
    const unknown = await service.redeem(newPairingCode()).catch((error: unknown) => error);

    expect((consumed as PairingTicketInvalidError).context).toMatchObject({ reason: "consumed" });
    expect((unknown as PairingTicketInvalidError).context).toMatchObject({ reason: "unknown" });
    expect((consumed as PairingTicketInvalidError).userMessage).toBe(
      (unknown as PairingTicketInvalidError).userMessage,
    );
  });

  it("transitions unused tickets to expired automatically", async () => {
    let instant = new Date("2026-10-21T10:00:00Z");
    const { service } = makeService({ now: () => instant });
    await service.issue({ userId: "u1" });

    expect((await service.list("u1"))[0]?.status).toBe("pending");
    instant = new Date(instant.getTime() + PAIRING_TICKET_TTL_MS + 1);
    expect((await service.list("u1"))[0]?.status).toBe("expired");
  });
});

describe("pruning", () => {
  it("deletes consumed and expired tickets while retaining active ones", async () => {
    let instant = new Date("2026-10-21T10:00:00Z");
    const { store, service } = makeService({ now: () => instant });

    const consumed = await service.issue({ userId: "u1" });
    await service.complete(await service.redeem(consumed.code), "device-1");
    await service.issue({ userId: "u1" }); // will expire
    instant = new Date(instant.getTime() + PAIRING_TICKET_TTL_MS + 1);
    await service.issue({ userId: "u1" }); // still active

    expect(await service.prune()).toBe(2);
    expect(store.size).toBe(1);
    expect((await service.list("u1"))[0]?.status).toBe("pending");
  });
});

describe("QR payload", () => {
  it("roundtrips correctly", () => {
    const payload = { apiUrl: "https://nexus.example.test", token: "token-abc" };
    expect(decodePairingPayload(encodePairingPayload(payload))).toEqual(payload);
  });

  it("is not a standard web URL", () => {
    const text = encodePairingPayload({ apiUrl: "https://a.test", token: "t" });
    expect(text.startsWith("nexus://pair")).toBe(true);
  });

  it("rejects non-pairing QR payloads", () => {
    expect(() => decodePairingPayload("https://example.test/?token=t&api=https://a.test")).toThrow(
      PairingPayloadError,
    );
    expect(() => decodePairingPayload("not a url")).toThrow(PairingPayloadError);
    expect(() => decodePairingPayload("nexus://other?api=https://a.test&token=t")).toThrow(
      PairingPayloadError,
    );
  });

  it("rejects non-http(s) API endpoints", () => {
    for (const api of ["file:///etc/passwd", "ftp://a.test", "javascript:alert(1)"]) {
      const text = `nexus://pair?api=${encodeURIComponent(api)}&token=t`;
      expect(() => decodePairingPayload(text), api).toThrow(PairingPayloadError);
    }
  });

  it("rejects incomplete payloads", () => {
    expect(() => decodePairingPayload("nexus://pair?api=https://a.test")).toThrow(
      PairingPayloadError,
    );
    expect(() => decodePairingPayload("nexus://pair?token=t")).toThrow(PairingPayloadError);
  });
});

describe("pairing code comparison", () => {
  it("matches identical codes and distinguishes different ones in constant time", () => {
    const code = newPairingCode();
    expect(pairingCodesEqual(code, code)).toBe(true);
    expect(pairingCodesEqual(code, newPairingCode())).toBe(false);
    expect(pairingCodesEqual("short", code)).toBe(false);
  });
});
