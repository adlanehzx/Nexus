import { z } from "zod";
import { WorkerConfigurationError } from "@nexus/worker-core";

/**
 * Android worker configuration.
 */

const csv = (value: string): string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const csvList = (fallback = "") => z.string().default(fallback).transform(csv);

export const androidConfigSchema = z.object({
  /** NEXUS core. Remote address must use `wss://`. */
  NEXUS_BACKEND_URL: z.string().url(),

  /** Assigned by backend during pairing. Public: authenticates nothing by itself. */
  DEVICE_ID: z.string().min(1),

  /**
   * Key alias in Android KeyStore.
   *
   * A reference, never the raw key. Secret never leaves the store.
   */
  DEVICE_KEY_ALIAS: z.string().min(1).default("nexus.device.key"),

  /** Exposed capabilities. Empty = all actually available. */
  WORKER_CAPABILITIES: csvList(),

  /**
   * Launchable applications. Empty = all except those denied by policy.
   */
  ANDROID_ALLOWED_PACKAGES: csvList(),
  ANDROID_DENIED_PACKAGES: csvList(),

  /**
   * Allows coordinate-based taps.
   *
   * False by default.
   */
  ANDROID_ALLOW_COORDINATE_CLICKS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  ANDROID_SCREENSHOT_MAX_DIMENSION: z.coerce.number().int().min(240).max(2_048).default(1_280),
  /** Minimum interval between two screenshots — guard against continuous recording. */
  ANDROID_SCREENSHOT_MIN_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(1_000),

  /** Below this level and discharging, the device reports degraded. */
  ANDROID_LOW_BATTERY_PERCENT: z.coerce.number().int().min(0).max(100).default(20),
  /** Below this level, it rejects new tasks. */
  ANDROID_CRITICAL_BATTERY_PERCENT: z.coerce.number().int().min(0).max(100).default(10),

  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  WORKER_TASK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  /** Maximum concurrent tasks. */
  WORKER_MAX_CONCURRENT_TASKS: z.coerce.number().int().min(1).max(4).default(1),

  WORKER_RECONNECT_MIN_MS: z.coerce.number().int().min(100).default(2_000),
  WORKER_RECONNECT_MAX_MS: z.coerce.number().int().min(1_000).default(120_000),

  /** Capability availability check interval. */
  ANDROID_AVAILABILITY_INTERVAL_MS: z.coerce.number().int().min(5_000).max(600_000).default(30_000),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface AndroidWorkerConfig {
  backendUrl: string;
  deviceId: string;
  keyAlias: string;
  declaredCapabilities: string[];
  allowedPackages: string[];
  deniedPackages: string[];
  allowCoordinateClicks: boolean;
  screenshotMaxDimension: number;
  screenshotMinIntervalMs: number;
  lowBatteryPercent: number;
  criticalBatteryPercent: number;
  heartbeatIntervalMs: number;
  taskTimeoutMs: number;
  maxConcurrentTasks: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  availabilityIntervalMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

/**
 * Validates and normalizes configuration.
 *
 * @throws {WorkerConfigurationError} on any missing or invalid variable.
 */
export function loadAndroidConfig(env: Record<string, string | undefined>): AndroidWorkerConfig {
  const parsed = androidConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new WorkerConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  const raw = parsed.data;
  const issues: string[] = [];

  const url = new URL(raw.NEXUS_BACKEND_URL);
  const isLocal =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "10.0.2.2";
  if (!isLocal && (url.protocol === "ws:" || url.protocol === "http:")) {
    issues.push("NEXUS_BACKEND_URL: a remote address must use wss:// or https://");
  }

  if (raw.WORKER_RECONNECT_MAX_MS <= raw.WORKER_RECONNECT_MIN_MS) {
    issues.push("WORKER_RECONNECT_MAX_MS must be greater than WORKER_RECONNECT_MIN_MS");
  }

  if (raw.ANDROID_CRITICAL_BATTERY_PERCENT > raw.ANDROID_LOW_BATTERY_PERCENT) {
    issues.push(
      "ANDROID_CRITICAL_BATTERY_PERCENT must be less than or equal to ANDROID_LOW_BATTERY_PERCENT",
    );
  }

  if (issues.length > 0) throw new WorkerConfigurationError(issues);

  return {
    backendUrl: raw.NEXUS_BACKEND_URL,
    deviceId: raw.DEVICE_ID,
    keyAlias: raw.DEVICE_KEY_ALIAS,
    declaredCapabilities: raw.WORKER_CAPABILITIES,
    allowedPackages: raw.ANDROID_ALLOWED_PACKAGES,
    deniedPackages: raw.ANDROID_DENIED_PACKAGES,
    allowCoordinateClicks: raw.ANDROID_ALLOW_COORDINATE_CLICKS,
    screenshotMaxDimension: raw.ANDROID_SCREENSHOT_MAX_DIMENSION,
    screenshotMinIntervalMs: raw.ANDROID_SCREENSHOT_MIN_INTERVAL_MS,
    lowBatteryPercent: raw.ANDROID_LOW_BATTERY_PERCENT,
    criticalBatteryPercent: raw.ANDROID_CRITICAL_BATTERY_PERCENT,
    heartbeatIntervalMs: raw.WORKER_HEARTBEAT_INTERVAL_MS,
    taskTimeoutMs: raw.WORKER_TASK_TIMEOUT_MS,
    maxConcurrentTasks: raw.WORKER_MAX_CONCURRENT_TASKS,
    reconnectMinMs: raw.WORKER_RECONNECT_MIN_MS,
    reconnectMaxMs: raw.WORKER_RECONNECT_MAX_MS,
    availabilityIntervalMs: raw.ANDROID_AVAILABILITY_INTERVAL_MS,
    logLevel: raw.LOG_LEVEL,
  };
}
