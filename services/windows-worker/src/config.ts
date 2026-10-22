import { z } from "zod";
import { WorkerConfigurationError } from "./errors.js";
import { defaultStatePath } from "./runtime/state-file.js";
import { parseApplications } from "./capabilities/app.js";

/**
 * Worker configuration.
 *
 * Machine identity and role are defined through these environment variables
 * and the core device registry.
 */

const csv = (value: string): string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const csvList = (fallback = "") => z.string().default(fallback).transform(csv);

export const workerConfigSchema = z.object({
  /** Platform announced to core. Default preserves Windows installations. */
  NEXUS_WORKER_PLATFORM: z.enum(["WINDOWS", "LINUX", "MACOS"]).default("WINDOWS"),

  /** Core backend URL. Must use wss:// or https:// for remote hosts. */
  NEXUS_BACKEND_URL: z.string().url(),

  /** Device ID assigned by the backend upon pairing. */
  DEVICE_ID: z.string().min(1),

  /** Path to Ed25519 private key in PEM format. */
  DEVICE_CREDENTIAL_PATH: z.string().min(1),

  /** Roots under which read and write operations are permitted. */
  WORKER_ALLOWED_PATHS: csvList(),

  /** Declared capabilities. Empty = all supported locally. */
  WORKER_CAPABILITIES: csvList(),

  /** Allowed executables for terminal.execute. Empty = default list. */
  WORKER_ALLOWED_EXECUTABLES: csvList(),

  /** Environment variables passed to launched processes. */
  WORKER_ALLOWED_ENV: csvList(),

  /** Openable applications formatted as name=executablePath. */
  WORKER_APPS: csvList(),

  /** SHA-256 fingerprint (base64) of the core public key for pinning. */
  NEXUS_CORE_FINGERPRINT: z.string().default(""),

  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(20_000),
  WORKER_TASK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),

  /** Maximum concurrent tasks. */
  WORKER_MAX_CONCURRENT_TASKS: z.coerce.number().int().min(1).max(16).default(2),

  WORKER_RECONNECT_MIN_MS: z.coerce.number().int().min(100).default(1_000),
  WORKER_RECONNECT_MAX_MS: z.coerce.number().int().min(1_000).default(60_000),

  /** Allowed Docker subcommands. */
  WORKER_DOCKER_ALLOWED: csvList("ps,images,logs,inspect"),

  /** Allow mutating Git operations (pull, checkout, commit, clone). */
  WORKER_GIT_ALLOW_WRITE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  /** Path where public daemon state is published. */
  WORKER_STATE_PATH: z.string().default(""),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type WorkerConfigInput = z.input<typeof workerConfigSchema>;
export type RawWorkerConfig = z.infer<typeof workerConfigSchema>;

export interface WorkerConfig {
  platform?: "WINDOWS" | "LINUX" | "MACOS";
  backendUrl: string;
  deviceId: string;
  credentialPath: string;
  allowedPaths: string[];
  declaredCapabilities: string[];
  allowedExecutables: string[];
  allowedEnv: string[];
  applications: Map<string, string>;
  coreFingerprint: string | undefined;
  heartbeatIntervalMs: number;
  taskTimeoutMs: number;
  maxConcurrentTasks: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  dockerAllowed: string[];
  gitAllowWrite: boolean;
  statePath: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

/**
 * Validate and normalize worker configuration.
 *
 * @throws {WorkerConfigurationError} on missing or invalid configuration.
 */
export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const parsed = workerConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new WorkerConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  const raw = parsed.data;
  const issues: string[] = [];

  const url = new URL(raw.NEXUS_BACKEND_URL);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!isLocal && (url.protocol === "ws:" || url.protocol === "http:")) {
    issues.push("NEXUS_BACKEND_URL: a remote address must use wss:// or https://");
  }

  if (raw.WORKER_RECONNECT_MAX_MS <= raw.WORKER_RECONNECT_MIN_MS) {
    issues.push("WORKER_RECONNECT_MAX_MS must exceed WORKER_RECONNECT_MIN_MS");
  }

  if (issues.length > 0) throw new WorkerConfigurationError(issues);

  return {
    platform: raw.NEXUS_WORKER_PLATFORM,
    backendUrl: raw.NEXUS_BACKEND_URL,
    deviceId: raw.DEVICE_ID,
    credentialPath: raw.DEVICE_CREDENTIAL_PATH,
    allowedPaths: raw.WORKER_ALLOWED_PATHS,
    declaredCapabilities: raw.WORKER_CAPABILITIES,
    allowedExecutables: raw.WORKER_ALLOWED_EXECUTABLES,
    allowedEnv: raw.WORKER_ALLOWED_ENV,
    applications: parseApplications(raw.WORKER_APPS),
    coreFingerprint: raw.NEXUS_CORE_FINGERPRINT === "" ? undefined : raw.NEXUS_CORE_FINGERPRINT,
    heartbeatIntervalMs: raw.WORKER_HEARTBEAT_INTERVAL_MS,
    taskTimeoutMs: raw.WORKER_TASK_TIMEOUT_MS,
    maxConcurrentTasks: raw.WORKER_MAX_CONCURRENT_TASKS,
    reconnectMinMs: raw.WORKER_RECONNECT_MIN_MS,
    reconnectMaxMs: raw.WORKER_RECONNECT_MAX_MS,
    dockerAllowed: raw.WORKER_DOCKER_ALLOWED,
    gitAllowWrite: raw.WORKER_GIT_ALLOW_WRITE,
    statePath: raw.WORKER_STATE_PATH === "" ? defaultStatePath(env) : raw.WORKER_STATE_PATH,
    logLevel: raw.LOG_LEVEL,
  };
}
