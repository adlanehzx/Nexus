import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactText, truncate } from "../src/index.js";

describe("redact", () => {
  it("masks keys indicating secrets", () => {
    const result = redact({
      user: "example",
      password: "hunter2",
      apiKey: "abc",
      access_token: "xyz",
      nested: { clientSecret: "s" },
    });

    expect(result).toEqual({
      user: "example",
      password: REDACTED,
      apiKey: REDACTED,
      access_token: REDACTED,
      nested: { clientSecret: REDACTED },
    });
  });

  it("masks values shaped like secrets regardless of key name", () => {
    const result = redact({
      note: "sk-abcdefghijklmnopqrstuvwxyz123456",
      other: "ghp_abcdefghijklmnopqrstuvwxyz1234",
      header: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
      innocent: "hello",
    });

    expect(result).toEqual({
      note: REDACTED,
      other: REDACTED,
      header: REDACTED,
      innocent: "hello",
    });
  });

  it("traverses arrays", () => {
    expect(redact([{ token: "a" }, { ok: "b" }])).toEqual([{ token: REDACTED }, { ok: "b" }]);
  });

  it("survives circular references", () => {
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;

    expect(() => redact(cyclic)).not.toThrow();
    expect(redact(cyclic)).toMatchObject({ name: "x", self: "[circular reference]" });
  });

  it("bounds recursion depth", () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };

    expect(JSON.stringify(redact(deep))).toContain("max depth reached");
  });

  it("leaves standard values intact", () => {
    expect(redact({ n: 1, b: true, nil: null, s: "text" })).toEqual({
      n: 1,
      b: true,
      nil: null,
      s: "text",
    });
  });
});

describe("truncate", () => {
  it("does not modify text within limit", () => {
    expect(truncate("short", 100)).toBe("short");
  });

  it("reports truncation marker and original length", () => {
    const result = truncate("x".repeat(500), 10);
    expect(result).toContain("truncated");
    expect(result).toContain("500");
  });
});

describe("redactText", () => {
  it("masks values following prefixed key names", () => {
    const result = redactText("env: DATABASE_PASSWORD=motdepassesecret");
    expect(result).not.toContain("motdepassesecret");
    expect(result).toContain(REDACTED);
  });

  it("masks quoted values without consuming remaining lines", () => {
    const result = redactText('api_key: "sk-quelquechosedelong123456"');
    expect(result).not.toContain("sk-quelquechosedelong123456");
    expect(result).toContain("api_key");
  });

  it("masks standalone token formats", () => {
    expect(redactText("clone https://github.com ghp_abcdefghijklmnopqrstuvwxyz01")).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz01",
    );
  });

  it("masks credentials in URLs while preserving hostnames", () => {
    const result = redactText("remote: https://user:secretpassword@github.com/a/b.git");
    expect(result).not.toContain("secretpassword");
    expect(result).toContain("github.com");
  });

  it("masks Authorization headers", () => {
    expect(redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).not.toContain(
      "abcdefghijklmnopqrstuvwxyz",
    );
  });

  it("masks private keys", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nMIIBVQ==\n-----END PRIVATE KEY-----";
    expect(redactText(`key: ${key}`)).not.toContain("MIIBVQ==");
  });

  it("leaves standard text untouched", () => {
    const text = "build succeeded in 12s, 240 tests passed";
    expect(redactText(text)).toBe(text);
  });
});
