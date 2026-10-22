import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConnectorConfigError, parseConnectorConfig, readConnectorConfig } from "../src/config.js";

const EXAMPLE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "config",
  "connector.example.json",
);

function publicKeyPem(): string {
  return generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
}

function validConfig() {
  return { clients: [{ clientId: "nexus-desktop", publicKey: publicKeyPem() }] };
}

describe("connector configuration", () => {
  it("loads the shipped example", async () => {
    // A generated example that does not load is worse than no example: it
    // teaches a shape that does not work. `turbo.json` declares `config/**` as
    // an input to the test task so this check cannot pass from cache after the
    // example changes.
    await expect(readConnectorConfig(EXAMPLE_PATH)).resolves.toBeDefined();
  });

  it("ships an example that carries no private key", async () => {
    const raw = await readFile(EXAMPLE_PATH, "utf8");

    expect(raw).not.toContain("PRIVATE KEY");
    expect(raw.toLowerCase()).not.toContain("secret");
  });

  it("applies the documented defaults", () => {
    const config = parseConnectorConfig(validConfig());

    expect(config.listen).toEqual({ kind: "loopback", port: 8787 });
    expect(config.acceptanceWindowMs).toBe(30_000);
    expect(config.clockSkewMs).toBe(5_000);
  });

  it("refuses a private key where a public one belongs", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    expect(() => parseConnectorConfig({ clients: [{ clientId: "c", publicKey: pem }] })).toThrow(
      ConnectorConfigError,
    );
  });

  it("refuses something that is not a key at all", () => {
    expect(() =>
      parseConnectorConfig({ clients: [{ clientId: "c", publicKey: "hunter2" }] }),
    ).toThrow(ConnectorConfigError);
  });

  it("refuses a field nobody declared", () => {
    // Including, specifically, the shape somebody will eventually try.
    expect(() => parseConnectorConfig({ ...validConfig(), sharedSecret: "let-me-in" })).toThrow(
      ConnectorConfigError,
    );
  });

  it("refuses a listen target that is not local", () => {
    expect(() =>
      parseConnectorConfig({
        ...validConfig(),
        listen: { kind: "tcp", host: "0.0.0.0", port: 80 },
      }),
    ).toThrow(ConnectorConfigError);
  });

  it("accepts an empty client list, which accepts nobody", () => {
    // Not an error: a connector with no clients configured is closed, which is
    // the right default for something that runs local binaries.
    expect(parseConnectorConfig({ clients: [] }).clients).toEqual([]);
  });

  it("names the offending path without quoting its value", () => {
    try {
      parseConnectorConfig({ clients: [{ clientId: "c", publicKey: "not-a-key-but-sensitive" }] });
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as ConnectorConfigError).message).toContain("clients.0.publicKey");
      expect((error as ConnectorConfigError).message).not.toContain("not-a-key-but-sensitive");
    }
  });

  it("reports a missing file rather than starting with no clients", async () => {
    await expect(readConnectorConfig("/nonexistent/connector.json")).rejects.toThrow(
      ConnectorConfigError,
    );
  });
});
