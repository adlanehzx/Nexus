import { describe, expect, it } from "vitest";
import { isUuid, newCorrelationId, uuidv7, uuidv7Timestamp } from "../src/ids.js";

describe("uuidv7", () => {
  it("produit un UUID valide", () => {
    expect(isUuid(uuidv7())).toBe(true);
  });

  it("porte la version 7 et le variant RFC 4122", () => {
    const id = uuidv7();
    // 13e caractère hexadécimal = version ; 17e = variant (8, 9, a ou b).
    expect(id[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("encode l'horodatage fourni", () => {
    const now = 1_767_225_600_000; // 2026-01-01T00:00:00Z
    expect(uuidv7Timestamp(uuidv7(now))).toBe(now);
  });

  it("est croissant lexicographiquement dans le temps", () => {
    // C'est toute la raison d'être de la v7 : des clés primaires triées par
    // insertion, donc un index B-tree qui ne se fragmente pas.
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_800_000_000_000);
    expect(early < late).toBe(true);
  });

  it("ne collisionne pas sur un même horodatage", () => {
    const now = Date.now();
    const ids = new Set(Array.from({ length: 5_000 }, () => uuidv7(now)));
    expect(ids.size).toBe(5_000);
  });
});

describe("isUuid", () => {
  it("rejette ce qui n'est pas un UUID", () => {
    for (const value of ["", "pas-un-uuid", "12345678-1234-1234-1234-12345678901"]) {
      expect(isUuid(value)).toBe(false);
    }
  });
});

describe("newCorrelationId", () => {
  it("produit des identifiants uniques et valides", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(isUuid(a)).toBe(true);
    expect(a).not.toBe(b);
  });
});
