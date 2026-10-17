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
 * Harnais des tests de l'API.
 *
 * `app.inject()` : aucun port ouvert, aucun service externe. Les magasins sont
 * ceux du conteneur — en mémoire, comme partout ailleurs dans le dépôt — et
 * Prisma comme Redis sont remplacés par des doubles, puisque aucune route
 * testée ici ne les touche.
 *
 * Ce qui reste **réel** : la construction Fastify complète, la validation Zod,
 * la limitation de débit, le gestionnaire d'erreurs, les vraies signatures
 * Ed25519, le vrai `TaskCoordinator`, la vraie `WorkerGateway`. On ne double que
 * les frontières externes.
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

export async function makeApi(
  options: {
    confirmationThreshold?: "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    llmProvider?: LLMProvider;
    missionControl?: MissionControlPort;
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
    // Le coût de scrypt est voulu en production ; le faire payer à chaque test
    // rendrait la suite inutilisable, et une suite lente finit par ne plus être
    // lancée. Les paramètres sont inscrits dans l'empreinte : rien d'autre ne
    // change.
    passwordParams: SCRYPT_FAST,
  });

  const app = await buildApp({
    config,
    logger,
    prisma: fakePrisma(),
    redis: fakeRedis(),
    // Compteur local : les tests n'ont pas à dépendre d'un Redis joignable.
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
 * La même application, mais **sur un vrai port**.
 *
 * Réservé aux tests du transport WebSocket : `app.inject()` ne fait pas de mise
 * à niveau HTTP, et une socket ne se simule pas depuis l'intérieur. Le port est
 * choisi par le système (`port: 0`) pour que deux exécutions parallèles ne se
 * disputent rien.
 *
 * L'écoute est limitée à `127.0.0.1` : une suite de tests n'a aucune raison
 * d'ouvrir un port sur le réseau local de qui la lance.
 */
export interface ListeningApi {
  harness: ApiHarness;
  /** Adresse HTTP, par exemple `http://127.0.0.1:53124`. */
  baseUrl: string;
  /** La même en `ws://`. */
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
    // Dix secondes de délai de poignée de main rendraient la suite
    // inutilisable ; la valeur de production est éprouvée par le fait qu'elle
    // traverse le même chemin.
    websocketHandshakeTimeoutMs: 150,
  });

  await app.listen({ port: 0, host: "127.0.0.1" });

  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("le serveur de test n'a pas d'adresse TCP");
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
// Comptes et appareils
// ─────────────────────────────────────────────────────────────────────────────

export const PASSWORD = "un mot de passe suffisant";

export interface Account {
  userId: string;
  accessToken: string;
  refreshToken: string;
  authorization: { authorization: string };
}

export async function createAccount(
  harness: ApiHarness,
  email = "adlan@exemple.fr",
): Promise<Account> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, displayName: "Adlan", password: PASSWORD },
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
 * Enregistre un appareil et l'approuve.
 *
 * La clé est une vraie paire Ed25519 : la poignée de main du worker est jouée
 * pour de vrai dans les tests, signature comprise.
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
// Sockets de test
// ─────────────────────────────────────────────────────────────────────────────

/** Socket client. Retient ce qui est envoyé, décodé. */
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

/** Socket worker. Même principe. */
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

/** Laisse la file de micro-tâches se vider. */
export async function settle(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

/** Attend qu'une condition devienne vraie, sans horloge réelle. */
export async function until(
  predicate: () => boolean | Promise<boolean>,
  rounds = 400,
): Promise<boolean> {
  for (let index = 0; index < rounds; index += 1) {
    // Le prédicat peut être asynchrone : certains états ne se lisent que par un
    // appel au registre. Sans `await`, une promesse serait toujours vraie et la
    // boucle rendrait la main au premier tour, sur une condition jamais
    // vérifiée — un test vert qui ne teste rien.
    if (await predicate()) return true;
    await Promise.resolve();
  }
  return predicate();
}
