/**
 * Contrat réel TypeScript ↔ Python des calendriers Agent Core.
 *
 * Fastify écoute sur une boucle locale choisie par l'OS. Le vrai client Python
 * du Mission Engine échange ensuite une délégation via HTTP. Aucun secret de
 * test n'est imprimé ni écrit sur disque : la charge utile passe sur stdin.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { pino } from "pino";
import { generateSigningKeyPair, SCRYPT_FAST } from "@nexus/auth";
import { parseConfig } from "@nexus/config";
import { buildApp } from "../dist/app.js";
import { ServiceContainer } from "../dist/services/container.js";
import { scheduledExternalKey } from "../dist/services/schedule-grants.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const keys = generateSigningKeyPair();
const config = parseConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://nexus:test@127.0.0.1:5432/nexus_test",
  REDIS_URL: "redis://127.0.0.1:6379",
  AUTH_SIGNING_KEY: keys.privateKeyPem,
});
const services = new ServiceContainer({
  tokenPrivateKeyPem: keys.privateKeyPem,
  passwordParams: SCRYPT_FAST,
});
const prisma = {
  $queryRaw: async () => [{ ok: 1 }],
  $disconnect: async () => undefined,
};
const redis = {
  ping: async () => "PONG",
  quit: async () => "OK",
  connect: async () => undefined,
};
const app = await buildApp({
  config,
  logger: pino({ level: "silent" }),
  prisma,
  redis,
  rateLimitStore: "memory",
  services,
});

try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("adresse Fastify absente");
  const owner = await services.users.create({
    email: "e2e-schedule-grant@example.test",
    displayName: "E2E Schedule",
    passwordHash: "scrypt$test",
  });
  const scheduleId = "22222222-2222-4222-8222-222222222222";
  const scheduledFor = "2030-01-01T07:00:00.000000+00:00";
  const base = "nexus-e2e-scheduled-core";
  const delegation = await services.scheduleGrants.issue({
    userId: owner.id,
    missionExternalKey: base,
    scheduleId,
  });
  const input = {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    delegation: delegation.token,
    scheduleId,
    scheduledFor,
    missionExternalKey: scheduledExternalKey(base, scheduleId, scheduledFor),
    expectedUserId: owner.id,
  };
  const python = [
    "import json, sys",
    "from nexus_engine.agent_core import ScheduleGrantGateway",
    "v=json.load(sys.stdin)",
    "o=ScheduleGrantGateway(v['baseUrl']).exchange(delegation=v['delegation'], schedule_id=v['scheduleId'], scheduled_for=v['scheduledFor'], mission_external_key=v['missionExternalKey'])",
    "assert o.user_id == v['expectedUserId']",
    "assert o.assertion and o.expires_at",
  ].join(";");
  const child = spawn(resolve(root, "services/mission-engine/.venv/bin/python"), ["-c", python], {
    cwd: root,
    env: {
      ...process.env,
      PYTHONPATH: resolve(root, "services/mission-engine/src"),
    },
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end(JSON.stringify(input));
  const status = await new Promise((resolveStatus, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Le client Python n'a pas répondu sous 30 secondes"));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveStatus(code);
    });
  });
  if (status !== 0) throw new Error(`Le client Python a refusé l'échange (${String(status)})`);
  process.stdout.write("E2E calendrier Agent Core : OK\n");
} finally {
  await app.close();
}
