import { redact, uuidv7 } from "@nexus/shared";
import type { NexusEventType } from "@nexus/protocol";
import { riskRank, type RiskLevel } from "@nexus/tools";
import type { DeviceRegistry } from "./registry.js";
import type { DeviceSelector } from "./selector.js";
import type { EventRouter } from "./router.js";
import { CapabilityNotRegisteredError, NoEligibleWorkerError } from "./errors.js";
import { hasCapability } from "./capabilities.js";
import {
  blockedSteps,
  derivePlanStatus,
  planProgress,
  readySteps,
  type TaskExecution,
  type TaskPlan,
  type TaskStep,
} from "./tasks.js";

/**
 * Executes a task plan across multiple devices.
 *
 * Execution sequence:
 *
 *     authorization -> required capabilities -> device selection -> dispatch -> events
 *
 * Clients never establish direct connections to workers. Clients submit requests
 * to Core, Core selects and dispatches to workers, and results route back through Core.
 * `WorkerTransport` is the abstraction boundary for worker communication.
 */

export interface WorkerDispatch {
  deviceId: string;
  taskId: string;
  stepId: string;
  tool: string;
  arguments: unknown;
  timeoutMs: number;
  /** Invoked capability — worker rejects unadvertised capabilities. */
  capability: string;
  signal: AbortSignal;
  onProgress: (progress: { percent?: number; label?: string }) => void;
}

/** Placeholder stored in audit log in place of sensitive result data. */
export const SENSITIVE_RESULT_PLACEHOLDER = "[SENSITIVE RESULT — NOT RETAINED]";

export interface WorkerResult {
  ok: boolean;
  result?: unknown;
  /**
   * Result must not be written to disk or preserved in execution logs.
   *
   * Returned directly to the requesting client and dropped from persistence.
   */
  sensitiveResult?: boolean;
  error?: { code: string; message: string; retryable: boolean };
}

/** Transport adapter to worker. */
export interface WorkerTransport {
  dispatch(input: WorkerDispatch): Promise<WorkerResult>;
  cancel(deviceId: string, taskId: string, stepId: string): Promise<void>;
}

/**
 * Human confirmation gate for sensitive actions.
 */
export interface ConfirmationGate {
  request(input: {
    confirmationId: string;
    taskId: string;
    stepId: string;
    capability: string;
    action: string;
    description: string;
    riskLevel: RiskLevel;
    originClientDeviceId: string;
    userId: string;
    expiresAt: Date;
  }): Promise<"approved" | "rejected" | "expired">;
}

export interface TaskStore {
  save(plan: TaskPlan): Promise<void>;
  get(id: string): Promise<TaskPlan | undefined>;
  saveExecution(execution: TaskExecution): Promise<void>;
  listExecutions(taskId: string): Promise<TaskExecution[]>;
  listByUser(userId: string, limit?: number): Promise<TaskPlan[]>;
  listActive(): Promise<TaskPlan[]>;
}

export class InMemoryTaskStore implements TaskStore {
  readonly #plans = new Map<string, TaskPlan>();
  readonly #executions = new Map<string, TaskExecution[]>();

  save(plan: TaskPlan): Promise<void> {
    this.#plans.set(plan.id, structuredClone(plan));
    return Promise.resolve();
  }

  get(id: string): Promise<TaskPlan | undefined> {
    const plan = this.#plans.get(id);
    return Promise.resolve(plan === undefined ? undefined : structuredClone(plan));
  }

  saveExecution(execution: TaskExecution): Promise<void> {
    const list = this.#executions.get(execution.taskId) ?? [];
    list.push(structuredClone(execution));
    this.#executions.set(execution.taskId, list);
    return Promise.resolve();
  }

  listExecutions(taskId: string): Promise<TaskExecution[]> {
    return Promise.resolve((this.#executions.get(taskId) ?? []).map((e) => structuredClone(e)));
  }

  /**
   * Returns recent plans for a user, sorted newest first.
   */
  listByUser(userId: string, limit = 20): Promise<TaskPlan[]> {
    const mine = [...this.#plans.values()].filter((plan) => plan.userId === userId);

    mine.sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));

    return Promise.resolve(mine.slice(0, limit).map((plan) => structuredClone(plan)));
  }

  listActive(): Promise<TaskPlan[]> {
    return Promise.resolve(
      [...this.#plans.values()].filter(
        (plan) =>
          plan.status === "pending" ||
          plan.status === "running" ||
          plan.status === "waiting_for_confirmation",
      ),
    );
  }
}

export interface TaskCoordinatorOptions {
  registry: DeviceRegistry;
  selector: DeviceSelector;
  router: EventRouter;
  transport: WorkerTransport;
  store?: TaskStore;
  confirmations?: ConfirmationGate;
  /** Risk threshold triggering human confirmation. */
  confirmationThreshold?: RiskLevel;
  confirmationTtlMs?: number;
  now?: () => Date;
  newId?: () => string;
}

export interface ExecuteOptions {
  /** User permissions, evaluated alongside device capabilities. */
  userPermissions?: readonly string[];
  signal?: AbortSignal;
}

export class TaskCoordinator {
  readonly #registry: DeviceRegistry;
  readonly #selector: DeviceSelector;
  readonly #router: EventRouter;
  readonly #transport: WorkerTransport;
  readonly #store: TaskStore;
  readonly #confirmations: ConfirmationGate | undefined;
  readonly #threshold: RiskLevel;
  readonly #confirmationTtlMs: number;
  readonly #now: () => Date;
  readonly #newId: () => string;

  constructor(options: TaskCoordinatorOptions) {
    this.#registry = options.registry;
    this.#selector = options.selector;
    this.#router = options.router;
    this.#transport = options.transport;
    this.#store = options.store ?? new InMemoryTaskStore();
    this.#confirmations = options.confirmations;
    this.#threshold = options.confirmationThreshold ?? "MEDIUM";
    this.#confirmationTtlMs = options.confirmationTtlMs ?? 10 * 60_000;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? uuidv7;
  }

  get store(): TaskStore {
    return this.#store;
  }

  /**
   * Recovers coordinator state after system restart.
   */
  async recover(): Promise<void> {
    const activePlans = await this.#store.listActive();

    for (const plan of activePlans) {
      let requiresSave = false;

      // Fail any steps that were in-flight when restart occurred
      for (const step of plan.steps) {
        if (step.status === "running") {
          step.status = "failed";
          step.error = {
            code: "RECOVERY_ERROR",
            retryable: false,
            message: "Interrupted by system restart. Manual intervention required.",
          };
          step.completedAt = this.#now().toISOString();
          requiresSave = true;
        }
      }

      if (requiresSave) {
        if (plan.status === "running") {
          const hasPending = plan.steps.some((s) => s.status === "pending" || s.status === "ready");
          plan.status = hasPending ? "partial" : "failed";
          plan.completedAt = this.#now().toISOString();
        }
        await this.#store.save(plan);
      }

      if (plan.status === "pending" || plan.status === "running") {
        void this.execute(plan).catch((error: unknown) => {
          process.emitWarning(
            `Recovered task execution failed: ${error instanceof Error ? error.name : "unknown"}`,
          );
        });
      }
    }
  }

  /**
   * Executes a task plan to completion.
   *
   * Independent ready steps execute concurrently across available devices.
   */
  async execute(plan: TaskPlan, options: ExecuteOptions = {}): Promise<TaskPlan> {
    let current: TaskPlan = {
      ...plan,
      status: "running",
      startedAt: plan.startedAt ?? this.#now().toISOString(),
    };
    await this.#store.save(current);

    await this.#emit(current, "task.created", {
      taskId: current.id,
      title: current.title,
      stepCount: current.steps.length,
    });
    await this.#emit(current, "task.started", { taskId: current.id });

    for (;;) {
      if (options.signal?.aborted === true) {
        current = await this.#cancel(current, "cancelled by user");
        return current;
      }

      // Mark blocked steps skipped immediately
      const blocked = blockedSteps(current);
      if (blocked.length > 0) {
        current = this.#patch(current, blocked, {
          status: "skipped",
          completedAt: this.#now().toISOString(),
        });
        await this.#store.save(current);
        continue;
      }

      const ready = readySteps(current);
      if (ready.length === 0) break;

      const results = await Promise.all(ready.map((step) => this.#runStep(current, step, options)));

      for (const updated of results) current = this.#replaceStep(current, updated);
      current = { ...current, status: derivePlanStatus(current) };
      await this.#store.save(current);

      const latest = results[results.length - 1];
      await this.#emit(current, "task.progress", {
        taskId: current.id,
        stepId: latest?.id ?? ready[0]?.id ?? "",
        deviceId: latest?.selectedDeviceId ?? null,
        percent: planProgress(current),
        label: null,
      });
    }

    const status = derivePlanStatus(current);
    current = { ...current, status, completedAt: this.#now().toISOString() };
    await this.#store.save(current);

    const durationMs =
      current.startedAt === null
        ? 0
        : new Date(current.completedAt ?? current.startedAt).getTime() -
          new Date(current.startedAt).getTime();

    if (status === "succeeded" || status === "partial") {
      await this.#emit(current, "task.completed", { taskId: current.id, status, durationMs });
    } else if (status === "cancelled") {
      await this.#emit(current, "task.cancelled", { taskId: current.id, reason: "cancelled" });
    } else {
      const failed = current.steps.find((step) => step.error !== null);
      await this.#emit(current, "task.failed", {
        taskId: current.id,
        code: failed?.error?.code ?? "TASK_FAILED",
        message: failed?.error?.message ?? "Task failed.",
      });
    }

    return current;
  }

  /** Step execution pipeline: selection, confirmation, dispatch, failover. */
  async #runStep(plan: TaskPlan, step: TaskStep, options: ExecuteOptions): Promise<TaskStep> {
    const excluded: string[] = [];
    let attempt = 0;
    let last: TaskStep = step;

    while (attempt < step.retry.attempts) {
      attempt += 1;

      // 1. Capability-based selection
      let selection;
      try {
        selection = await this.#selector.select({
          userId: plan.userId,
          requiredCapabilities: step.requiredCapabilities,
          ...(options.userPermissions ? { userPermissions: options.userPermissions } : {}),
          ...(step.preferredDeviceId !== null ? { preferredDeviceId: step.preferredDeviceId } : {}),
          excludeDeviceIds: excluded,
          ...(step.constraints ? { constraints: step.constraints } : {}),
        });
      } catch (error) {
        const reason =
          error instanceof NoEligibleWorkerError ? error.userMessage : "No device available.";
        return {
          ...step,
          status: "failed",
          attempt,
          completedAt: this.#now().toISOString(),
          error: { code: "NO_ELIGIBLE_WORKER", message: reason, retryable: true },
        };
      }

      const device = selection.device;

      // 2. Re-verify registered capability on candidate device
      const capability = step.requiredCapabilities[0] ?? step.tool;
      const fresh = await this.#registry.requireDevice(device.id);
      if (!hasCapability(fresh.capabilities, capability)) {
        const error = new CapabilityNotRegisteredError(device.id, capability);
        return {
          ...step,
          status: "failed",
          attempt,
          selectedDeviceId: device.id,
          completedAt: this.#now().toISOString(),
          error: { code: error.code, message: error.userMessage, retryable: false },
        };
      }

      // 3. Human confirmation
      if (this.#needsConfirmation(step.riskLevel)) {
        const decision = await this.#confirm(plan, step, capability);
        if (decision !== "approved") {
          return {
            ...step,
            status: decision === "expired" ? "failed" : "cancelled",
            attempt,
            selectedDeviceId: device.id,
            completedAt: this.#now().toISOString(),
            error: {
              code: decision === "expired" ? "CONFIRMATION_EXPIRED" : "CONFIRMATION_REJECTED",
              message:
                decision === "expired"
                  ? "Confirmation request expired."
                  : "Action rejected by user.",
              retryable: false,
            },
          };
        }
      }

      // 4. Dispatch
      const startedAt = this.#now();
      last = {
        ...step,
        status: "running",
        attempt,
        selectedDeviceId: device.id,
        startedAt: startedAt.toISOString(),
      };

      await this.#emit(plan, "worker.task_started", {
        taskId: plan.id,
        stepId: step.id,
        deviceId: device.id,
        tool: step.tool,
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, step.timeoutMs);
      timeout.unref?.();

      let result: WorkerResult;
      try {
        result = await this.#transport.dispatch({
          deviceId: device.id,
          taskId: plan.id,
          stepId: step.id,
          tool: step.tool,
          arguments: step.arguments,
          timeoutMs: step.timeoutMs,
          capability,
          signal: controller.signal,
          onProgress: (progress) => {
            void this.#emit(plan, "worker.task_progress", {
              taskId: plan.id,
              stepId: step.id,
              deviceId: device.id,
              percent: progress.percent ?? null,
              label: progress.label ?? null,
            });
          },
        });
      } catch (error) {
        result = {
          ok: false,
          error: {
            code: "WORKER_DISPATCH_FAILED",
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
        };
      } finally {
        clearTimeout(timeout);
      }

      const completedAt = this.#now();
      const durationMs = completedAt.getTime() - startedAt.getTime();

      await this.#store.saveExecution({
        id: this.#newId(),
        taskId: plan.id,
        stepId: step.id,
        deviceId: device.id,
        attempt,
        status: result.ok ? "succeeded" : "failed",
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs,
        input: redact(step.arguments),
        result:
          result.sensitiveResult === true ? SENSITIVE_RESULT_PLACEHOLDER : (result.result ?? null),
        error: result.error ?? null,
      });

      if (result.ok) {
        await this.#emit(plan, "worker.task_completed", {
          taskId: plan.id,
          stepId: step.id,
          deviceId: device.id,
          durationMs,
          summary: step.description,
        });
        return {
          ...last,
          status: "succeeded",
          completedAt: completedAt.toISOString(),
          result: result.result ?? null,
          error: null,
        };
      }

      await this.#emit(plan, "worker.task_failed", {
        taskId: plan.id,
        stepId: step.id,
        deviceId: device.id,
        code: result.error?.code ?? "WORKER_FAILED",
        message: result.error?.message ?? "Execution failed.",
        retryable: result.error?.retryable ?? false,
      });

      last = {
        ...last,
        status: "failed",
        completedAt: completedAt.toISOString(),
        error: result.error ?? {
          code: "WORKER_FAILED",
          message: "Execution failed.",
          retryable: false,
        },
      };

      const canRetry = (result.error?.retryable ?? false) && attempt < step.retry.attempts;
      if (!canRetry) return last;

      if (step.retry.failoverToAnotherDevice) excluded.push(device.id);
    }

    return last;
  }

  #needsConfirmation(risk: RiskLevel): boolean {
    return this.#confirmations !== undefined && riskRank(risk) >= riskRank(this.#threshold);
  }

  async #confirm(
    plan: TaskPlan,
    step: TaskStep,
    capability: string,
  ): Promise<"approved" | "rejected" | "expired"> {
    const gate = this.#confirmations;
    if (gate === undefined) return "approved";

    const confirmationId = this.#newId();
    const expiresAt = new Date(this.#now().getTime() + this.#confirmationTtlMs);

    await this.#emit(plan, "confirmation.required", {
      confirmationId,
      taskId: plan.id,
      stepId: step.id,
      capability,
      action: step.description,
      description: step.description,
      riskLevel: step.riskLevel,
      expiresAt: expiresAt.toISOString(),
    });

    const decision = await gate.request({
      confirmationId,
      taskId: plan.id,
      stepId: step.id,
      capability,
      action: step.description,
      description: step.description,
      riskLevel: step.riskLevel,
      originClientDeviceId: plan.originClientDeviceId,
      userId: plan.userId,
      expiresAt,
    });

    await this.#emit(plan, "confirmation.responded", {
      confirmationId,
      decision,
      decidedByDeviceId: null,
    });

    return decision;
  }

  async #cancel(plan: TaskPlan, reason: string): Promise<TaskPlan> {
    const pending = plan.steps.filter(
      (step) => step.status === "pending" || step.status === "running",
    );
    const cancelled = this.#patch(plan, pending, {
      status: "cancelled",
      completedAt: this.#now().toISOString(),
    });

    for (const step of pending) {
      if (step.selectedDeviceId !== null) {
        await this.#transport
          .cancel(step.selectedDeviceId, plan.id, step.id)
          .catch(() => undefined);
      }
    }

    const updated: TaskPlan = {
      ...cancelled,
      status: "cancelled",
      completedAt: this.#now().toISOString(),
    };
    await this.#store.save(updated);
    await this.#emit(updated, "task.cancelled", { taskId: updated.id, reason });
    return updated;
  }

  #patch(plan: TaskPlan, targets: readonly TaskStep[], patch: Partial<TaskStep>): TaskPlan {
    const ids = new Set(targets.map((step) => step.id));
    return {
      ...plan,
      steps: plan.steps.map((step) => (ids.has(step.id) ? { ...step, ...patch } : step)),
    };
  }

  #replaceStep(plan: TaskPlan, updated: TaskStep): TaskPlan {
    return {
      ...plan,
      steps: plan.steps.map((step) => (step.id === updated.id ? updated : step)),
    };
  }

  async #emit(
    plan: TaskPlan,
    type: NexusEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.#router.emit({
      type,
      userId: plan.userId,
      correlationId: plan.correlationId,
      originClientDeviceId: plan.originClientDeviceId,
      payload,
    });
  }
}
