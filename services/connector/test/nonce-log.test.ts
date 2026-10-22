import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NonceStore, RequestAuthenticator } from "../src/auth.js";
import {
  FileNoncePersistence,
  InMemoryNoncePersistence,
  NoncePersistenceError,
  defaultNonceLogPath,
} from "../src/nonce-log.js";
import { createTestClient } from "./client.js";
import { canonicalRequestBytes } from "../src/protocol.js";

/**
 * Replay protection has to outlive the process.
 *
 * These tests simulate a restart by building a second store over the same
 * file, which is what a restart is from the store's point of view.
 */

const posixOnly = process.platform === "win32" ? describe.skip : describe;

async function logPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-nonce-"));
  return defaultNonceLogPath(join(dir, "state"));
}

posixOnly("durable nonce storage", () => {
  it("refuses a nonce spent before a restart", async () => {
    const path = await logPath();
    const first = new NonceStore(60_000, new FileNoncePersistence({ path }));
    expect(first.remember("client-a", "n1", 1_000)).toBe(true);

    // A new store over the same file is what a restart looks like from here.
    const afterRestart = new NonceStore(60_000, new FileNoncePersistence({ path }));

    expect(afterRestart.remember("client-a", "n1", 1_000)).toBe(false);
  });

  it("still scopes a restored nonce to its client", async () => {
    const path = await logPath();
    new NonceStore(60_000, new FileNoncePersistence({ path })).remember("client-a", "n1", 1_000);

    const afterRestart = new NonceStore(60_000, new FileNoncePersistence({ path }));

    expect(afterRestart.remember("client-b", "n1", 1_000)).toBe(true);
  });

  it("does not restore a nonce whose window has passed", () => {
    const persistence = new InMemoryNoncePersistence();
    persistence.append({ clientId: "client-a", nonce: "old", expiresAt: 500 });

    // Loaded at a point past the expiry: keeping it forever would make the log
    // grow without bound for no protection.
    const store = new NonceStore(60_000, persistence);

    expect(store.remember("client-a", "old", 1_000)).toBe(true);
  });

  it("writes the nonce before admitting the request", async () => {
    const path = await logPath();
    const store = new NonceStore(60_000, new FileNoncePersistence({ path }));

    store.remember("client-a", "n1", 1_000);

    // Durable at the moment the call returns, not eventually: a crash in the
    // gap would lose the record that refuses the replay.
    const raw = await readFile(path, "utf8");
    expect(raw).toContain('"nonce":"n1"');
  });

  it("skips a torn final line instead of refusing to start", async () => {
    const path = await logPath();
    const store = new NonceStore(60_000, new FileNoncePersistence({ path }));
    store.remember("client-a", "good", 1_000);
    await writeFile(path, `${await readFile(path, "utf8")}{"clientId":"client-a","non`, "utf8");

    const afterRestart = new NonceStore(60_000, new FileNoncePersistence({ path }));

    // The good record survives; the half-written one is ignored. Refusing to
    // start over one bad line would turn a cosmetic problem into an outage.
    expect(afterRestart.remember("client-a", "good", 1_000)).toBe(false);
  });

  it("drops expired records when compacted", async () => {
    const path = await logPath();
    const persistence = new FileNoncePersistence({ path });
    persistence.append({ clientId: "client-a", nonce: "old", expiresAt: 100 });
    persistence.append({ clientId: "client-a", nonce: "new", expiresAt: 10_000 });

    persistence.compact(1_000);

    const raw = await readFile(path, "utf8");
    expect(raw).toContain('"new"');
    expect(raw).not.toContain('"old"');
  });

  it("keeps the log readable only by its owner", async () => {
    const path = await logPath();
    new FileNoncePersistence({ path }).append({
      clientId: "client-a",
      nonce: "n1",
      expiresAt: 10_000,
    });

    const { stat } = await import("node:fs/promises");
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
  });

  it("reports an unwritable log rather than silently forgetting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-nonce-ro-"));
    const path = join(dir, "spent-nonces.jsonl");
    await writeFile(path, "", "utf8");
    await chmod(path, 0o400);
    const persistence = new FileNoncePersistence({ path });

    expect(() =>
      persistence.append({ clientId: "client-a", nonce: "n1", expiresAt: 10_000 }),
    ).toThrow(NoncePersistenceError);
  });
});

posixOnly("fail-closed when the store is unavailable", () => {
  /** A persistence that cannot write, which is what a full disk looks like. */
  const broken = {
    load: () => [],
    append: () => {
      throw new NoncePersistenceError("simulated full disk");
    },
    compact: () => undefined,
  };

  it("refuses the request instead of accepting an unrecorded nonce", () => {
    const client = createTestClient();
    const authenticator = new RequestAuthenticator({
      clients: [{ clientId: client.clientId, publicKey: client.publicKey }],
      noncePersistence: broken,
    });
    const request = client.sign({ method: "health" });

    expect(() =>
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
      }),
    ).toThrow(/nonce store|unavailable|simulated/i);
  });

  it("records the cause distinctly from a replay", () => {
    const client = createTestClient();
    const authenticator = new RequestAuthenticator({
      clients: [{ clientId: client.clientId, publicKey: client.publicKey }],
      noncePersistence: broken,
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
      expect.unreachable("must refuse");
    } catch (error) {
      // An operator has to be able to tell a full disk from an attack.
      expect((error as { reason?: string }).reason).toBe("nonce_store_unavailable");
    }
  });
});
