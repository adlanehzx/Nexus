import { z } from "zod";

/**
 * Contract between TypeScript backend and Python Browser Worker.
 *
 * This is the single boundary between both environments (ADR-006).
 * Schemas are exported to JSON Schema (`scripts/emit-contract.ts`) and checked
 * by Python contract tests.
 */

export const BROWSER_PROTOCOL_VERSION = 1;

/**
 * Declared task intent.
 * Dictates risk level on agent side and strict execution constraints on worker side.
 */
export const browserIntentSchema = z.enum(["read", "interact", "login", "purchase"]);
export type BrowserIntent = z.infer<typeof browserIntentSchema>;

/** Permissions required per intent. Cumulative: `purchase` implies all. */
export const INTENT_PERMISSIONS: Record<BrowserIntent, readonly string[]> = {
  read: ["browser.navigate", "browser.read"],
  interact: ["browser.navigate", "browser.read", "browser.interact"],
  login: ["browser.navigate", "browser.read", "browser.interact", "browser.login"],
  purchase: [
    "browser.navigate",
    "browser.read",
    "browser.interact",
    "browser.login",
    "browser.purchase",
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

export const createSessionRequestSchema = z.object({
  /** User partition key ensuring state isolation between accounts. */
  ownerId: z.string().min(1),
  /** Navigation boundaries. Empty array = unrestricted on worker side. */
  allowedDomains: z.array(z.string()).default([]),
  prohibitedDomains: z.array(z.string()).default([]),
  /** Reuses persistent profile (login cookies), encrypted at rest. */
  profileId: z.string().optional(),
  headless: z.boolean().default(true),
  ttlSeconds: z.number().int().positive().max(3600).default(600),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type CreateSessionRequest = z.input<typeof createSessionRequestSchema>;

export const sessionStatusSchema = z.enum(["open", "closing", "closed", "expired"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionSchema = z.object({
  sessionId: z.string().min(1),
  ownerId: z.string().min(1),
  status: sessionStatusSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  currentUrl: z.string().nullable(),
  activeTaskId: z.string().nullable(),
});
export type BrowserSession = z.infer<typeof sessionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────────────────────────────────────

export const runTaskRequestSchema = z.object({
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  instructions: z.string().min(1).max(4_000),
  intent: browserIntentSchema,
  maxSteps: z.number().int().positive().max(50).default(15),
  timeoutSeconds: z.number().int().positive().max(900).default(180),
  /**
   * Site credentials passed to browser-use as `sensitive_data`.
   * Redacted from logs and model reasoning traces.
   */
  secrets: z.record(z.string(), z.string()).default({}),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type RunTaskRequest = z.input<typeof runTaskRequestSchema>;

export const taskStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timeout",
  /** Requires human intervention (CAPTCHA, MFA). */
  "needs_human",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

const eventBase = {
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.string(),
};

export const browserEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("started"), intent: browserIntentSchema }),
  z.object({
    ...eventBase,
    type: z.literal("navigation"),
    url: z.string(),
    title: z.string().nullable(),
  }),
  z.object({ ...eventBase, type: z.literal("thinking"), text: z.string() }),
  z.object({
    ...eventBase,
    type: z.literal("action"),
    action: z.string(),
    target: z.string().nullable(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("progress"),
    step: z.number().int().nonnegative(),
    maxSteps: z.number().int().positive(),
    note: z.string().nullable(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("result"),
    output: z.string(),
    screenshotRef: z.string().nullable(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("finished"),
    status: taskStatusSchema,
    steps: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
  }),
]);
export type BrowserEvent = z.infer<typeof browserEventSchema>;
export type BrowserEventType = BrowserEvent["type"];

export const taskSchema = z.object({
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  status: taskStatusSchema,
  intent: browserIntentSchema,
  steps: z.number().int().nonnegative(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  output: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
  events: z.array(browserEventSchema).default([]),
});
export type BrowserTask = z.infer<typeof taskSchema>;

export const healthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  protocolVersion: z.number().int(),
  browserUseVersion: z.string().nullable(),
  openSessions: z.number().int().nonnegative(),
  runningTasks: z.number().int().nonnegative(),
});
export type BrowserWorkerHealth = z.infer<typeof healthSchema>;

export const workerErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
});

/** Worker error codes. Public API contract. */
export const BrowserErrorCode = {
  INVALID_REQUEST: "BROWSER_INVALID_REQUEST",
  SESSION_NOT_FOUND: "BROWSER_SESSION_NOT_FOUND",
  SESSION_EXPIRED: "BROWSER_SESSION_EXPIRED",
  TASK_NOT_FOUND: "BROWSER_TASK_NOT_FOUND",
  SESSION_BUSY: "BROWSER_SESSION_BUSY",
  DOMAIN_BLOCKED: "BROWSER_DOMAIN_BLOCKED",
  INTENT_FORBIDDEN: "BROWSER_INTENT_FORBIDDEN",
  HUMAN_REQUIRED: "BROWSER_HUMAN_INTERVENTION_REQUIRED",
  TIMEOUT: "BROWSER_TASK_TIMEOUT",
  CANCELLED: "BROWSER_TASK_CANCELLED",
  UNAVAILABLE: "BROWSER_WORKER_UNAVAILABLE",
} as const;
