import { createHash } from "node:crypto";
import { z } from "zod";
import { ConflictError, NotFoundError, uuidv7 } from "@nexus/shared";
import { riskLevelSchema, type RiskLevel } from "./risk.js";

/**
 * Human confirmation request.
 *
 * `payloadHash` binds decisions to exact arguments: preventing bait-and-switch attacks
 * where an agent alters arguments after user approval.
 */
export const confirmationStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
export type ConfirmationStatus = z.infer<typeof confirmationStatusSchema>;

export const confirmationRequestSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  userId: z.string().min(1),
  tool: z.string().min(1),
  toolCallId: z.string().min(1),
  action: z.string().min(1),
  description: z.string(),
  riskLevel: riskLevelSchema,
  payloadHash: z.string().length(64),
  status: confirmationStatusSchema,
  createdAt: z.date(),
  expiresAt: z.date(),
  decidedAt: z.date().nullable(),
});

export type ConfirmationRequest = z.infer<typeof confirmationRequestSchema>;

export interface ConfirmationStore {
  save(request: ConfirmationRequest): Promise<void>;
  get(id: string): Promise<ConfirmationRequest | undefined>;
  listPending(runId: string): Promise<ConfirmationRequest[]>;
}

export class InMemoryConfirmationStore implements ConfirmationStore {
  readonly #byId = new Map<string, ConfirmationRequest>();

  save(request: ConfirmationRequest): Promise<void> {
    this.#byId.set(request.id, request);
    return Promise.resolve();
  }

  get(id: string): Promise<ConfirmationRequest | undefined> {
    return Promise.resolve(this.#byId.get(id));
  }

  listPending(runId: string): Promise<ConfirmationRequest[]> {
    return Promise.resolve(
      [...this.#byId.values()].filter((r) => r.runId === runId && r.status === "pending"),
    );
  }
}

/** Stable payload hash: sorts keys recursively. */
export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export interface CreateConfirmationInput {
  runId: string;
  userId: string;
  tool: string;
  toolCallId: string;
  action: string;
  description: string;
  riskLevel: RiskLevel;
  payload: unknown;
}

export interface ConfirmationServiceOptions {
  store?: ConfirmationStore;
  ttlMs?: number;
  criticalTtlMs?: number;
  now?: () => Date;
  newId?: () => string;
}

/**
 * Human confirmation management service.
 * Requests are non-blocking; the agent execution loop suspends its state.
 */
export class ConfirmationService {
  readonly #store: ConfirmationStore;
  readonly #ttlMs: number;
  readonly #criticalTtlMs: number;
  readonly #now: () => Date;
  readonly #newId: () => string;

  constructor(options: ConfirmationServiceOptions = {}) {
    this.#store = options.store ?? new InMemoryConfirmationStore();
    this.#ttlMs = options.ttlMs ?? 10 * 60_000;
    this.#criticalTtlMs = options.criticalTtlMs ?? 2 * 60_000;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? uuidv7;
  }

  async request(input: CreateConfirmationInput): Promise<ConfirmationRequest> {
    const createdAt = this.#now();
    const ttl = input.riskLevel === "CRITICAL" ? this.#criticalTtlMs : this.#ttlMs;

    const request: ConfirmationRequest = {
      id: this.#newId(),
      runId: input.runId,
      userId: input.userId,
      tool: input.tool,
      toolCallId: input.toolCallId,
      action: input.action,
      description: input.description,
      riskLevel: input.riskLevel,
      payloadHash: hashPayload(input.payload),
      status: "pending",
      createdAt,
      expiresAt: new Date(createdAt.getTime() + ttl),
      decidedAt: null,
    };

    await this.#store.save(request);
    return request;
  }

  async get(id: string): Promise<ConfirmationRequest | undefined> {
    const request = await this.#store.get(id);
    if (!request) return undefined;
    return this.#expireIfDue(request);
  }

  /** Resolves confirmation request with human decision. */
  async resolve(id: string, decision: "approved" | "rejected"): Promise<ConfirmationRequest> {
    const existing = await this.#store.get(id);
    if (!existing) {
      throw new NotFoundError({
        message: `Unknown confirmation: ${id}`,
        userMessage: "This confirmation request no longer exists.",
        context: { confirmationId: id },
      });
    }

    const current = await this.#expireIfDue(existing);
    if (current.status !== "pending") {
      throw new ConflictError({
        message: `Confirmation already ${current.status}: ${id}`,
        userMessage:
          current.status === "expired"
            ? "This confirmation request expired. Please rerun the action if you still want it."
            : "This request has already been answered.",
        context: { confirmationId: id, status: current.status },
      });
    }

    const resolved: ConfirmationRequest = {
      ...current,
      status: decision,
      decidedAt: this.#now(),
    };
    await this.#store.save(resolved);
    return resolved;
  }

  /** Verifies that approved confirmation matches the exact intended tool arguments. */
  matchesPayload(request: ConfirmationRequest, payload: unknown): boolean {
    return request.payloadHash === hashPayload(payload);
  }

  async #expireIfDue(request: ConfirmationRequest): Promise<ConfirmationRequest> {
    if (request.status !== "pending" || request.expiresAt.getTime() > this.#now().getTime()) {
      return request;
    }
    const expired: ConfirmationRequest = { ...request, status: "expired" };
    await this.#store.save(expired);
    return expired;
  }
}
