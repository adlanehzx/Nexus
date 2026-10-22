import { z } from "zod";
import { WorkerConfigurationError } from "@nexus/worker-core";

/**
 * Configuration for the browser worker host daemon.
 */

const csv = (value: string): string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const csvList = (fallback = "") => z.string().default(fallback).transform(csv);

export const browserHostConfigSchema = z.object({
  // ── Core link ────────────────────────────────────────────────────────────
  /** Core backend URL. Remote URLs must use wss:// or https://. */
  NEXUS_BACKEND_URL: z.string().url(),
  /** Device ID assigned by the core. */
  DEVICE_ID: z.string().min(1),
  /** Path to Ed25519 private key in PEM format. */
  DEVICE_KEY_PATH: z.string().min(1),

  // ── Python worker link ───────────────────────────────────────────────────
  /** Browser Use worker URL. Internal network only. */
  BROWSER_WORKER_URL: z.string().url().default("http://127.0.0.1:8100"),
  /** Service auth token for the Python worker. */
  BROWSER_WORKER_TOKEN: z.string().min(16),

  // ── Capabilities & policy ────────────────────────────────────────────────
  /** Declared capabilities. Empty = all supported. */
  WORKER_CAPABILITIES: csvList(),
  /** Allowed navigation domains. Empty = no allowlist restriction. */
  BROWSER_ALLOWED_DOMAINS: csvList(),
  BROWSER_PROHIBITED_DOMAINS: csvList(),

  /** Maximum steps per task. */
  BROWSER_MAX_STEPS: z.coerce.number().int().min(1).max(50).default(15),
  /** Browser session TTL in seconds. */
  BROWSER_SESSION_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(600),
  /** Headless mode. */
  BROWSER_HEADLESS: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),

  // ── Lifecycle ────────────────────────────────────────────────────────────
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  WORKER_TASK_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(1_800_000).default(900_000),
  WORKER_MAX_CONCURRENT_TASKS: z.coerce.number().int().min(1).max(8).default(2),

  WORKER_RECONNECT_MIN_MS: z.coerce.number().int().min(100).default(2_000),
  WORKER_RECONNECT_MAX_MS: z.coerce.number().int().min(1_000).default(120_000),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface BrowserHostConfig {
  backendUrl: string;
  deviceId: string;
  deviceKeyPath: string;

  browserWorkerUrl: string;
  browserWorkerToken: string;

  declaredCapabilities: string[];
  allowedDomains: string[];
  prohibitedDomains: string[];

  maxSteps: number;
  sessionTtlSeconds: number;
  headless: boolean;

  heartbeatIntervalMs: number;
  taskTimeoutMs: number;
  maxConcurrentTasks: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

/**
 * Validate and normalize configuration from environment variables.
 *
 * @throws {WorkerConfigurationError} on missing or invalid configuration.
 */
export function loadBrowserHostConfig(env: Record<string, string | undefined>): BrowserHostConfig {
  const parsed = browserHostConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new WorkerConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  const raw = parsed.data;
  const issues: string[] = [];

  const core = new URL(raw.NEXUS_BACKEND_URL);
  const coreLocal = core.hostname === "localhost" || core.hostname === "127.0.0.1";
  if (!coreLocal && (core.protocol === "ws:" || core.protocol === "http:")) {
    issues.push("NEXUS_BACKEND_URL: a remote address must use wss:// or https://");
  }

  const browser = new URL(raw.BROWSER_WORKER_URL);
  const browserLocal =
    browser.hostname === "localhost" ||
    browser.hostname === "127.0.0.1" ||
    !browser.hostname.includes(".");
  if (!browserLocal && browser.protocol === "http:") {
    issues.push(
      "BROWSER_WORKER_URL: a remote address must use https://. This worker is never exposed to the public Internet.",
    );
  }

  if (raw.WORKER_RECONNECT_MAX_MS <= raw.WORKER_RECONNECT_MIN_MS) {
    issues.push("WORKER_RECONNECT_MAX_MS must exceed WORKER_RECONNECT_MIN_MS");
  }

  if (issues.length > 0) throw new WorkerConfigurationError(issues);

  return {
    backendUrl: raw.NEXUS_BACKEND_URL,
    deviceId: raw.DEVICE_ID,
    deviceKeyPath: raw.DEVICE_KEY_PATH,

    browserWorkerUrl: raw.BROWSER_WORKER_URL,
    browserWorkerToken: raw.BROWSER_WORKER_TOKEN,

    declaredCapabilities: raw.WORKER_CAPABILITIES,
    allowedDomains: raw.BROWSER_ALLOWED_DOMAINS,
    prohibitedDomains: raw.BROWSER_PROHIBITED_DOMAINS,

    maxSteps: raw.BROWSER_MAX_STEPS,
    sessionTtlSeconds: raw.BROWSER_SESSION_TTL_SECONDS,
    headless: raw.BROWSER_HEADLESS,

    heartbeatIntervalMs: raw.WORKER_HEARTBEAT_INTERVAL_MS,
    taskTimeoutMs: raw.WORKER_TASK_TIMEOUT_MS,
    maxConcurrentTasks: raw.WORKER_MAX_CONCURRENT_TASKS,
    reconnectMinMs: raw.WORKER_RECONNECT_MIN_MS,
    reconnectMaxMs: raw.WORKER_RECONNECT_MAX_MS,
    logLevel: raw.LOG_LEVEL,
  };
}

/** Safe diagnostic representation of config without secrets. */
export function describeConfig(config: BrowserHostConfig): Record<string, unknown> {
  return {
    deviceId: config.deviceId,
    backendUrl: config.backendUrl,
    browserWorkerUrl: config.browserWorkerUrl,
    browserWorkerToken: config.browserWorkerToken.length > 0 ? "[set]" : "[absent]",
    declaredCapabilities: config.declaredCapabilities,
    allowedDomains: config.allowedDomains,
    prohibitedDomains: config.prohibitedDomains,
    headless: config.headless,
    maxConcurrentTasks: config.maxConcurrentTasks,
  };
}
