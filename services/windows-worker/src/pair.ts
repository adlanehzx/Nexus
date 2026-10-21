#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";

export interface PairWorkerInput {
  apiUrl: string;
  token: string;
  name: string;
  keyPath: string;
  envPath: string;
  allowedPaths: string[];
  platform?: "WINDOWS" | "LINUX" | "MACOS";
  fetchImpl?: typeof fetch;
}

export interface PairWorkerResult {
  deviceId: string;
  envPath: string;
  keyPath: string;
}

/**
 * Consomme un ticket d'appairage sans jamais persister celui-ci.
 *
 * La cle privee est creee localement et seul le PEM public traverse le reseau.
 * Le fichier de configuration ne contient qu'un chemin vers cette cle.
 */
export async function pairWorker(input: PairWorkerInput): Promise<PairWorkerResult> {
  const apiUrl = normaliseApiUrl(input.apiUrl);
  const keyPath = resolve(input.keyPath);
  const envPath = resolve(input.envPath);
  if (existsSync(keyPath) || existsSync(envPath)) {
    throw new Error("une identite existe deja ; revoquez-la avant de la remplacer");
  }
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const request = input.fetchImpl ?? fetch;
  const platform = input.platform ?? "WINDOWS";

  const response = await request(`${apiUrl}/api/v1/devices/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: input.token,
      name: input.name,
      type: platform === "WINDOWS" ? "WINDOWS_PC" : platform === "MACOS" ? "MAC" : "LINUX",
      platform,
      role: "WORKER",
      publicKeyPem,
    }),
  });

  const payload = (await response.json().catch(() => undefined)) as
    { data?: { id?: unknown }; error?: { message?: unknown } } | undefined;
  if (!response.ok) {
    const detail = payload?.error?.message;
    throw new Error(typeof detail === "string" ? detail : `appairage refuse (${response.status})`);
  }
  const deviceId = payload?.data?.id;
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    throw new Error("reponse d'appairage invalide : identifiant absent");
  }

  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, privateKey, { mode: 0o600, flag: "wx" });
  chmodSync(keyPath, 0o600);

  const allowedPaths = input.allowedPaths.map((path) => path.trim()).filter(Boolean);
  const capabilities =
    platform === "WINDOWS"
      ? "terminal.execute,filesystem.read,filesystem.write,process.list,git.status,git.diff,git.branch,browser.open"
      : "terminal.execute,filesystem.read,filesystem.write,git.status,git.diff,git.branch";
  const env = [
    `NEXUS_BACKEND_URL=${apiUrl}`,
    `NEXUS_WORKER_PLATFORM=${platform}`,
    `DEVICE_ID=${deviceId}`,
    `DEVICE_CREDENTIAL_PATH=${keyPath}`,
    `WORKER_ALLOWED_PATHS=${allowedPaths.join(",")}`,
    `WORKER_CAPABILITIES=${capabilities}`,
    `WORKER_ALLOWED_EXECUTABLES=${platform === "WINDOWS" ? "git,node,pnpm,python" : "git,node"}`,
    "WORKER_ALLOWED_ENV=PATH,SYSTEMROOT,TEMP,TMP",
    "WORKER_APPS=",
    "NEXUS_CORE_FINGERPRINT=",
    "WORKER_HEARTBEAT_INTERVAL_MS=20000",
    "WORKER_TASK_TIMEOUT_MS=300000",
    "WORKER_MAX_CONCURRENT_TASKS=2",
    "WORKER_RECONNECT_MIN_MS=1000",
    "WORKER_RECONNECT_MAX_MS=60000",
    "WORKER_DOCKER_ALLOWED=ps,images,logs,inspect",
    "WORKER_GIT_ALLOW_WRITE=false",
    "WORKER_STATE_PATH=",
    "LOG_LEVEL=info",
    "",
  ].join("\n");

  mkdirSync(dirname(envPath), { recursive: true });
  writeFileSync(envPath, env, { mode: 0o600, flag: "wx" });
  chmodSync(envPath, 0o600);
  return { deviceId, envPath, keyPath };
}

function normaliseApiUrl(raw: string): string {
  const url = new URL(raw);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!local && url.protocol !== "https:") {
    throw new Error("une API distante doit utiliser https://");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("l'adresse NEXUS doit utiliser http:// ou https://");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function valueOf(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(args: string[]): Promise<void> {
  const apiUrl = valueOf(args, "--api-url");
  const token = args.includes("--token-stdin")
    ? (await readStdin()).trim()
    : valueOf(args, "--token");
  const name = valueOf(args, "--name") ?? process.env.COMPUTERNAME ?? "PC Windows";
  const keyPath = valueOf(args, "--key-path");
  const envPath = valueOf(args, "--env-path");
  const allowedPaths = valueOf(args, "--allowed-paths")?.split(",") ?? [];
  const requestedPlatform = (valueOf(args, "--platform") ?? "WINDOWS").toUpperCase();
  if (!["WINDOWS", "LINUX", "MACOS"].includes(requestedPlatform)) {
    throw new Error("--platform doit etre WINDOWS, LINUX ou MACOS");
  }
  if (
    apiUrl === undefined ||
    token === undefined ||
    keyPath === undefined ||
    envPath === undefined
  ) {
    throw new Error(
      "usage: pair --api-url <url> (--token <ticket>|--token-stdin) --key-path <fichier> --env-path <fichier> [--name <nom>] [--platform WINDOWS|LINUX|MACOS] [--allowed-paths <chemins>]",
    );
  }
  const result = await pairWorker({
    apiUrl,
    token,
    name,
    keyPath,
    envPath,
    allowedPaths,
    platform: requestedPlatform as "WINDOWS" | "LINUX" | "MACOS",
  });
  process.stdout.write(`Appareil appaire : ${result.deviceId}\n`);
  process.stdout.write("Il reste a l'approuver dans NEXUS, page Appareils.\n");
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

const invokedAsProgram =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsProgram) {
  main(process.argv.slice(2)).catch((cause: unknown) => {
    process.stderr.write(
      `NEXUS worker: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    process.exitCode = 1;
  });
}
