import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConnectorAdminError,
  connectorStatus,
  defaultConfigPath,
  initConnector,
  keyFingerprint,
  registerClientKey,
  revokeClientKey,
  setClientEnabled,
} from "../src/admin.js";
import { RequestAuthenticator } from "../src/auth.js";
import { authenticatorClientsFrom, parseConnectorConfig } from "../src/config.js";
import { canonicalRequestBytes } from "../src/protocol.js";
import { createTestClient } from "./client.js";

/**
 * The operations an installer will drive, and what they refuse.
 *
 * Every test goes through the public functions against a real file, because
 * the point of this module is that the installer, a dashboard and the tests
 * cannot disagree about what a valid key is.
 */

const posixOnly = process.platform === "win32" ? describe.skip : describe;

async function freshConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-admin-"));
  return defaultConfigPath(join(dir, "state"));
}

function publicKeyPem(): string {
  return generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
}

posixOnly("initialising a connector", () => {
  it("creates a configuration that accepts nobody", async () => {
    const configPath = await freshConfigPath();

    const status = await initConnector({ configPath });

    // Closed by default: an installer that has not registered a client should
    // leave a connector that refuses everything, not one waiting to be claimed.
    expect(status.initialised).toBe(true);
    expect(status.clients).toEqual([]);
    expect(status.closed).toBe(true);
  });

  it("writes a configuration the connector itself accepts", async () => {
    const configPath = await freshConfigPath();
    await initConnector({ configPath });

    const raw = await readFile(configPath, "utf8");

    expect(() => parseConnectorConfig(JSON.parse(raw))).not.toThrow();
  });

  it("keeps the configuration readable only by its owner", async () => {
    const configPath = await freshConfigPath();
    await initConnector({ configPath });

    expect(((await stat(configPath)).mode & 0o777).toString(8)).toBe("600");
  });

  it("refuses to overwrite an existing configuration", async () => {
    const configPath = await freshConfigPath();
    await initConnector({ configPath });

    // Otherwise an installer re-run wipes the keys somebody registered last
    // month.
    await expect(initConnector({ configPath })).rejects.toThrow(ConnectorAdminError);
  });

  it("reports an absent connector as uninitialised and closed", async () => {
    const status = await connectorStatus(await freshConfigPath());

    expect(status.initialised).toBe(false);
    expect(status.closed).toBe(true);
  });
});

posixOnly("registering and rotating keys", () => {
  it("registers a key and reports that the client can authenticate", async () => {
    const configPath = await freshConfigPath();
    await initConnector({ configPath });

    const status = await registerClientKey({
      configPath,
      clientId: "nexus-desktop",
      publicKey: publicKeyPem(),
      label: "laptop",
    });

    expect(status.clients).toHaveLength(1);
    expect(status.clients[0]?.canAuthenticate).toBe(true);
    expect(status.closed).toBe(false);
  });

  it("never reports the key itself", async () => {
    const configPath = await freshConfigPath();
    await initConnector({ configPath });
    const publicKey = publicKeyPem();

    const status = await registerClientKey({ configPath, clientId: "c", publicKey });

    // An operator confirming "the key I registered is the one in use" needs to
    // compare, not to read; a full key in a terminal ends up in a screenshot.
    expect(JSON.stringify(status)).not.toContain("BEGIN PUBLIC KEY");
    expect(status.clients[0]?.keys[0]?.fingerprint).toBe(keyFingerprint(publicKey));
  });

  it("refuses a private key", async () => {
    const configPath = await freshConfigPath();
    await initConnector({ configPath });
    const privatePem = generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();

    await expect(
      registerClientKey({ configPath, clientId: "c", publicKey: privatePem }),
    ).rejects.toThrow();
  });

  it("refuses the same key twice", async () => {
    const configPath = await freshConfigPath();
    await initConnector({ configPath });
    const publicKey = publicKeyPem();
    await registerClientKey({ configPath, clientId: "c", publicKey });

    // An installer may be re-run; a duplicate entry would then have to be
    // revoked twice.
    await expect(registerClientKey({ configPath, clientId: "c", publicKey })).rejects.toThrow(
      ConnectorAdminError,
    );
  });

  it("keeps both keys valid during a rotation", async () => {
    const configPath = await freshConfigPath();
    await initConnector({ configPath });
    const old = publicKeyPem();
    const replacement = publicKeyPem();
    await registerClientKey({ configPath, clientId: "c", publicKey: old });

    const status = await registerClientKey({ configPath, clientId: "c", publicKey: replacement });

    // The overlap is the whole reason rotation needs two slots: a client
    // cannot swap its key at the same instant the connector does.
    expect(status.clients[0]?.keys.filter((key) => key.usable)).toHaveLength(2);
  });

  it("refuses a revoked key afterwards", async () => {
    const configPath = await freshConfigPath();
    await initConnector({ configPath });
    const publicKey = publicKeyPem();
    await registerClientKey({ configPath, clientId: "c", publicKey });

    const status = await revokeClientKey({
      configPath,
      clientId: "c",
      fingerprint: keyFingerprint(publicKey),
    });

    expect(status.clients[0]?.keys[0]?.usable).toBe(false);
    expect(status.clients[0]?.canAuthenticate).toBe(false);
    expect(status.closed).toBe(true);
  });

  it("keeps a revoked entry rather than deleting it", async () => {
    const configPath = await freshConfigPath();
    await initConnector({ configPath });
    const publicKey = publicKeyPem();
    await registerClientKey({ configPath, clientId: "c", publicKey });

    const status = await revokeClientKey({
      configPath,
      clientId: "c",
      fingerprint: keyFingerprint(publicKey),
    });

    // Someone reading this file after an incident needs to see that a key was
    // withdrawn and when, which a deletion hides.
    expect(status.clients[0]?.keys).toHaveLength(1);
    expect(status.clients[0]?.keys[0]?.revokedAt).not.toBeNull();
  });

  it("refuses to revoke a key that was never registered", async () => {
    const configPath = await freshConfigPath();
    await initConnector({ configPath });
    await registerClientKey({ configPath, clientId: "c", publicKey: publicKeyPem() });

    await expect(
      revokeClientKey({ configPath, clientId: "c", fingerprint: "0000000000000000" }),
    ).rejects.toThrow(ConnectorAdminError);
  });

  it("refuses to act on an unknown client", async () => {
    const configPath = await freshConfigPath();
    await initConnector({ configPath });

    await expect(
      revokeClientKey({ configPath, clientId: "ghost", fingerprint: "0000000000000000" }),
    ).rejects.toThrow(ConnectorAdminError);
    await expect(
      setClientEnabled({ configPath, clientId: "ghost", enabled: false }),
    ).rejects.toThrow(ConnectorAdminError);
  });

  it("refuses to mutate a connector that was never initialised", async () => {
    const configPath = await freshConfigPath();

    await expect(
      registerClientKey({ configPath, clientId: "c", publicKey: publicKeyPem() }),
    ).rejects.toThrow(ConnectorAdminError);
  });

  it("disables a client without touching its keys", async () => {
    const configPath = await freshConfigPath();
    await initConnector({ configPath });
    const publicKey = publicKeyPem();
    await registerClientKey({ configPath, clientId: "c", publicKey });

    const disabled = await setClientEnabled({ configPath, clientId: "c", enabled: false });
    expect(disabled.clients[0]?.canAuthenticate).toBe(false);
    expect(disabled.clients[0]?.keys[0]?.revokedAt).toBeNull();

    // Reversible, which is the difference from revocation.
    const reenabled = await setClientEnabled({ configPath, clientId: "c", enabled: true });
    expect(reenabled.clients[0]?.canAuthenticate).toBe(true);
  });

  it("migrates a legacy single-key client without losing the key", async () => {
    const configPath = await freshConfigPath();
    const legacy = publicKeyPem();
    await initConnector({ configPath });
    // Simulates a configuration written before rotation existed.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      configPath,
      JSON.stringify({ clients: [{ clientId: "c", publicKey: legacy }] }),
      "utf8",
    );

    const status = await registerClientKey({
      configPath,
      clientId: "c",
      publicKey: publicKeyPem(),
    });

    // Additive migration: the old key keeps working while the new one is added.
    const fingerprints = status.clients[0]?.keys.map((key) => key.fingerprint) ?? [];
    expect(fingerprints).toContain(keyFingerprint(legacy));
    expect(fingerprints).toHaveLength(2);
  });
});

posixOnly("what the authenticator accepts matches what status reports", () => {
  /** Signs a request and asks the authenticator built from the config file. */
  async function verifies(configPath: string, client: ReturnType<typeof createTestClient>) {
    const raw = await readFile(configPath, "utf8");
    const config = parseConnectorConfig(JSON.parse(raw));
    const authenticator = new RequestAuthenticator({
      clients: authenticatorClientsFrom(config),
    });
    const request = client.sign({ method: "health" });
    try {
      authenticator.verify({
        clientId: request.clientId,
        requestId: request.requestId,
        issuedAt: request.issuedAt,
        nonce: request.nonce,
        signature: request.signature,
        canonical: canonicalRequestBytes({
          protocolVersion: request.protocolVersion,
          method: request.params.method,
          requestId: request.requestId,
          issuedAt: request.issuedAt,
          nonce: request.nonce,
          clientId: request.clientId,
          params: request.params,
        }),
      });
      return true;
    } catch {
      return false;
    }
  }

  it("accepts a registered client and refuses it once revoked", async () => {
    const configPath = await freshConfigPath();
    const client = createTestClient("nexus-desktop");
    await initConnector({ configPath });
    await registerClientKey({
      configPath,
      clientId: client.clientId,
      publicKey: client.publicKey,
    });

    expect(await verifies(configPath, client)).toBe(true);

    await revokeClientKey({
      configPath,
      clientId: client.clientId,
      fingerprint: keyFingerprint(client.publicKey),
    });

    // The end-to-end property: revocation is not advisory.
    expect(await verifies(configPath, client)).toBe(false);
  });

  it("refuses a disabled client even with a valid key", async () => {
    const configPath = await freshConfigPath();
    const client = createTestClient("nexus-desktop");
    await initConnector({ configPath });
    await registerClientKey({
      configPath,
      clientId: client.clientId,
      publicKey: client.publicKey,
    });

    await setClientEnabled({ configPath, clientId: client.clientId, enabled: false });

    expect(await verifies(configPath, client)).toBe(false);
  });

  it("accepts the new key during a rotation overlap", async () => {
    const configPath = await freshConfigPath();
    const first = createTestClient("nexus-desktop");
    const second = createTestClient("nexus-desktop");
    await initConnector({ configPath });
    await registerClientKey({
      configPath,
      clientId: "nexus-desktop",
      publicKey: first.publicKey,
    });
    await registerClientKey({
      configPath,
      clientId: "nexus-desktop",
      publicKey: second.publicKey,
    });

    expect(await verifies(configPath, first)).toBe(true);
    expect(await verifies(configPath, second)).toBe(true);
  });
});
