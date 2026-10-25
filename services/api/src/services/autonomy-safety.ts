import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const proposalSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["CODE_CHANGE", "DEPLOYMENT"]),
  title: z.string().min(1).max(160),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  environment: z.enum(["development", "staging"]).nullable(),
  proposerId: z.string().min(1),
  createdAt: z.string().datetime(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().datetime().nullable(),
  confirmationHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  confirmationExpiresAt: z.string().datetime().nullable(),
});
export type SafetyProposal = z.infer<typeof proposalSchema>;
const proposalInputSchema = z.strictObject({
  kind: z.enum(["CODE_CHANGE", "DEPLOYMENT"]),
  title: z.string().min(1).max(160),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  environment: z.enum(["development", "staging"]).optional(),
  proposerId: z.string().min(1),
});

const permanentAgentSchema = z.strictObject({
  agentId: z.string().min(1),
  supervisorId: z.string().min(1),
  budgetUnits: z.number().int().positive(),
  consumedUnits: z.number().int().nonnegative(),
  paused: z.boolean(),
  emergencyStopped: z.boolean(),
  updatedAt: z.string().datetime(),
});
export type PermanentAgentContract = z.infer<typeof permanentAgentSchema>;

const federationEnvelopeSchema = z.strictObject({
  peerId: z.string().min(1),
  nonce: z.string().min(16).max(128),
  issuedAt: z.string().datetime(),
  kind: z.enum(["CAPABILITY_ADVERTISEMENT", "TASK_PROPOSAL", "STATUS"]),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
});
export type FederationEnvelope = z.infer<typeof federationEnvelopeSchema>;

const stateSchema = z.object({
  proposals: z.array(proposalSchema),
  agents: z.array(permanentAgentSchema),
  federationNonces: z.array(
    z.object({ peerId: z.string(), nonce: z.string(), acceptedAt: z.string().datetime() }),
  ),
});
type SafetyState = z.infer<typeof stateSchema>;

export class AutonomySafetyStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async read(): Promise<SafetyState> {
    try {
      return stateSchema.parse(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { proposals: [], agents: [], federationNonces: [] };
      throw error;
    }
  }

  async update(mutator: (state: SafetyState) => void): Promise<void> {
    const state = await this.read();
    mutator(state);
    const validated = stateSchema.parse(state);
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(validated), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.#path);
  }
}

export class AutonomySafetyController {
  readonly #store: AutonomySafetyStore;
  readonly #now: () => Date;
  readonly #peerKeys: ReadonlyMap<string, Buffer>;
  readonly #federationWindowMs: number;
  readonly #federationLimit: number;

  constructor(options: {
    store: AutonomySafetyStore;
    peerKeys?: ReadonlyMap<string, Uint8Array>;
    now?: () => Date;
    federationWindowMs?: number;
    federationLimit?: number;
  }) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#peerKeys = new Map(
      [...(options.peerKeys ?? new Map()).entries()].map(([id, key]) => [id, Buffer.from(key)]),
    );
    this.#federationWindowMs = options.federationWindowMs ?? 60_000;
    this.#federationLimit = options.federationLimit ?? 30;
  }

  async propose(input: {
    kind: "CODE_CHANGE" | "DEPLOYMENT";
    title: string;
    artifactHash: string;
    environment?: "development" | "staging";
    proposerId: string;
  }): Promise<{ proposal: SafetyProposal; confirmationToken: string | null }> {
    const validatedInput = proposalInputSchema.parse(input);
    const confirmationToken =
      validatedInput.kind === "DEPLOYMENT" ? randomBytes(24).toString("base64url") : null;
    const proposal = proposalSchema.parse({
      id: randomUUID(),
      kind: validatedInput.kind,
      title: validatedInput.title,
      artifactHash: validatedInput.artifactHash,
      environment:
        validatedInput.kind === "DEPLOYMENT" ? (validatedInput.environment ?? null) : null,
      proposerId: validatedInput.proposerId,
      createdAt: this.#now().toISOString(),
      status: "PENDING",
      approvedBy: null,
      approvedAt: null,
      confirmationHash: confirmationToken === null ? null : digest(confirmationToken),
      confirmationExpiresAt:
        confirmationToken === null ? null : new Date(this.#now().getTime() + 600_000).toISOString(),
    });
    if (proposal.kind === "DEPLOYMENT" && proposal.environment === null)
      throw new Error("Deployment proposals require a non-production environment");
    await this.#store.update((state) => void state.proposals.push(proposal));
    return { proposal, confirmationToken };
  }

  async decide(
    proposalId: string,
    approverId: string,
    decision: "APPROVE" | "REJECT",
    confirmationToken?: string,
  ): Promise<SafetyProposal> {
    let result: SafetyProposal | undefined;
    await this.#store.update((state) => {
      const proposal = state.proposals.find((item) => item.id === proposalId);
      if (proposal?.status !== "PENDING") throw new Error("Pending proposal is unavailable");
      if (proposal.proposerId === approverId)
        throw new Error("Independent human approval is required");
      if (decision === "APPROVE" && proposal.kind === "DEPLOYMENT") {
        if (
          confirmationToken === undefined ||
          proposal.confirmationHash === null ||
          proposal.confirmationExpiresAt === null
        )
          throw new Error("Deployment confirmation is required");
        if (
          this.#now() > new Date(proposal.confirmationExpiresAt) ||
          !safeEqual(digest(confirmationToken), proposal.confirmationHash)
        )
          throw new Error("Deployment confirmation is invalid or expired");
      }
      proposal.status = decision === "APPROVE" ? "APPROVED" : "REJECTED";
      proposal.approvedBy = approverId;
      proposal.approvedAt = this.#now().toISOString();
      proposal.confirmationHash = null;
      proposal.confirmationExpiresAt = null;
      result = structuredClone(proposal);
    });
    return result!;
  }

  async registerPermanentAgent(
    contract: Omit<
      PermanentAgentContract,
      "consumedUnits" | "paused" | "emergencyStopped" | "updatedAt"
    >,
  ): Promise<PermanentAgentContract> {
    const value = permanentAgentSchema.parse({
      ...contract,
      consumedUnits: 0,
      paused: true,
      emergencyStopped: false,
      updatedAt: this.#now().toISOString(),
    });
    await this.#store.update((state) => {
      if (state.agents.some((agent) => agent.agentId === value.agentId))
        throw new Error("Agent contract already exists");
      state.agents.push(value);
    });
    return value;
  }

  async setAgentPaused(
    agentId: string,
    supervisorId: string,
    paused: boolean,
  ): Promise<PermanentAgentContract> {
    return this.#changeAgent(agentId, supervisorId, (agent) => {
      if (agent.emergencyStopped && !paused)
        throw new Error("Emergency-stopped agents cannot resume");
      agent.paused = paused;
    });
  }

  async consumeBudget(agentId: string, units: number): Promise<PermanentAgentContract> {
    if (!Number.isInteger(units) || units <= 0)
      throw new Error("Budget consumption must be a positive integer");
    let result: PermanentAgentContract | undefined;
    let exhausted = false;
    await this.#store.update((state) => {
      const agent = state.agents.find((item) => item.agentId === agentId);
      if (agent === undefined || agent.paused || agent.emergencyStopped)
        throw new Error("Agent is not allowed to run");
      if (agent.consumedUnits + units > agent.budgetUnits) {
        agent.paused = true;
        agent.updatedAt = this.#now().toISOString();
        exhausted = true;
        return;
      }
      agent.consumedUnits += units;
      agent.updatedAt = this.#now().toISOString();
      result = structuredClone(agent);
    });
    if (exhausted) throw new Error("Agent budget is exhausted");
    return result!;
  }

  async emergencyStop(agentId: string, supervisorId: string): Promise<PermanentAgentContract> {
    return this.#changeAgent(agentId, supervisorId, (agent) => {
      agent.paused = true;
      agent.emergencyStopped = true;
    });
  }

  async acceptFederation(envelope: FederationEnvelope): Promise<void> {
    const validated = federationEnvelopeSchema.parse(envelope);
    const key = this.#peerKeys.get(validated.peerId);
    if (key === undefined) throw new Error("Federation peer is not allowlisted");
    const age = Math.abs(this.#now().getTime() - new Date(validated.issuedAt).getTime());
    if (age > this.#federationWindowMs) throw new Error("Federation envelope is stale");
    const expected = signFederation({ ...validated, signature: "" }, key);
    if (!safeEqual(validated.signature, expected))
      throw new Error("Federation signature is invalid");
    await this.#store.update((state) => {
      if (
        state.federationNonces.some(
          (item) => item.peerId === validated.peerId && item.nonce === validated.nonce,
        )
      )
        throw new Error("Federation replay rejected");
      const cutoff = this.#now().getTime() - this.#federationWindowMs;
      state.federationNonces = state.federationNonces.filter(
        (item) => new Date(item.acceptedAt).getTime() >= cutoff,
      );
      if (
        state.federationNonces.filter((item) => item.peerId === validated.peerId).length >=
        this.#federationLimit
      )
        throw new Error("Federation rate limit exceeded");
      state.federationNonces.push({
        peerId: validated.peerId,
        nonce: validated.nonce,
        acceptedAt: this.#now().toISOString(),
      });
    });
  }

  async snapshot() {
    return this.#store.read();
  }

  async #changeAgent(
    agentId: string,
    supervisorId: string,
    mutate: (agent: PermanentAgentContract) => void,
  ): Promise<PermanentAgentContract> {
    let result: PermanentAgentContract | undefined;
    await this.#store.update((state) => {
      const agent = state.agents.find((item) => item.agentId === agentId);
      if (agent?.supervisorId !== supervisorId) throw new Error("Supervised agent is unavailable");
      mutate(agent);
      agent.updatedAt = this.#now().toISOString();
      result = structuredClone(agent);
    });
    return result!;
  }
}

export function signFederation(
  envelope: Omit<FederationEnvelope, "signature"> & { signature?: "" },
  key: Uint8Array,
): string {
  const body = [
    envelope.peerId,
    envelope.nonce,
    envelope.issuedAt,
    envelope.kind,
    envelope.payloadHash,
  ].join("\n");
  return createHmac("sha256", key).update(body).digest("hex");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
