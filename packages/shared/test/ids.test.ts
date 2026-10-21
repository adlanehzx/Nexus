import { describe, expect, it } from "vitest";
import { isUuid, newCorrelationId, uuidv7, uuidv7Timestamp } from "../src/ids.js";

describe("uuidv7", () => {
  it("generates a valid UUID", () => {
    expect(isUuid(uuidv7())).toBe(true);
  });

  it("sets version 7 and RFC 4122 variant", () => {
    const id = uuidv7();
    // 13th hex char = version; 17th = variant (8, 9, a, or b).
    expect(id[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(id[19]);
  });

  it("encodes the provided timestamp", () => {
    const now = 1_767_225_600_000; // 2026-01-01T00:00:00Z
    expect(uuidv7Timestamp(uuidv7(now))).toBe(now);
  });

  it("is monotonically sortable over time", () => {
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_800_000_000_000);
    expect(early < late).toBe(true);
  });

  it("does not collide within identical timestamps", () => {
    const now = Date.now();
    const ids = new Set(Array.from({ length: 5_000 }, () => uuidv7(now)));
    expect(ids.size).toBe(5_000);
  });
});

describe("isUuid", () => {
  it("rejects non-UUID strings", () => {
    for (const value of ["", "not-a-uuid", "12345678-1234-1234-1234-12345678901"]) {
      expect(isUuid(value)).toBe(false);
    }
  });
});

describe("newCorrelationId", () => {
  it("produces valid and distinct unique identifiers", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(isUuid(a)).toBe(true);
    expect(a).not.toBe(b);
  });
});
