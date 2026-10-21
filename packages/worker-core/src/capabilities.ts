import type { z } from "zod";
import type { RiskLevel } from "@nexus/tools";
import type { WorkerCapability } from "@nexus/protocol";
import { CapabilityInputError, CapabilityUnavailableError } from "./errors.js";

/**
 * Local capability registry.
 *
 * Distinct from ToolRegistry: ToolRegistry determines what agents can request,
 * whereas LocalCapabilityRegistry determines what this specific worker machine
 * can execute.
 *
 * Capabilities are declared only when:
 *  1. Available on the machine (probed successfully);
 *  2. Explicitly allowed in local configuration.
 */

export interface CapabilityContext {
  taskId: string;
  stepId: string;
  /** Cancellation signal triggered by orchestrator or worker shutdown. */
  signal: AbortSignal;
  timeoutMs: number;
  onProgress: (progress: { percent?: number; label?: string }) => void;
}

export interface LocalCapability<I = unknown, O = unknown> {
  name: string;
  description: string;
  version?: string;
  /** Argument validation schema. */
  inputSchema: z.ZodType<I>;
  /** JSON Schema representation advertised to LLMs. */
  inputJsonSchema?: Record<string, unknown>;
  riskLevel: RiskLevel;
  /** Dynamic machine availability probe. If omitted, considered always available. */
  probe?: () => Promise<boolean>;
  /**
   * If true, output payload is not permanently stored by orchestrator execution logs.
   * Useful for inherently sensitive data like device screenshots.
   */
  sensitiveResult?: boolean;
  /**
   * Argument keys whose values must be masked before logging.
   */
  secretArguments?: readonly string[];
  execute: (input: I, context: CapabilityContext) => Promise<O>;
}

export interface CapabilityDeclaration {
  capability: WorkerCapability;
  available: boolean;
  reason?: string;
}

export class LocalCapabilityRegistry {
  readonly #capabilities = new Map<string, LocalCapability<never, unknown>>();
  readonly #availability = new Map<string, boolean>();
  readonly #allowed: Set<string> | undefined;

  /**
   * @param allowed Allowed capabilities from configuration. Undefined or empty
   *   means all locally available capabilities are permitted.
   */
  constructor(allowed?: readonly string[]) {
    this.#allowed = allowed === undefined || allowed.length === 0 ? undefined : new Set(allowed);
  }

  register<I, O>(capability: LocalCapability<I, O>): this {
    if (this.#capabilities.has(capability.name)) {
      throw new CapabilityUnavailableError(capability.name, "already registered");
    }
    this.#capabilities.set(
      capability.name,
      capability as unknown as LocalCapability<never, unknown>,
    );
    return this;
  }

  registerAll(capabilities: readonly LocalCapability<never, unknown>[]): this {
    for (const capability of capabilities) this.register(capability);
    return this;
  }

  has(name: string): boolean {
    return this.#capabilities.has(name);
  }

  get names(): string[] {
    return [...this.#capabilities.keys()].sort();
  }

  /**
   * Retrieves an executable capability.
   *
   * @throws {CapabilityUnavailableError} if unknown, not allowed, or unavailable.
   */
  require(name: string): LocalCapability<never, unknown> {
    const capability = this.#capabilities.get(name);
    if (capability === undefined) {
      throw new CapabilityUnavailableError(name, "not implemented on this device");
    }
    if (this.#allowed !== undefined && !this.#allowed.has(name)) {
      throw new CapabilityUnavailableError(name, "not permitted by local configuration");
    }
    if (this.#availability.get(name) === false) {
      throw new CapabilityUnavailableError(name, "tool missing or service unavailable");
    }
    return capability;
  }

  /**
   * Validates arguments against capability schema.
   *
   * @throws {CapabilityInputError} containing specific field path errors.
   */
  validateInput(name: string, input: unknown): unknown {
    const capability = this.require(name);
    const parsed = capability.inputSchema.safeParse(input);
    if (parsed.success) return parsed.data;

    throw new CapabilityInputError(
      name,
      parsed.error.issues.map((issue) =>
        issue.path.length === 0 ? issue.message : `${issue.path.join(".")} : ${issue.message}`,
      ),
    );
  }

  /** Executes dynamic probes across registered capabilities. */
  async probeAll(): Promise<void> {
    for (const [name, capability] of this.#capabilities) {
      if (capability.probe === undefined) {
        this.#availability.set(name, true);
        continue;
      }
      try {
        this.#availability.set(name, await capability.probe());
      } catch {
        this.#availability.set(name, false);
      }
    }
  }

  /**
   * Capability list advertised to core server.
   */
  declare(): WorkerCapability[] {
    const declared: WorkerCapability[] = [];

    for (const [name, capability] of this.#capabilities) {
      if (this.#allowed !== undefined && !this.#allowed.has(name)) continue;
      if (this.#availability.get(name) === false) continue;

      declared.push({
        name,
        version: capability.version ?? "1",
        description: capability.description,
        ...(capability.inputJsonSchema === undefined
          ? {}
          : { inputSchema: capability.inputJsonSchema }),
        enabled: true,
        metadata: { risk: capability.riskLevel },
      });
    }

    return declared.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Detailed capability inventory for startup diagnostics. */
  inventory(): CapabilityDeclaration[] {
    return [...this.#capabilities.entries()].map(([name, capability]) => {
      const allowed = this.#allowed === undefined || this.#allowed.has(name);
      const present = this.#availability.get(name) !== false;

      return {
        capability: {
          name,
          version: capability.version ?? "1",
          description: capability.description,
          enabled: allowed && present,
          metadata: { risk: capability.riskLevel },
        },
        available: allowed && present,
        ...(allowed
          ? present
            ? {}
            : { reason: "tool missing on this machine" }
          : { reason: "not permitted by configuration" }),
      };
    });
  }
}
