import type { TaskCoordinator, TaskPlan } from "@nexus/devices";
import type { NotificationService } from "./notification-service.js";

/**
 * Tracks actively executing plans.
 *
 * `TaskCoordinator.execute()` is cancelled via `AbortSignal` — this is the right
 * mechanism, propagating all the way to child processes on target machines. But
 * a client issuing a cancellation does not hold this signal: it sends `task.cancel` with
 * an identifier, minutes later, from a different device than the one that
 * initiated the task.
 *
 * This supervisor bridges that gap: it maintains the controller for each in-flight
 * execution and triggers it on demand. It lives in the API rather than the
 * coordinator by design — the coordinator does not need to know about
 * clients, request identifiers, or sessions.
 *
 * It is also the sole location deciding that a completed task warrants a
 * notification: centralizing this decision ensures that an iPhone and
 * a laptop receive exactly one identical notification.
 */

interface Running {
  controller: AbortController;
  userId: string;
  originClientDeviceId: string;
  title: string;
}

export interface TaskSupervisorOptions {
  coordinator: TaskCoordinator;
  notifications: NotificationService;
  onError?: (error: unknown, taskId: string) => void;
}

export class TaskSupervisor {
  readonly #coordinator: TaskCoordinator;
  readonly #notifications: NotificationService;
  readonly #onError: ((error: unknown, taskId: string) => void) | undefined;

  readonly #running = new Map<string, Running>();

  constructor(options: TaskSupervisorOptions) {
    this.#coordinator = options.coordinator;
    this.#notifications = options.notifications;
    this.#onError = options.onError;
  }

  get runningCount(): number {
    return this.#running.size;
  }

  runningIds(userId: string): string[] {
    return [...this.#running.entries()]
      .filter(([, running]) => running.userId === userId)
      .map(([id]) => id);
  }

  /**
   * Starts a plan **without awaiting its completion**.
   *
   * A plan can take minutes; an HTTP request waiting for it
   * would time out. The client tracks subsequent progress via the real-time channel — which
   * is precisely its purpose.
   */
  start(plan: TaskPlan, permissions: readonly string[]): void {
    const controller = new AbortController();
    this.#running.set(plan.id, {
      controller,
      userId: plan.userId,
      originClientDeviceId: plan.originClientDeviceId,
      title: plan.title,
    });

    void this.#coordinator
      .execute(plan, { userPermissions: permissions, signal: controller.signal })
      .then(async (executed) => {
        await this.#notifications.notifyTaskOutcome({
          userId: executed.userId,
          taskId: executed.id,
          title: executed.title,
          status: toOutcome(executed.status),
          originClientDeviceId: executed.originClientDeviceId,
        });
      })
      .catch((cause: unknown) => {
        this.#onError?.(cause, plan.id);
      })
      .finally(() => {
        this.#running.delete(plan.id);
      });
  }

  /**
   * Cancels an in-flight plan.
   *
   * Returns `false` when nothing is in flight: the task already finished, or
   * the server has restarted since. This is not an error — the client requested
   * that it stop, and it has stopped.
   *
   * Interrupts an execution.
   *
   * `userId` is **mandatory**, and verified against the plan owner. The
   * supervisor already knew this owner; ignoring it would have allowed
   * any authenticated account to terminate someone else's execution
   * by guessing a task identifier.
   *
   * A rejection is indistinguishable from an unknown task: distinguishing them would
   * permit probing for the existence of other users' tasks.
   */
  cancel(taskId: string, userId: string): boolean {
    const running = this.#running.get(taskId);
    if (running?.userId !== userId) return false;

    running.controller.abort();
    return true;
  }

  /** Interrupts all executions — server shutdown. */
  cancelAll(): number {
    const count = this.#running.size;
    for (const running of this.#running.values()) running.controller.abort();
    return count;
  }
}

function toOutcome(status: string): "succeeded" | "partial" | "failed" | "cancelled" {
  if (status === "succeeded" || status === "partial" || status === "cancelled") return status;
  return "failed";
}
