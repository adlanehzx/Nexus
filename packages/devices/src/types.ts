import { z } from "zod";

/**
 * Device domain model.
 *
 * Core invariant: Core does not identify devices by hardware names.
 * It reasons over roles, device types, and declared capabilities.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Roles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Device operating roles.
 *
 * `BOTH`: device functions as user interface (client) and task execution host (worker).
 */
export const deviceRoleSchema = z.enum(["CLIENT", "WORKER", "BOTH"]);
export type DeviceRole = z.infer<typeof deviceRoleSchema>;

export function canAcceptTasks(role: DeviceRole): boolean {
  return role === "WORKER" || role === "BOTH";
}

export function canReceiveEvents(role: DeviceRole): boolean {
  return role === "CLIENT" || role === "BOTH";
}

// ─────────────────────────────────────────────────────────────────────────────
// Types and Platforms
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Device type categorization.
 *
 * `BROWSER_WORKER`: represents headless browser execution worker.
 */
export const deviceTypeSchema = z.enum([
  "IPHONE",
  "ANDROID",
  "WINDOWS_PC",
  "MAC",
  "LINUX",
  "BROWSER_WORKER",
]);
export type DeviceType = z.infer<typeof deviceTypeSchema>;

export const devicePlatformSchema = z.enum(["WINDOWS", "MACOS", "LINUX", "IOS", "ANDROID", "WEB"]);
export type DevicePlatform = z.infer<typeof devicePlatformSchema>;

/** Distinguishes physical human-associated hardware from headless service workers. */
export function isPhysicalDevice(type: DeviceType): boolean {
  return type !== "BROWSER_WORKER";
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

export const deviceStatusSchema = z.enum(["ONLINE", "OFFLINE", "DEGRADED", "REVOKED"]);
export type DeviceStatus = z.infer<typeof deviceStatusSchema>;

/**
 * Trust lifecycle state.
 *
 * Freshly paired devices start in `PENDING` until explicit administrator approval.
 */
export const trustStateSchema = z.enum(["PENDING", "TRUSTED", "REVOKED"]);
export type TrustState = z.infer<typeof trustStateSchema>;

export const gpuResourceInfoSchema = z.object({
  vendor: z.enum(["nvidia", "amd", "apple", "intel", "unknown"]),
  model: z.string(),
  totalVramMb: z.number().nonnegative(),
  freeVramMb: z.number().nonnegative(),
  computeUtilizationPercent: z.number().min(0).max(100),
  temperatureCelsius: z.number().optional(),
  driverVersion: z.string().optional(),
});
export type GpuResourceInfo = z.infer<typeof gpuResourceInfoSchema>;

export const deviceHealthSchema = z.object({
  /** CPU load average from 0 to 1. */
  cpuLoad: z.number().min(0).max(1).optional(),
  memoryFreeMb: z.number().nonnegative().optional(),
  diskFreeMb: z.number().nonnegative().optional(),
  batteryPercent: z.number().min(0).max(100).optional(),
  /** Running on battery power: plugged-in workers preferred for long operations. */
  onBattery: z.boolean().optional(),
  /** Measured round-trip latency on last heartbeat. */
  latencyMs: z.number().nonnegative().optional(),
  /** Currently active tasks running on this device. */
  activeTasks: z.number().int().nonnegative().default(0),
  /** Maximum task concurrency limit. */
  maxConcurrentTasks: z.number().int().positive().default(1),
  /** GPU accelerators reported on worker. */
  gpuResources: z.array(gpuResourceInfoSchema).optional(),
  reportedAt: z.string().optional(),
});
export type DeviceHealth = z.infer<typeof deviceHealthSchema>;

export const DEFAULT_HEALTH: DeviceHealth = { activeTasks: 0, maxConcurrentTasks: 1 };

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Advertised worker capability.
 *
 * Follows `domain.action` namespace matching permission definitions.
 */
export const deviceCapabilitySchema = z.object({
  name: z.string().regex(/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/, "expected format: domain.action"),
  version: z.string().default("1"),
  /** Capability description exposed to LLM when projected as an agent tool. */
  description: z.string().default(""),
  /** JSON schema of accepted parameters. */
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  /** Toggles individual capabilities without deregistering device. */
  enabled: z.boolean().default(true),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type DeviceCapability = z.infer<typeof deviceCapabilitySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Credentials
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cryptographic device credential record.
 *
 * Only public keys or hashes are stored; raw private secrets are never persisted.
 */
export const deviceCredentialSchema = z.object({
  id: z.string().min(1),
  deviceId: z.string().min(1),
  kind: z.enum(["ED25519_PUBLIC_KEY", "ECDSA_P256_PUBLIC_KEY", "SERVICE_TOKEN_HASH"]),
  material: z.string().min(1),
  createdAt: z.date(),
  rotatedAt: z.date().nullable().default(null),
  expiresAt: z.date().nullable().default(null),
  revokedAt: z.date().nullable().default(null),
});
export type DeviceCredential = z.infer<typeof deviceCredentialSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Device
// ─────────────────────────────────────────────────────────────────────────────

export const deviceSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().min(1),
  type: deviceTypeSchema,
  platform: devicePlatformSchema,
  role: deviceRoleSchema,
  status: deviceStatusSchema,
  trust: trustStateSchema,
  capabilities: z.array(deviceCapabilitySchema).default([]),
  health: deviceHealthSchema.default(DEFAULT_HEALTH),
  /** Device-specific permissions granted in addition to user-level permissions. */
  grantedPermissions: z.array(z.string()).default([]),
  agentVersion: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.string()).default({}),
  lastSeenAt: z.date().nullable().default(null),
  pairedAt: z.date(),
  revokedAt: z.date().nullable().default(null),
  /** True while authenticated session is active. */
  authenticated: z.boolean().default(false),
});
export type Device = z.infer<typeof deviceSchema>;

export interface RegisterDeviceInput {
  id?: string;
  userId: string;
  name: string;
  type: DeviceType;
  platform: DevicePlatform;
  role: DeviceRole;
  capabilities?: DeviceCapability[];
  grantedPermissions?: string[];
  metadata?: Record<string, string>;
  agentVersion?: string;
  trust?: TrustState;
}

// ─────────────────────────────────────────────────────────────────────────────
// Device Session
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authenticated active device session.
 */
export const deviceSessionSchema = z.object({
  id: z.string().min(1),
  deviceId: z.string().min(1),
  userId: z.string().min(1),
  tokenHash: z.string().min(1),
  issuedAt: z.date(),
  expiresAt: z.date(),
  lastHeartbeatAt: z.date(),
  rotatedFromId: z.string().nullable().default(null),
  revokedAt: z.date().nullable().default(null),
  capabilities: z.array(z.string()).default([]),
  remoteAddress: z.string().nullable().default(null),
});
export type DeviceSession = z.infer<typeof deviceSessionSchema>;

export function isSessionActive(session: DeviceSession, now: Date): boolean {
  return session.revokedAt === null && session.expiresAt.getTime() > now.getTime();
}

/** Operational check: device is online, trusted, not revoked, and actively authenticated. */
export function isOperational(device: Device): boolean {
  return (
    device.status === "ONLINE" &&
    device.trust === "TRUSTED" &&
    device.revokedAt === null &&
    device.authenticated
  );
}
