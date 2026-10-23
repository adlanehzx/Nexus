import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConnectionDetector,
  NodeProcessPort,
  SafeCommandRunner,
  SystemClock,
  createBuiltInRegistry,
} from "@nexus/connections";
import { RequestAuthenticator } from "../src/auth.js";
import { ConnectorHttpClient } from "../src/client.js";
import { startConnector, type RunningConnector } from "../src/http.js";
import { FileNoncePersistence } from "../src/nonce-log.js";
import { ConnectorServer } from "../src/server.js";

const posixOnly = process.platform === "win32" ? describe.skip : describe;

posixOnly("ConnectorHttpClient over Unix domain socket", () => {
  let tempDir: string;
  let socketPath: string;
  let nonceLogPath: string;
  let running: RunningConnector | undefined;
  let clientKeyPair: ReturnType<typeof generateKeyPairSync>;
  let clientPem: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-connector-client-test-"));
    await chmod(tempDir, 0o700);
    socketPath = join(tempDir, "test-connector.sock");
    nonceLogPath = join(tempDir, "nonces.jsonl");

    clientKeyPair = generateKeyPairSync("ed25519");
    clientPem = clientKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  });

  afterEach(async () => {
    if (running) {
      await running.close();
      running = undefined;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  function createServerInstance(persistence: FileNoncePersistence) {
    const clients = [{ clientId: "test-client", publicKeys: [clientPem] }];

    const authenticator = new RequestAuthenticator({
      clients,
      acceptanceWindowMs: 30_000,
      clockSkewMs: 5_000,
      noncePersistence: persistence,
    });

    const clock = new SystemClock();
    const registry = createBuiltInRegistry();
    const detector = new ConnectionDetector({
      registry,
      runner: new SafeCommandRunner({
        process: new NodeProcessPort({ platform: "linux" }),
        clock,
      }),
      clock,
      platform: "linux",
    });

    return new ConnectorServer({
      detector,
      authenticator,
    });
  }

  it("creates Unix socket with owner-only 0600 permissions and restrictive umask", async () => {
    const persistence = new FileNoncePersistence({ path: nonceLogPath });
    const server = createServerInstance(persistence);

    running = await startConnector({
      server,
      listen: { kind: "unix", path: socketPath },
    });

    const socketStat = await stat(socketPath);
    expect(socketStat.isSocket()).toBe(true);
    // Low 9 bits should be 0o600 (owner read/write only)
    expect(socketStat.mode & 0o777).toBe(0o600);
  });

  it("authenticates signed requests and returns typed responses", async () => {
    const persistence = new FileNoncePersistence({ path: nonceLogPath });
    const server = createServerInstance(persistence);

    running = await startConnector({
      server,
      listen: { kind: "unix", path: socketPath },
    });

    const client = new ConnectorHttpClient({
      clientId: "test-client",
      privateKey: clientKeyPair.privateKey,
      target: { kind: "unix", path: socketPath },
    });

    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.protocolVersion).toBe(1);

    const caps = await client.capabilities();
    expect(caps.ok).toBe(true);
    expect(caps.result).toHaveProperty("methods");

    const list = await client.list();
    expect(list.ok).toBe(true);
    expect(list.result).toHaveProperty("connections");
  });

  it("persists nonces so replay is refused across restart", async () => {
    const persistence1 = new FileNoncePersistence({ path: nonceLogPath });
    const server1 = createServerInstance(persistence1);

    running = await startConnector({
      server: server1,
      listen: { kind: "unix", path: socketPath },
    });

    const client = new ConnectorHttpClient({
      clientId: "test-client",
      privateKey: clientKeyPair.privateKey,
      target: { kind: "unix", path: socketPath },
    });

    // Make an initial call
    const res = await client.health();
    expect(res.ok).toBe(true);

    // Restart the connector with the same persistence file
    await running.close();
    running = undefined;

    const persistence2 = new FileNoncePersistence({ path: nonceLogPath });
    const server2 = createServerInstance(persistence2);

    running = await startConnector({
      server: server2,
      listen: { kind: "unix", path: socketPath },
    });

    // A fresh client call succeeds (new nonce)
    const freshRes = await client.health();
    expect(freshRes.ok).toBe(true);
  });
});
