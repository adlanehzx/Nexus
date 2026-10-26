import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { redact, truncate } from "@nexus/shared";

/**
 * What the supervision dashboard is allowed to see.
 *
 * Two bounded stores — application logs and security events —
 * and the **projections** that decide what leaves the system.
 *
 * Projection is the core of this file, and its rationale fits in one
 * line: **the model's reasoning never leaves.** An agent run contains
 * its complete transcript, including provider reasoning blocks
 * (`LlmMessage.providerBlocks`). These blocks exist to be replayed in the
 * next turn, not to be read — not by the agent core, not by an interface,
 * not by the person supervising.
 *
 * This guarantee is achieved **by construction, not by filtering**: the projection
 * only reads `AgentRunRecord`, never `AgentState.messages`. One cannot forget
 * to mask a field one cannot access.
 *
 * What leaves, and nothing else: status, action, tool, progress, result,
 * error, metrics.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Application logs
// ─────────────────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  at: string;
  level: LogLevel;
  message: string;
  /** Correlation identifier, when the line originates from a request. */
  correlationId: string | null;
  /** Retained structured fields. Redacted, and bounded. */
  context: Record<string, unknown>;
}

/**
 * Pino levels.
 *
 * Two forms coexist, and both must be accepted: pino writes an
 * **integer** by default, but this repository configures `formatters.level`
 * to write a **label**. Recognizing only the former would silently drop
 * all real lines to `info` — and a dashboard where everything is `info`
 * is useless.
 */
const PINO_LEVELS: Record<number, LogLevel> = {
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

const LEVEL_LABELS = new Set<string>(["debug", "info", "warn", "error", "fatal"]);

function toLevel(value: unknown): LogLevel {
  if (typeof value === "number") return PINO_LEVELS[value] ?? "info";
  if (typeof value === "string" && LEVEL_LABELS.has(value)) return value as LogLevel;
  return "info";
}

/** Same story for timestamp: epoch integer by default, ISO here. */
function toIso(value: unknown): string {
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

/**
 * Bounded ring buffer of recent log lines.
 *
 * **Bounded**, because an unbounded log buffer eventually crashes
 * the process it was supposed to diagnose.
 *
 * Implements a pino destination interface (`write(line)`), allowing it
 * to be plugged in parallel with standard output without an extra layer.
 * Tests feed it with the same NDJSON lines pino produces — the real
 * format is tested, not a mock.
 */
export class LogBuffer {
  readonly #entries: LogEntry[] = [];
  readonly #max: number;
  readonly #filePath: string | undefined;

  constructor(options: { max?: number; filePath?: string } = {}) {
    this.#max = options.max ?? 500;
    this.#filePath = options.filePath;
    this.#entries.push(...readJsonLines<LogEntry>(options.filePath, this.#max));
  }

  /** Pino destination. One NDJSON line per call. */
  write(line: string): void {
    const entry = parseLogLine(line);
    if (entry !== undefined) this.push(entry);
  }

  push(entry: LogEntry): void {
    this.#entries.push(entry);
    if (this.#entries.length > this.#max) this.#entries.splice(0, this.#entries.length - this.#max);
    persistJsonLines(this.#filePath, this.#entries);
  }

  /** Most recent first. */
  list(filter: { level?: LogLevel; limit?: number; search?: string } = {}): LogEntry[] {
    const minimum = filter.level === undefined ? 0 : SEVERITY[filter.level];
    const needle = filter.search?.toLowerCase();

    const matching = this.#entries.filter((entry) => {
      if (SEVERITY[entry.level] < minimum) return false;
      if (needle === undefined) return true;
      return entry.message.toLowerCase().includes(needle);
    });

    return matching.slice(-(filter.limit ?? 100)).reverse();
  }

  get size(): number {
    return this.#entries.length;
  }
}

const SEVERITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };

/**
 * Decodes a pino line.
 *
 * Returns `undefined` for non-JSON input: a log destination must never throw.
 * It would be called from the error handler, where an exception turns
 * an incident into a crash.
 */
export function parseLogLine(line: string): LogEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (parsed === null || typeof parsed !== "object") return undefined;

  const {
    level,
    time,
    msg,
    correlationId,
    pid: _pid,
    hostname: _hostname,
    ...rest
  } = parsed as Record<string, unknown>;

  return {
    at: toIso(time),
    level: toLevel(level),
    message: typeof msg === "string" ? msg : "",
    correlationId: typeof correlationId === "string" ? correlationId : null,
    // Redaction at buffer ingestion. A line could carry a token inside
    // an innocently named field, and the dashboard would display it verbatim.
    context: redact(rest) as Record<string, unknown>,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Security events
// ─────────────────────────────────────────────────────────────────────────────

export type SecurityEventKind =
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "device.registered"
  /** Pairing ticket issued. Never the code, nor its fingerprint. */
  | "device.pairing_ticket_issued"
  /** Device created via QR scan, thus by physical presence. */
  | "device.paired"
  | "device.trusted"
  | "device.revoked"
  | "device.auth_failed"
  /** Global pause actuated. Reason accompanies the line. */
  | "system.paused"
  | "system.resumed"
  | "permission.denied"
  | "confirmation.requested"
  | "confirmation.answered"
  | "memory.refused"
  | "memory.consent_required"
  /** A submission was refused because the application was not approved. */
  | "career.submission_refused"
  /** A submission was attempted with no durable approval at all. */
  | "career.submission_unapproved"
  /** A submission was attempted for a payload the approval does not cover. */
  | "career.submission_payload_changed"
  /** The generic transition endpoint was used to reach a guarded state. */
  | "career.transition_guarded";

export interface SecurityEvent {
  at: string;
  kind: SecurityEventKind;
  /** `null` when event precedes identification — e.g. login failure. */
  userId: string | null;
  /** Displayable summary. Never contains secrets or raw content. */
  summary: string;
  context: Record<string, unknown>;
}

/**
 * Security event log.
 *
 * Distinct from application logs, not for convenience: these are typed
 * **domain events** that we want to count and filter. Finding them by
 * text search would be fragile, and a reworded log line would break
 * supervision silently.
 *
 * What never enters: a password, a token, memory content.
 * `record` redacts what it receives, but the real rule is upstream —
 * callers pass identifiers and categories, not secret values.
 */
export class SecurityLog {
  readonly #events: SecurityEvent[] = [];
  readonly #max: number;
  readonly #now: () => Date;
  readonly #filePath: string | undefined;

  constructor(options: { max?: number; now?: () => Date; filePath?: string } = {}) {
    this.#max = options.max ?? 500;
    this.#now = options.now ?? (() => new Date());
    this.#filePath = options.filePath;
    this.#events.push(...readJsonLines<SecurityEvent>(options.filePath, this.#max));
  }

  record(input: {
    kind: SecurityEventKind;
    userId?: string | null;
    summary: string;
    context?: Record<string, unknown>;
  }): SecurityEvent {
    const event: SecurityEvent = {
      at: this.#now().toISOString(),
      kind: input.kind,
      userId: input.userId ?? null,
      summary: truncate(input.summary, 200),
      context: redact(input.context ?? {}) as Record<string, unknown>,
    };

    this.#events.push(event);
    if (this.#events.length > this.#max) this.#events.splice(0, this.#events.length - this.#max);
    persistJsonLines(this.#filePath, this.#events);

    return event;
  }

  /** Most recent first. */
  list(filter: { kind?: SecurityEventKind; limit?: number } = {}): SecurityEvent[] {
    const matching =
      filter.kind === undefined
        ? this.#events
        : this.#events.filter((event) => event.kind === filter.kind);

    return matching.slice(-(filter.limit ?? 100)).reverse();
  }

  /** Count by kind over the retained window. */
  countByKind(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const event of this.#events) counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    return counts;
  }

  get size(): number {
    return this.#events.length;
  }
}

function readJsonLines<T>(filePath: string | undefined, maximum: number): T[] {
  if (filePath === undefined) return [];
  try {
    return readFileSync(filePath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(-maximum)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw cause;
  }
}

function persistJsonLines<T>(filePath: string | undefined, entries: readonly T[]): void {
  if (filePath === undefined) return;
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, filePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent run projection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a run exposes.
 *
 * Comparing with `AgentRunRecord` is instructive: there is **no**
 * `messages` field, no `providerBlocks`, no transcript. This type is
 * the boundary, and being strictly smaller than the source is the goal.
 */
export interface AgentRunView {
  runId: string;
  userId: string;
  conversationId: string;
  correlationId: string;
  missionExternalKey: string | null;
  replayOfRunId: string | null;
  status: string;
  stopReason: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  iterations: number;
  /** Final response returned to user. A result, not reasoning. */
  response: string | null;
  tools: {
    callId: string;
    tool: string;
    riskLevel: string;
    status: string;
    durationMs: number;
    attempts: number;
    /** Redacted and bounded argument summary. Never the full object. */
    action: string;
    errorCode: string | null;
  }[];
  errors: { at: string; code: string; message: string; iteration: number }[];
  metrics: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    toolCalls: number;
    failedToolCalls: number;
    fallbackCount: number;
  };
}

/**
 * Minimal run shape as read by projection.
 *
 * Structural, and deliberately restricted to `record`: `@nexus/agent-core`
 * is not imported here, and crucially **`messages` does not appear anywhere**.
 * The guarantee of non-disclosure of reasoning is not a policy applied in passing,
 * it is the type shape of this signature.
 */
export interface ProjectableRun {
  record: {
    runId: string;
    userId: string;
    conversationId: string;
    correlationId: string;
    missionExternalKey?: string | null;
    replayOfRunId?: string | null;
    fallbackCount?: number;
    startTime: string;
    endTime: string | null;
    status: string;
    stopReason: string | null;
    iterations: number;
    model: string;
    response: string | null;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    toolsUsed: readonly {
      toolCallId: string;
      name: string;
      riskLevel: string;
      status: string;
      durationMs: number;
      attempts: number;
      input: unknown;
      errorCode?: string;
    }[];
    errors: readonly { at: string; code: string; message: string; iteration: number }[];
  };
}

export function projectAgentRun(run: ProjectableRun): AgentRunView {
  const { record } = run;
  const failed = record.toolsUsed.filter((tool) => tool.status !== "success").length;

  return {
    runId: record.runId,
    userId: record.userId,
    conversationId: record.conversationId,
    correlationId: record.correlationId,
    missionExternalKey: record.missionExternalKey ?? null,
    replayOfRunId: record.replayOfRunId ?? null,
    status: record.status,
    stopReason: record.stopReason,
    startedAt: record.startTime,
    endedAt: record.endTime,
    durationMs:
      record.endTime === null
        ? null
        : new Date(record.endTime).getTime() - new Date(record.startTime).getTime(),
    iterations: record.iterations,
    response: record.response,
    tools: record.toolsUsed.map((tool) => ({
      callId: tool.toolCallId,
      tool: tool.name,
      riskLevel: tool.riskLevel,
      status: tool.status,
      durationMs: tool.durationMs,
      attempts: tool.attempts,
      action: summarizeArguments(tool.input),
      errorCode: tool.errorCode ?? null,
    })),
    errors: record.errors.map((error) => ({ ...error })),
    metrics: {
      model: record.model,
      inputTokens: record.usage.inputTokens,
      outputTokens: record.usage.outputTokens,
      cacheReadTokens: record.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: record.usage.cacheWriteTokens ?? 0,
      toolCalls: record.toolsUsed.length,
      failedToolCalls: failed,
      fallbackCount: record.fallbackCount ?? 0,
    },
  };
}

/**
 * Tool call argument summary.
 *
 * A tool name alone is insufficient for supervision: "terminal.execute"
 * does not indicate what command was executed. We return a single line,
 * but **redacted then bounded** — the run trace already redacts arguments,
 * and redacting a second time costs nothing for an egress path that is public.
 */
export function summarizeArguments(input: unknown): string {
  if (input === null || input === undefined) return "";

  const safe = redact(input);
  const text = typeof safe === "string" ? safe : JSON.stringify(safe);

  return truncate(text ?? "", 200);
}
