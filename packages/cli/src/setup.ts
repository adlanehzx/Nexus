import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";

import type { NexusPaths } from "./environment.js";
import { readEnvFile, upsertEnvValue } from "./environment.js";
import { MISSION_ENGINE_UNIT, renderMissionEngineUnit } from "./systemd.js";

/**
 * Installation and compliance management for a NEXUS instance.
 *
 * Idempotent, never destroys secrets, and describes each action before applying.
 */

export interface SetupOptions {
  paths: NexusPaths;
  dryRun: boolean;
  /** Replaces existing persistent signing key. Never implicit. */
  rotateKeys: boolean;
  /** Absolute path of pnpm binary. */
  pnpmPath: string;
  apiUrl?: string;
  servicePath?: string;
}

export interface SetupAction {
  label: string;
  needed: boolean;
  detail?: string;
  apply: () => void;
}

export interface SetupPlan {
  actions: SetupAction[];
  warnings: string[];
}

export function planSetup(options: SetupOptions): SetupPlan {
  const { paths } = options;
  const actions: SetupAction[] = [];
  const warnings: string[] = [];

  const envExists = existsSync(paths.envFile);
  let envContent = envExists ? readFileSync(paths.envFile, "utf8") : "";

  if (!envExists) {
    const template = existsSync(paths.envExample)
      ? readFileSync(paths.envExample, "utf8")
      : "NODE_ENV=development\n";
    envContent = template;
    actions.push({
      label: "create .env from .env.example",
      needed: true,
      detail: paths.envFile,
      apply: () => writeSecret(paths.envFile, template),
    });
  }

  const env = envExists ? readEnvFile(paths.envFile) : {};

  // Runtime configuration belongs to the installation, not to the source
  // tree. Bootstrap it from public examples so a clone starts clean and a
  // user's agents, account names and routing preferences can never be
  // committed accidentally.
  for (const [target, example, fallback, label] of [
    [
      paths.agentRegistry,
      join(dirname(paths.agentRegistry), "profiles.example.json"),
      '{"profiles":{}}\n',
      "create the local ACP profile registry",
    ],
    [
      paths.engineProfiles,
      join(dirname(paths.engineProfiles), "profiles.example.json"),
      "{}\n",
      "create the local Mission Engine profile map",
    ],
    [
      paths.engineRuntimeSettings,
      join(dirname(paths.engineRuntimeSettings), "runtime-settings.example.json"),
      "{}\n",
      "create the local Mission Engine settings",
    ],
  ] as const) {
    const needed = !existsSync(target);
    actions.push({
      label,
      needed,
      detail: target,
      apply: () =>
        writeSecret(target, existsSync(example) ? readFileSync(example, "utf8") : fallback),
    });
  }

  // ── Signing key ──────────────────────────────────────────────────────────
  const existingKey = env.AUTH_SIGNING_KEY;
  const hasKey = typeof existingKey === "string" && existingKey.includes("BEGIN PRIVATE KEY");
  const generate = !hasKey || options.rotateKeys;

  if (hasKey && options.rotateKeys) {
    warnings.push(
      "rotation requested: active sessions will be invalidated and any public key deployed elsewhere must be replaced",
    );
  }

  let publicKeyPem = hasKey ? derivePublicKey(existingKey) : undefined;

  if (generate) {
    const pair = generateKeyPairSync("ed25519");
    const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();

    actions.push({
      label: hasKey ? "replace signing key" : "generate a persistent signing key",
      needed: true,
      detail: "Ed25519, written to .env with mode 0600",
      apply: () => {
        const updated = upsertEnvValue(
          readFileSyncOr(paths.envFile, envContent),
          "AUTH_SIGNING_KEY",
          privateKeyPem,
        );
        writeSecret(paths.envFile, updated);
      },
    });
  } else {
    actions.push({
      label: "persistent signing key",
      needed: false,
      detail: "already present — use --rotate-keys to replace",
      apply: () => undefined,
    });
  }

  // ── Secret file permissions ──────────────────────────────────────────────
  const envMode = permissionsOf(paths.envFile);
  const envModeWrong = envMode !== undefined && envMode !== "600";
  actions.push({
    label: "restrict .env to owner",
    needed: envModeWrong || !envExists,
    detail: envMode === undefined ? "will be created with mode 0600" : `currently 0${envMode}`,
    apply: () => chmodSync(paths.envFile, 0o600),
  });

  // ── Deployed public key ──────────────────────────────────────────────────
  if (publicKeyPem !== undefined) {
    const deployed = existsSync(paths.publicKeyFile)
      ? readFileSync(paths.publicKeyFile, "utf8")
      : undefined;
    const matches = deployed !== undefined && normalise(deployed) === normalise(publicKeyPem);
    const pem = publicKeyPem;

    actions.push({
      label: "deploy public key for Mission Engine",
      needed: !matches,
      detail: paths.publicKeyFile,
      apply: () => {
        mkdirSync(dirname(paths.publicKeyFile), { recursive: true, mode: 0o700 });
        writeFileSync(paths.publicKeyFile, pem, { mode: 0o644 });
      },
    });
  }

  // ── PostgreSQL credentials ───────────────────────────────────────────────
  if (env.DATABASE_URL === undefined || env.DATABASE_URL.length === 0) {
    const password = randomBytes(24).toString("base64url");
    const url = `postgresql://nexus:${password}@127.0.0.1:15432/nexus`;
    actions.push({
      label: "generate a local PostgreSQL URL",
      needed: true,
      detail: "random 24-byte password",
      apply: () => {
        const updated = upsertEnvValue(
          readFileSyncOr(paths.envFile, envContent),
          "DATABASE_URL",
          url,
        );
        writeSecret(paths.envFile, updated);
      },
    });
    warnings.push(
      "PostgreSQL password was generated: restart docker compose for the database to adopt it",
    );
  }

  // ── Systemd unit ─────────────────────────────────────────────────────────
  const unitPath = join(paths.systemdUserDir, MISSION_ENGINE_UNIT);
  const unit = renderMissionEngineUnit({
    paths,
    pnpmPath: options.pnpmPath,
    servicePath: options.servicePath ?? process.env.PATH ?? "/usr/local/bin:/usr/bin",
    apiUrl: options.apiUrl ?? env.MISSION_CONTROL_URL ?? "http://127.0.0.1:3000",
    publicKeyFile: publicKeyPem === undefined ? undefined : paths.publicKeyFile,
  });
  const currentUnit = existsSync(unitPath) ? readFileSync(unitPath, "utf8") : undefined;

  actions.push({
    label: "write engine systemd unit",
    needed: currentUnit !== unit,
    detail: unitPath,
    apply: () => {
      mkdirSync(paths.systemdUserDir, { recursive: true });
      writeFileSync(unitPath, unit, { mode: 0o644 });
    },
  });

  return { actions, warnings };
}

/**
 * Applies a setup plan.
 */
export function applyPlan(plan: SetupPlan): { applied: string[]; skipped: string[] } {
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const action of plan.actions) {
    if (!action.needed) {
      skipped.push(action.label);
      continue;
    }
    action.apply();
    applied.push(action.label);
  }
  return { applied, skipped };
}

function writeSecret(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readFileSyncOr(path: string, fallback: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

function derivePublicKey(privateKeyPem: string): string | undefined {
  try {
    return createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();
  } catch {
    return undefined;
  }
}

function permissionsOf(path: string): string | undefined {
  try {
    return (statSync(path).mode & 0o777).toString(8);
  } catch {
    return undefined;
  }
}

const normalise = (value: string): string => value.replace(/\s+/g, "");
