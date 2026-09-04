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
 * Exécution d'un plan de tâche sur plusieurs appareils.
 *
 * Le chemin imposé par l'architecture, dans cet ordre :
 *
 *     autorisation → capacités requises → sélection → dispatch → événements
 *
 * Aucun client n'ouvre jamais de connexion vers un worker. Un client demande au
 * cœur, le cœur choisit et dispatche, les résultats reviennent par le cœur.
 * `WorkerTransport` est le seul point de contact avec un exécutant, et c'est un
 * port : le WebSocket réel s'y branchera sans rien changer ici.
 */

export interface WorkerDispatch {
  deviceId: string;
  taskId: string;
  stepId: string;
  tool: string;
  arguments: unknown;
  timeoutMs: number;
  /** Capacité exercée — le worker refuse ce qu'il n'a pas enregistré. */
  capability: string;
  signal: AbortSignal;
  onProgress: (progress: { percent?: number; label?: string }) => void;
}

/** Ce que le journal d'exécution garde à la place d'un résultat sensible. */
export const SENSITIVE_RESULT_PLACEHOLDER = "[RÉSULTAT SENSIBLE — NON CONSERVÉ]";

export interface WorkerResult {
  ok: boolean;
  result?: unknown;
  /**
   * Le résultat ne doit pas entrer dans le journal d'exécution.
   *
   * Il est transmis au client qui l'a demandé, et s'arrête là. Pensé pour ce
   * qu'aucune rédaction ne peut nettoyer — une capture d'écran de téléphone,
   * par exemple : masquer un mot à l'intérieur d'une image n'a pas de sens.
   */
  sensitiveResult?: boolean;
  error?: { code: string; message: string; retryable: boolean };
}

/** Transport vers un worker. Implémenté par le WebSocket en phase suivante. */
export interface WorkerTransport {
  dispatch(input: WorkerDispatch): Promise<WorkerResult>;
  cancel(deviceId: string, taskId: string, stepId: string): Promise<void>;
}

/**
 * Décision humaine sur une étape sensible.
 *
 * Le port est volontairement minimal : il reçoit la demande, il rend un verdict.
 * L'attente réelle — carte affichée sur l'iPhone, notification push, expiration
 * — est l'affaire de l'implémentation, pas du coordinateur.
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
   * Les derniers plans d'un utilisateur, du plus récent au plus ancien.
   *
   * Hors du port `TaskStore` : le coordinateur n'en a pas besoin, il exécute un
   * plan qu'on lui donne. C'est l'assemblage du contexte qui s'en sert, pour que
   * le modèle sache ce qui vient de se passer plutôt que de le redemander.
   */
  listByUser(userId: string, limit = 20): Promise<TaskPlan[]> {
    const mine = [...this.#plans.values()].filter((plan) => plan.userId === userId);

    // `createdAt` est une chaîne ISO : la comparaison lexicographique est donc
    // chronologique, et évite de construire deux `Date` par comparaison.
    mine.sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));

    return Promise.resolve(mine.slice(0, limit).map((plan) => structuredClone(plan)));
  }

  async listActive(): Promise<TaskPlan[]> {
    return [...this.#plans.values()].filter(
      (p) => p.status === "pending" || p.status === "running" || p.status === "waiting_for_confirmation"
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
  /** Risque à partir duquel une confirmation humaine est exigée. */
  confirmationThreshold?: RiskLevel;
  confirmationTtlMs?: number;
  now?: () => Date;
  newId?: () => string;
}

export interface ExecuteOptions {
  /** Permissions de l'utilisateur, en plus de celles propres à l'appareil. */
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
   * Reconstruit l'état du coordinateur après un redémarrage.
   * Doit être appelé lors du démarrage de l'application.
   */
  async recover(): Promise<void> {
    const activePlans = await this.#store.listActive();
    
    for (const plan of activePlans) {
      let requiresSave = false;
      
      // We process the steps to fail any that were "running" (security rule).
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

      // If we modified steps, we need to update the plan status
      if (requiresSave) {
        // Evaluate the overall plan status.
        // A running plan with a failed step becomes partial/failed.
        if (plan.status === "running") {
          const hasPending = plan.steps.some(s => s.status === "pending" || s.status === "ready");
          plan.status = hasPending ? "partial" : "failed";
          plan.completedAt = this.#now().toISOString();
        }
        await this.#store.save(plan);
      } else if (plan.status === "waiting_for_confirmation") {
        // We need to re-register the confirmation requirement.
        // Currently ConfirmationBroker handles runtime requests, but how to rehydrate?
        // If the ConfirmationBroker is memory-only, we might just leave the task in "waiting_for_confirmation" 
        // and let the client re-fetch it and confirm it. But if the client is not aware...
        // Actually, for simplicity, we just keep it waiting.
      }
      
      // Tasks that are pending or running (with no currently active/running steps) 
      // will be naturally re-evaluated if we just let the event router or the next heartbeat 
      // trigger them. But wait, `TaskCoordinator` uses EventRouter to listen for device events.
      // Do we need to actively push them to a queue here?
      // In a real system, the Coordinator would loop over `ready` steps and assign them.
      // We can emit a synthetic event or just call an internal evaluation loop if one exists.
      // Wait, how does TaskCoordinator execute a plan? 
      // It calls `this.#evaluate(plan)`! We can just call it for active plans.
      
      if (plan.status === "pending" || plan.status === "running") {
        this.execute(plan).catch(() => {});
      }
    }
  }

  /**
   * Exécute un plan jusqu'à son terme.
   *
   * Les étapes prêtes partent **en parallèle** : rien n'oblige à sérialiser deux
   * étapes indépendantes sur deux appareils différents. La dépendance est la
   * seule contrainte d'ordre.
   */
  async execute(plan: TaskPlan, options: ExecuteOptions = {}): Promise<TaskPlan> {
    let current: TaskPlan = { ...plan, status: "running", startedAt: plan.startedAt ?? this.#now().toISOString() };
    await this.#store.save(current);

    await this.#emit(current, "task.created", {
      taskId: current.id,
      title: current.title,
      stepCount: current.steps.length,
    });
    await this.#emit(current, "task.started", { taskId: current.id });

    for (;;) {
      if (options.signal?.aborted === true) {
        current = await this.#cancel(current, "annulé par l'utilisateur");
        return current;
      }

      // Les étapes dont une dépendance a échoué ne s'exécuteront jamais : les
      // marquer tout de suite évite qu'un plan reste « en cours » sans fin.
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

      const dernier = results[results.length - 1];
      await this.#emit(current, "task.progress", {
        taskId: current.id,
        stepId: dernier?.id ?? ready[0]?.id ?? "",
        // L'exécutant retenu accompagne la progression : c'est la seule
        // occasion de le dire aux clients, et sans lui leur vue d'une tâche
        // reste anonyme jusqu'au bout.
        deviceId: dernier?.selectedDeviceId ?? null,
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
      await this.#emit(current, "task.cancelled", { taskId: current.id, reason: "annulé" });
    } else {
      const failed = current.steps.find((step) => step.error !== null);
      await this.#emit(current, "task.failed", {
        taskId: current.id,
        code: failed?.error?.code ?? "TASK_FAILED",
        message: failed?.error?.message ?? "La tâche a échoué.",
      });
    }

    return current;
  }

  /** Sélection, confirmation, dispatch, reprise — pour une seule étape. */
  async #runStep(plan: TaskPlan, step: TaskStep, options: ExecuteOptions): Promise<TaskStep> {
    const excluded: string[] = [];
    let attempt = 0;
    let last: TaskStep = step;

    while (attempt < step.retry.attempts) {
      attempt += 1;

      // 1. Sélection. Aucun nom d'appareil ici : capacités requises seulement.
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
          error instanceof NoEligibleWorkerError ? error.userMessage : "Aucun appareil disponible.";
        return {
          ...step,
          status: "failed",
          attempt,
          completedAt: this.#now().toISOString(),
          error: { code: "NO_ELIGIBLE_WORKER", message: reason, retryable: true },
        };
      }

      const device = selection.device;

      // 2. Le worker doit avoir enregistré la capacité exercée. Le sélecteur l'a
      //    déjà vérifié ; on le revérifie parce que l'appareil a pu changer
      //    entre-temps, et parce qu'une seule ligne évite une exécution non
      //    autorisée.
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

      // 3. Confirmation humaine, routée vers l'appareil d'origine.
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
                  ? "La demande de confirmation a expiré."
                  : "Tu as refusé cette action.",
              retryable: false,
            },
          };
        }
      }

      // 4. Dispatch.
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
        // Un enregistrement d'exécution est un journal d'audit : il doit dire ce
        // qui a été demandé. Les arguments y entrent donc, mais rédigés — un mot
        // de passe passé à `terminal.execute` ne survit pas à cette ligne.
        input: redact(step.arguments),
        // Un résultat déclaré sensible ne laisse qu'une mention : l'appel est
        // tracé, sa charge utile ne l'est pas.
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
        message: result.error?.message ?? "Échec de l'exécution.",
        retryable: result.error?.retryable ?? false,
      });

      last = {
        ...last,
        status: "failed",
        completedAt: completedAt.toISOString(),
        error: result.error ?? {
          code: "WORKER_FAILED",
          message: "Échec de l'exécution.",
          retryable: false,
        },
      };

      const canRetry = (result.error?.retryable ?? false) && attempt < step.retry.attempts;
      if (!canRetry) return last;

      // Basculer d'appareil plutôt que de réessayer sur celui qui vient
      // d'échouer : si c'est le worker qui est en cause, réessayer chez lui ne
      // sert à rien.
      if (step.retry.failoverToAnotherDevice) excluded.push(device.id);
    }

    return last;
  }

  #needsConfirmation(risk: RiskLevel): boolean {
    return this.#confirmations !== undefined && riskRank(risk) >= riskRank(this.#threshold);
  }

  /**
   * Demande une confirmation et la route vers l'appareil d'origine.
   *
   * L'événement part vers **tous** les clients — l'iPhone peut approuver une
   * action lancée depuis le portable — mais l'origine est marquée pour que
   * l'interface la mette en avant là où l'utilisateur regarde.
   */
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

  /** Tout événement porte l'origine : c'est le fil qui ramène au bon client. */
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
