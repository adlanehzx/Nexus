import { generateKeyPairSync, sign as signRaw, createPrivateKey } from "node:crypto";
import { pino } from "pino";
import { vi } from "vitest";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@nexus/database";
import { parseConfig } from "@nexus/config";
import { generateSigningKeyPair, SCRYPT_FAST } from "@nexus/auth";
import { InMemoryCredentialProvider, type Device, type DeviceRole } from "@nexus/devices";
import { buildApp, type NexusApp } from "../src/app.js";
import { ServiceContainer } from "../src/services/container.js";
import type { ClientSocket } from "../src/ws/client-channel.js";
import type { WorkerSocket } from "../src/ws/worker-channel.js";

/**
 * API test harness.
 *
 * `app.inject()`: no open ports, no external services. Stores are those of the
 * container — in-memory, as everywhere else in the repository — and both Prisma
 * and Redis are replaced with test doubles, as no tested route interacts with them.
 *
 * What remains **real**: full Fastify construction, Zod validation, rate limiting,
 * error handling, genuine Ed25519 signatures, real `TaskCoordinator`, real `WorkerGateway`.
 * Only external boundaries are doubled.
 */

export const signingKeys = generateSigningKeyPair();

const config = parseConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://nexus:pwd@localhost:5432/nexus_test",
  REDIS_URL: "redis://localhost:6379",
  AUTH_SIGNING_KEY: signingKeys.privateKeyPem,
});

const logger = pino({ level: "silent" });

function fakePrisma(): PrismaClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  } as unknown as PrismaClient;
}

function fakeRedis(): Redis {
  return {
    ping: vi.fn().mockResolvedValue("PONG"),
    quit: vi.fn().mockResolvedValue("OK"),
    connect: vi.fn().mockResolvedValue(undefined),
  } as unknown as Redis;
}

export interface ApiHarness {
  app: NexusApp;
  services: ServiceContainer;
  credentials: InMemoryCredentialProvider;
  close(): Promise<void>;
}

import type { LLMProvider } from "@nexus/llm";
import type { MissionControlPort } from "@nexus/mission-control-client";
import type { RuntimeConfigurationStore } from "../src/services/runtime-configuration.js";

export async function makeApi(
  options: {
    confirmationThreshold?: "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    llmProvider?: LLMProvider;
    missionControl?: MissionControlPort;
    runtimeConfiguration?: RuntimeConfigurationStore;
    publicApiUrl?: string;
    expectedWorkerVersion?: string;
  } = {},
): Promise<ApiHarness> {
  const credentials = new InMemoryCredentialProvider();
  const services = new ServiceContainer({
    tokenPrivateKeyPem: signingKeys.privateKeyPem,
    credentials,
    ...(options.confirmationThreshold === undefined
      ? {}
      : { confirmationThreshold: options.confirmationThreshold }),
    ...(options.llmProvider === undefined ? {} : { llmProvider: options.llmProvider }),
    ...(options.missionControl === undefined ? {} : { missionControl: options.missionControl }),
    ...(options.runtimeConfiguration === undefined
      ? {}
      : { runtimeConfiguration: options.runtimeConfiguration }),
    ...(options.publicApiUrl === undefined ? {} : { publicApiUrl: options.publicApiUrl }),
    ...(options.expectedWorkerVersion === undefined
      ? {}
      : { expectedWorkerVersion: options.expectedWorkerVersion }),
    // Scrypt cost is deliberate in production; paying it on each test
    // would make the suite unusable, and a slow suite ends up skipped.
    // Parameters are encoded in the hash: nothing else changes.
    passwordParams: SCRYPT_FAST,
  });

  const app = await buildApp({
    config,
    logger,
    prisma: fakePrisma(),
    redis: fakeRedis(),
    // Local in-memory counter: tests do not depend on a reachable Redis.
    rateLimitStore: "memory",
    services,
  });
  await app.ready();

  return {
    app,
    services,
    credentials,
    close: () => app.close(),
  };
}

/**
 * The same application, but **on a real port**.
 *
 * Reserved for WebSocket transport tests: `app.inject()` does not perform
 * HTTP upgrades, and a socket cannot be simulated from within. Port is chosen
 * by the system (`port: 0`) so parallel runs do not clash.
 *
 * Listening is bound to `127.0.0.1`: a test suite has no reason to expose ports
 * on the local network.
 */
export interface ListeningApi {
  harness: ApiHarness;
  /** HTTP address, e.g. `http://127.0.0.1:53124`. */
  baseUrl: string;
  /** Same address with `ws://`. */
  wsUrl: string;
  close(): Promise<void>;
}

export async function listeningApi(): Promise<ListeningApi> {
  const credentials = new InMemoryCredentialProvider();
  const services = new ServiceContainer({
    tokenPrivateKeyPem: signingKeys.privateKeyPem,
    credentials,
    passwordParams: SCRYPT_FAST,
  });

  const app = await buildApp({
    config,
    logger,
    prisma: fakePrisma(),
    redis: fakeRedis(),
    rateLimitStore: "memory",
    services,
    // 10s handshake timeout would make suite unusable; production value
    // is verified because it traverses the same code path.
    websocketHandshakeTimeoutMs: 150,
  });

  await app.listen({ port: 0, host: "127.0.0.1" });

  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server has no TCP address");
  }

  const baseUrl = `http://127.0.0.1:${String(address.port)}`;

  return {
    harness: { app, services, credentials, close: () => app.close() },
    baseUrl,
    wsUrl: baseUrl.replace(/^http/, "ws"),
    close: () => app.close(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounts and devices
// ─────────────────────────────────────────────────────────────────────────────

export const PASSWORD = "a sufficient password";

export interface Account {
  userId: string;
  accessToken: string;
  refreshToken: string;
  authorization: { authorization: string };
}

export async function createAccount(
  harness: ApiHarness,
  email = "alex@example.test",
): Promise<Account> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, displayName: "Alex", password: PASSWORD },
  });

  const body = response.json<{
    data: { user: { id: string }; tokens: { accessToken: string; refreshToken: string } };
  }>();

  return {
    userId: body.data.user.id,
    accessToken: body.data.tokens.accessToken,
    refreshToken: body.data.tokens.refreshToken,
    authorization: { authorization: `Bearer ${body.data.tokens.accessToken}` },
  };
}

export interface RegisteredDevice {
  device: Device;
  privateKeyPem: string;
}

/**
 * Registers and approves a device.
 *
 * Key is a genuine Ed25519 pair: worker handshake is executed for real
 * in tests, including signature verification.
 */
export async function registerDevice(
  harness: ApiHarness,
  account: Account,
  options: {
    name: string;
    role: DeviceRole;
    type?: "IPHONE" | "ANDROID" | "WINDOWS_PC";
    platform?: "IOS" | "ANDROID" | "WINDOWS";
    permissions?: string[];
    trust?: boolean;
  },
): Promise<RegisteredDevice> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/devices",
    headers: account.authorization,
    payload: {
      name: options.name,
      type: options.type ?? "WINDOWS_PC",
      platform: options.platform ?? "WINDOWS",
      role: options.role,
      publicKeyPem,
      grantedPermissions: options.permissions ?? [],
    },
  });

  const created = response.json<{ data: { id: string } }>();
  if (options.trust !== false) {
    await harness.app.inject({
      method: "POST",
      url: `/api/v1/devices/${created.data.id}/trust`,
      headers: account.authorization,
    });
  }

  const device = await harness.services.deviceRegistry.requireDevice(created.data.id);

  return {
    device,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function signNonce(privateKeyPem: string, nonce: string): string {
  return signRaw(null, Buffer.from(nonce, "utf8"), createPrivateKey(privateKeyPem)).toString(
    "base64",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test sockets
// ─────────────────────────────────────────────────────────────────────────────

/** Client socket. Holds what was sent, decoded. */
export class FakeClientSocket implements ClientSocket {
  readonly sent: { type: string; requestId?: string; payload: unknown }[] = [];
  closed: { code: number; reason: string } | undefined;

  send(data: string): void {
    const envelope = JSON.parse(data) as {
      type: string;
      requestId?: string;
      payload: unknown;
    };
    this.sent.push(envelope);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  ofType(type: string) {
    return this.sent.filter((message) => message.type === type);
  }

  get acks() {
    return this.ofType("client.ack").map(
      (message) =>
        message.payload as { ok: boolean; data: unknown; error: { code: string } | null },
    );
  }
}

/** Worker socket. Same principle. */
export class FakeWorkerSocket implements WorkerSocket {
  readonly sent: { type: string; payload: unknown }[] = [];
  closed: { code: number; reason: string } | undefined;
  remoteAddress = "192.0.2.5";

  send(data: string): void {
    this.sent.push(JSON.parse(data) as { type: string; payload: unknown });
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  ofType(type: string) {
    return this.sent.filter((message) => message.type === type);
  }

  last(type: string): unknown {
    return this.ofType(type).at(-1)?.payload;
  }
}

/** Lets microtask queue settle. */
export async function settle(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

/** Awaits condition becoming true, without real clock. */
export async function until(
  predicate: () => boolean | Promise<boolean>,
  rounds = 400,
): Promise<boolean> {
  for (let index = 0; index < rounds; index += 1) {
    // Predicate may be async: some states are read through registry calls.
    // Without await, a promise is truthy and loop returns on first round
    // on an unverified condition — creating a passing test that tests nothing.
    if (await predicate()) return true;
    await Promise.resolve();
  }
  return predicate();
}
