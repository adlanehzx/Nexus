import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);

export const collaborationLimitsSchema = z.object({
  maxHops: z.number().int().min(1).max(64),
  maxTokens: z.number().int().min(1).max(1_000_000),
  maxDurationMs: z.number().int().min(1).max(86_400_000),
  maxRecursionDepth: z.number().int().min(0).max(16),
  consensusThreshold: z.number().min(0.5).max(1),
  mandatoryCrossReview: z.boolean(),
});

export type CollaborationLimits = z.infer<typeof collaborationLimitsSchema>;

export const collaborationAgentSchema = z.object({
  id: identifier,
  capabilities: z.array(identifier).max(64),
  permissions: z.array(identifier).max(64),
});

export type CollaborationAgent = z.infer<typeof collaborationAgentSchema>;

export const startCollaborationSessionSchema = z
  .object({
    actorId: identifier,
    agents: z.array(collaborationAgentSchema).min(2).max(32),
    limits: collaborationLimitsSchema,
  })
  .strict();

export const collaborationActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message"),
      actorId: identifier,
      recipientId: identifier,
      parentEventId: z.string().uuid().nullable().optional(),
      tokenCount: z.number().int().positive(),
      payloadType: z.enum(["claim", "critique", "question", "answer", "proposal"]),
      content: z.string().min(1).max(100_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("debate"),
      actorId: identifier,
      debateId: identifier,
      proposition: z.string().min(1).max(20_000),
      participantIds: z.array(identifier).min(2).max(16),
    })
    .strict(),
  z
    .object({
      kind: z.literal("vote"),
      actorId: identifier,
      debateId: identifier,
      choice: z.enum(["approve", "reject", "abstain"]),
      rationale: z.string().min(1).max(5_000),
    })
    .strict(),
  z.object({ kind: z.literal("consensus"), actorId: identifier, debateId: identifier }).strict(),
  z
    .object({
      kind: z.literal("review"),
      actorId: identifier,
      subjectEventId: z.string().uuid(),
      decision: z.enum(["approved", "changes_requested"]),
      findings: z.array(z.string().min(1).max(2_000)).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("role"),
      actorId: identifier,
      agentId: identifier,
      role: identifier,
      requiredCapabilities: z.array(identifier).max(32),
      requiredPermissions: z.array(identifier).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal("revision"),
      actorId: identifier,
      previousRevision: z.number().int().nonnegative(),
      operations: z
        .array(
          z
            .object({
              operation: z.enum(["add", "replace", "remove"]),
              taskKey: identifier,
              instruction: z.string().min(1).max(20_000).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(32),
      reason: z.string().min(1).max(5_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bid"),
      actorId: identifier,
      taskKey: identifier,
      virtualScore: z.number().min(0).max(100),
      rationale: z.string().min(1).max(5_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("arbitration"),
      actorId: identifier,
      debateId: identifier,
      decision: z.string().min(1).max(20_000),
      evidenceEventIds: z.array(z.string().uuid()).min(1).max(64),
    })
    .strict(),
]);

export type CollaborationAction = z.infer<typeof collaborationActionSchema>;

const sessionStartedDataSchema = z.object({
  limits: collaborationLimitsSchema,
  agents: z.array(collaborationAgentSchema).min(2).max(32),
});

const eventDataSchemas = {
  session_started: sessionStartedDataSchema,
  message: z.object({
    recipientId: identifier,
    parentEventId: z.string().uuid().nullable(),
    path: z.array(identifier).min(2).max(65),
    hop: z.number().int().positive(),
    recursionDepth: z.number().int().nonnegative(),
    tokenCount: z.number().int().positive(),
    payloadType: z.enum(["claim", "critique", "question", "answer", "proposal"]),
    content: z.string().min(1).max(100_000),
  }),
  debate_opened: z.object({
    debateId: identifier,
    proposition: z.string().min(1).max(20_000),
    participantIds: z.array(identifier).min(2).max(16),
  }),
  vote_cast: z.object({
    debateId: identifier,
    choice: z.enum(["approve", "reject", "abstain"]),
    rationale: z.string().min(1).max(5_000),
  }),
  consensus_recorded: z.object({
    debateId: identifier,
    outcome: z.enum(["approved", "rejected", "no_consensus"]),
    approvalRatio: z.number().min(0).max(1),
    voteEventIds: z.array(z.string().uuid()),
  }),
  review_recorded: z.object({
    subjectEventId: z.string().uuid(),
    decision: z.enum(["approved", "changes_requested"]),
    findings: z.array(z.string().min(1).max(2_000)).max(64),
  }),
  role_assigned: z.object({
    agentId: identifier,
    role: identifier,
    requiredCapabilities: z.array(identifier).max(32),
    requiredPermissions: z.array(identifier).max(32),
  }),
  plan_revised: z.object({
    revision: z.number().int().positive(),
    previousRevision: z.number().int().nonnegative(),
    operations: z
      .array(
        z.object({
          operation: z.enum(["add", "replace", "remove"]),
          taskKey: identifier,
          instruction: z.string().min(1).max(20_000).optional(),
        }),
      )
      .min(1)
      .max(32),
    reason: z.string().min(1).max(5_000),
  }),
  bid_placed: z
    .object({
      taskKey: identifier,
      virtualScore: z.number().min(0).max(100),
      rationale: z.string().min(1).max(5_000),
    })
    .strict(),
  arbitration_recorded: z.object({
    debateId: identifier,
    decision: z.string().min(1).max(20_000),
    evidenceEventIds: z.array(z.string().uuid()).min(1).max(64),
  }),
} as const;

export type CollaborationEventType = keyof typeof eventDataSchemas;

export interface CollaborationEvent {
  id: string;
  sessionId: string;
  sequence: number;
  actorId: string;
  occurredAt: string;
  type: CollaborationEventType;
  data: Record<string, unknown>;
}

const collaborationEventSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  sequence: z.number().int().positive(),
  actorId: identifier,
  occurredAt: z.iso.datetime({ offset: true }),
  type: z.enum(
    Object.keys(eventDataSchemas) as [CollaborationEventType, ...CollaborationEventType[]],
  ),
  data: z.record(z.string(), z.unknown()),
});

export class CollaborationBoundaryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CollaborationBoundaryError";
    this.code = code;
  }
}

export interface CollaborationLedger {
  append(event: Omit<CollaborationEvent, "sequence">): Promise<CollaborationEvent>;
  read(sessionId: string): Promise<CollaborationEvent[]>;
}

/** Personal-mode durable ledger. Production can replace this port with PostgreSQL. */
export class FileCollaborationLedger implements CollaborationLedger {
  readonly #path: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async append(event: Omit<CollaborationEvent, "sequence">): Promise<CollaborationEvent> {
    let recorded: CollaborationEvent | undefined;
    const operation = this.#writeQueue.then(async () => {
      const existing = await this.#readAll();
      recorded = validateEvent({ ...event, sequence: existing.length + 1 });
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      await appendFile(this.#path, `${JSON.stringify(recorded)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
    if (recorded === undefined) throw new Error("Collaboration event was not persisted");
    return recorded;
  }

  async read(sessionId: string): Promise<CollaborationEvent[]> {
    await this.#writeQueue;
    return (await this.#readAll()).filter((event) => event.sessionId === sessionId);
  }

  async #readAll(): Promise<CollaborationEvent[]> {
    let contents: string;
    try {
      contents = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return contents
      .split("\n")
      .filter(Boolean)
      .map((line) => validateEvent(JSON.parse(line) as unknown));
  }
}

export class InMemoryCollaborationLedger implements CollaborationLedger {
  readonly #events: CollaborationEvent[] = [];

  append(event: Omit<CollaborationEvent, "sequence">): Promise<CollaborationEvent> {
    const recorded = validateEvent({ ...event, sequence: this.#events.length + 1 });
    this.#events.push(recorded);
    return Promise.resolve(recorded);
  }

  read(sessionId: string): Promise<CollaborationEvent[]> {
    return Promise.resolve(this.#events.filter((event) => event.sessionId === sessionId));
  }
}

interface SessionState {
  limits: CollaborationLimits;
  agents: Map<string, CollaborationAgent>;
  startedAt: number;
  events: CollaborationEvent[];
}

export class AdvancedCollaborationCoordinator {
  readonly #ledger: CollaborationLedger;
  readonly #now: () => Date;

  constructor(ledger: CollaborationLedger, now: () => Date = () => new Date()) {
    this.#ledger = ledger;
    this.#now = now;
  }

  async start(input: {
    actorId: string;
    agents: CollaborationAgent[];
    limits: CollaborationLimits;
  }): Promise<CollaborationEvent> {
    const data = sessionStartedDataSchema.parse({ agents: input.agents, limits: input.limits });
    if (!data.agents.some((agent) => agent.id === input.actorId)) {
      throw new CollaborationBoundaryError(
        "unknown_actor",
        "The session creator must be a participant",
      );
    }
    if (new Set(data.agents.map((agent) => agent.id)).size !== data.agents.length) {
      throw new CollaborationBoundaryError("duplicate_agent", "Agent IDs must be unique");
    }
    return this.#append(randomUUID(), input.actorId, "session_started", data);
  }

  async sendMessage(
    sessionId: string,
    input: {
      actorId: string;
      recipientId: string;
      parentEventId?: string | null | undefined;
      tokenCount: number;
      payloadType: "claim" | "critique" | "question" | "answer" | "proposal";
      content: string;
    },
  ): Promise<CollaborationEvent> {
    const state = await this.#state(sessionId);
    this.#requirePermission(state, input.actorId, "collaboration.message");
    this.#requireAgent(state, input.recipientId);
    const messages = state.events.filter((event) => event.type === "message");
    const parent =
      input.parentEventId == null
        ? undefined
        : messages.find((event) => event.id === input.parentEventId);
    if (input.parentEventId != null && parent === undefined) {
      throw new CollaborationBoundaryError("unknown_parent", "Parent message does not exist");
    }
    const parentData = parent?.data as { path?: string[]; recursionDepth?: number } | undefined;
    const path = [...(parentData?.path ?? [input.actorId]), input.recipientId];
    if (new Set(path).size !== path.length) {
      throw new CollaborationBoundaryError("cycle_detected", "Conversation path contains a cycle");
    }
    const hop = messages.length + 1;
    const recursionDepth = (parentData?.recursionDepth ?? -1) + 1;
    const usedTokens = messages.reduce(
      (total, event) => total + Number((event.data as { tokenCount?: number }).tokenCount ?? 0),
      0,
    );
    this.#assertBudget(state, {
      hop,
      tokens: usedTokens + input.tokenCount,
      recursionDepth,
    });
    return this.#append(sessionId, input.actorId, "message", {
      recipientId: input.recipientId,
      parentEventId: input.parentEventId ?? null,
      path,
      hop,
      recursionDepth,
      tokenCount: input.tokenCount,
      payloadType: input.payloadType,
      content: input.content,
    });
  }

  async openDebate(
    sessionId: string,
    input: { actorId: string; debateId: string; proposition: string; participantIds: string[] },
  ): Promise<CollaborationEvent> {
    const state = await this.#state(sessionId);
    this.#requirePermission(state, input.actorId, "collaboration.debate");
    for (const participant of input.participantIds) this.#requireAgent(state, participant);
    return this.#append(sessionId, input.actorId, "debate_opened", input);
  }

  async castVote(
    sessionId: string,
    input: {
      actorId: string;
      debateId: string;
      choice: "approve" | "reject" | "abstain";
      rationale: string;
    },
  ): Promise<CollaborationEvent> {
    const state = await this.#state(sessionId);
    this.#requirePermission(state, input.actorId, "collaboration.vote");
    this.#debate(state, input.debateId);
    const duplicate = state.events.some(
      (event) =>
        event.type === "vote_cast" &&
        event.actorId === input.actorId &&
        event.data.debateId === input.debateId,
    );
    if (duplicate) throw new CollaborationBoundaryError("duplicate_vote", "An agent may vote once");
    return this.#append(sessionId, input.actorId, "vote_cast", input);
  }

  async recordConsensus(
    sessionId: string,
    input: { actorId: string; debateId: string },
  ): Promise<CollaborationEvent> {
    const state = await this.#state(sessionId);
    this.#requirePermission(state, input.actorId, "collaboration.arbitrate");
    const debate = this.#debate(state, input.debateId);
    const participantIds = (debate.data as { participantIds: string[] }).participantIds;
    const votes = state.events.filter(
      (event) => event.type === "vote_cast" && event.data.debateId === input.debateId,
    );
    const approvals = votes.filter((event) => event.data.choice === "approve").length;
    const rejections = votes.filter((event) => event.data.choice === "reject").length;
    const approvalRatio = participantIds.length === 0 ? 0 : approvals / participantIds.length;
    let outcome: "approved" | "rejected" | "no_consensus" = "no_consensus";
    if (approvalRatio >= state.limits.consensusThreshold) outcome = "approved";
    else if (rejections / participantIds.length >= state.limits.consensusThreshold) {
      outcome = "rejected";
    }
    if (state.limits.mandatoryCrossReview && outcome !== "no_consensus") {
      const reviewed = state.events.some(
        (event) =>
          event.type === "review_recorded" &&
          event.data.subjectEventId === debate.id &&
          event.data.decision === "approved" &&
          event.actorId !== debate.actorId,
      );
      if (!reviewed) {
        throw new CollaborationBoundaryError(
          "cross_review_required",
          "Consensus requires approval from an independent reviewer",
        );
      }
    }
    return this.#append(sessionId, input.actorId, "consensus_recorded", {
      debateId: input.debateId,
      outcome,
      approvalRatio,
      voteEventIds: votes.map((event) => event.id),
    });
  }

  async recordReview(
    sessionId: string,
    input: {
      actorId: string;
      subjectEventId: string;
      decision: "approved" | "changes_requested";
      findings: string[];
    },
  ): Promise<CollaborationEvent> {
    const state = await this.#state(sessionId);
    this.#requirePermission(state, input.actorId, "collaboration.review");
    const subject = state.events.find((event) => event.id === input.subjectEventId);
    if (subject === undefined)
      throw new CollaborationBoundaryError("unknown_subject", "Unknown review subject");
    if (subject.actorId === input.actorId) {
      throw new CollaborationBoundaryError("self_review", "Cross-review must be independent");
    }
    return this.#append(sessionId, input.actorId, "review_recorded", input);
  }

  async assignRole(
    sessionId: string,
    input: {
      actorId: string;
      agentId: string;
      role: string;
      requiredCapabilities: string[];
      requiredPermissions: string[];
    },
  ): Promise<CollaborationEvent> {
    const state = await this.#state(sessionId);
    this.#requirePermission(state, input.actorId, "collaboration.assign_role");
    const target = this.#requireAgent(state, input.agentId);
    if (!input.requiredCapabilities.every((item) => target.capabilities.includes(item))) {
      throw new CollaborationBoundaryError(
        "capability_denied",
        "Agent lacks a required capability",
      );
    }
    if (!input.requiredPermissions.every((item) => target.permissions.includes(item))) {
      throw new CollaborationBoundaryError(
        "permission_denied",
        "Agent lacks a required permission",
      );
    }
    return this.#append(sessionId, input.actorId, "role_assigned", input);
  }

  async revisePlan(
    sessionId: string,
    input: {
      actorId: string;
      previousRevision: number;
      operations: {
        operation: "add" | "replace" | "remove";
        taskKey: string;
        instruction?: string | undefined;
      }[];
      reason: string;
    },
  ): Promise<CollaborationEvent> {
    const state = await this.#state(sessionId);
    this.#requirePermission(state, input.actorId, "collaboration.revise_plan");
    const revisions = state.events.filter((event) => event.type === "plan_revised");
    if (input.previousRevision !== revisions.length) {
      throw new CollaborationBoundaryError("stale_revision", "Plan revision is stale");
    }
    return this.#append(sessionId, input.actorId, "plan_revised", {
      ...input,
      revision: revisions.length + 1,
    });
  }

  async placeBid(
    sessionId: string,
    input: { actorId: string; taskKey: string; virtualScore: number; rationale: string },
  ): Promise<CollaborationEvent> {
    const state = await this.#state(sessionId);
    this.#requirePermission(state, input.actorId, "collaboration.bid");
    return this.#append(sessionId, input.actorId, "bid_placed", {
      taskKey: input.taskKey,
      virtualScore: input.virtualScore,
      rationale: input.rationale,
    });
  }

  async arbitrate(
    sessionId: string,
    input: { actorId: string; debateId: string; decision: string; evidenceEventIds: string[] },
  ): Promise<CollaborationEvent> {
    const state = await this.#state(sessionId);
    this.#requirePermission(state, input.actorId, "collaboration.arbitrate");
    this.#debate(state, input.debateId);
    if (!input.evidenceEventIds.every((id) => state.events.some((event) => event.id === id))) {
      throw new CollaborationBoundaryError(
        "unknown_evidence",
        "Arbitration evidence must be replayable",
      );
    }
    return this.#append(sessionId, input.actorId, "arbitration_recorded", input);
  }

  async replay(sessionId: string): Promise<CollaborationEvent[]> {
    return (await this.#state(sessionId)).events;
  }

  async execute(sessionId: string, rawAction: CollaborationAction): Promise<CollaborationEvent> {
    const action = collaborationActionSchema.parse(rawAction);
    switch (action.kind) {
      case "message":
        return this.sendMessage(sessionId, action);
      case "debate":
        return this.openDebate(sessionId, action);
      case "vote":
        return this.castVote(sessionId, action);
      case "consensus":
        return this.recordConsensus(sessionId, action);
      case "review":
        return this.recordReview(sessionId, action);
      case "role":
        return this.assignRole(sessionId, action);
      case "revision":
        return this.revisePlan(sessionId, action);
      case "bid":
        return this.placeBid(sessionId, action);
      case "arbitration":
        return this.arbitrate(sessionId, action);
    }
  }

  async #state(sessionId: string): Promise<SessionState> {
    const events = await this.#ledger.read(sessionId);
    const first = events[0];
    if (first?.type !== "session_started") {
      throw new CollaborationBoundaryError(
        "unknown_session",
        "Collaboration session does not exist",
      );
    }
    const data = sessionStartedDataSchema.parse(first.data);
    const state = {
      limits: data.limits,
      agents: new Map(data.agents.map((agent) => [agent.id, agent])),
      startedAt: Date.parse(first.occurredAt),
      events,
    };
    this.#assertTime(state);
    return state;
  }

  #assertTime(state: SessionState): void {
    if (this.#now().getTime() - state.startedAt > state.limits.maxDurationMs) {
      throw new CollaborationBoundaryError(
        "time_budget_exhausted",
        "Collaboration time budget exhausted",
      );
    }
  }

  #assertBudget(
    state: SessionState,
    usage: { hop: number; tokens: number; recursionDepth: number },
  ): void {
    this.#assertTime(state);
    if (usage.hop > state.limits.maxHops) {
      throw new CollaborationBoundaryError(
        "hop_budget_exhausted",
        "Collaboration hop budget exhausted",
      );
    }
    if (usage.tokens > state.limits.maxTokens) {
      throw new CollaborationBoundaryError(
        "token_budget_exhausted",
        "Collaboration token budget exhausted",
      );
    }
    if (usage.recursionDepth > state.limits.maxRecursionDepth) {
      throw new CollaborationBoundaryError(
        "recursion_budget_exhausted",
        "Collaboration recursion budget exhausted",
      );
    }
  }

  #requireAgent(state: SessionState, agentId: string): CollaborationAgent {
    const agent = state.agents.get(agentId);
    if (agent === undefined) throw new CollaborationBoundaryError("unknown_agent", "Unknown agent");
    return agent;
  }

  #requirePermission(state: SessionState, agentId: string, permission: string): void {
    const agent = this.#requireAgent(state, agentId);
    if (!agent.permissions.includes(permission)) {
      throw new CollaborationBoundaryError(
        "permission_denied",
        `Missing permission: ${permission}`,
      );
    }
  }

  #debate(state: SessionState, debateId: string): CollaborationEvent {
    const debate = state.events.find(
      (event) => event.type === "debate_opened" && event.data.debateId === debateId,
    );
    if (debate === undefined)
      throw new CollaborationBoundaryError("unknown_debate", "Unknown debate");
    return debate;
  }

  async #append(
    sessionId: string,
    actorId: string,
    type: CollaborationEventType,
    data: unknown,
  ): Promise<CollaborationEvent> {
    const schema = eventDataSchemas[type];
    const parsed = schema.parse(data) as Record<string, unknown>;
    return this.#ledger.append({
      id: randomUUID(),
      sessionId,
      actorId,
      occurredAt: this.#now().toISOString(),
      type,
      data: parsed,
    });
  }
}

function validateEvent(input: unknown): CollaborationEvent {
  const event = collaborationEventSchema.parse(input);
  const data = eventDataSchemas[event.type].parse(event.data) as Record<string, unknown>;
  return { ...event, data };
}
