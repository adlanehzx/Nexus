import type { ApiClient } from "./api.js";
import type { ClientAction, ClientState, TaskStatus, TaskView } from "./store.js";

/**
 * State resynchronization after reconnection.
 *
 * ## The Problem
 *
 * The real-time channel does not replay events. A task finishing while a client
 * is disconnected loses its `task.completed` event — leaving the UI showing "running".
 *
 * ## What this module does
 *
 * It re-queries the core server for the status of tasks the client believes are still active.
 *
 * Key properties:
 *
 *  1. **Only unfinished tasks are re-read.** Completed tasks do not change.
 *  2. **Never creates tasks.** Resync is strictly a read operation.
 *  3. **Tasks missing from the core are left as-is.** A 404 could be a history cleanup
 *     or transient error; deleting the task would cause confusing UI disappearance.
 */

/** Task statuses that are still in progress on the core server. */
const UNFINISHED: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "pending",
  "running",
  "waiting_for_confirmation",
]);

export function isUnfinished(status: TaskStatus): boolean {
  return UNFINISHED.has(status);
}

/** Task IDs believed to be active by the client. */
export function unfinishedTaskIds(state: ClientState): string[] {
  return state.tasks.filter((task) => isUnfinished(task.status)).map((task) => task.id);
}

export interface ResyncOptions {
  api: Pick<ApiClient, "getTask">;
  state: ClientState;
  dispatch: (action: ClientAction) => void;
  /** Maximum number of tasks re-queried in one pass to prevent request storms. */
  limit?: number;
}

export interface ResyncOutcome {
  /** Tasks checked against the core server. */
  checked: number;
  /** Tasks whose displayed status was outdated and updated. */
  updated: number;
  /** Tasks that could not be reached on the core server. */
  unreachable: number;
}

/**
 * Re-queries unfinished task state and updates the client store.
 *
 * Never throws: failed resync leaves the screen as-is rather than displaying an error message.
 */
export async function resyncTasks(options: ResyncOptions): Promise<ResyncOutcome> {
  const ids = unfinishedTaskIds(options.state).slice(0, options.limit ?? 20);
  const outcome: ResyncOutcome = { checked: 0, updated: 0, unreachable: 0 };

  for (const id of ids) {
    let task;
    try {
      task = await options.api.getTask(id);
    } catch {
      outcome.unreachable += 1;
      continue;
    }

    outcome.checked += 1;

    const known = options.state.tasks.find((entry) => entry.id === id);
    if (known?.status === task.status) continue;

    outcome.updated += 1;
    options.dispatch({
      kind: "taskSync",
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        completedAt: task.completedAt,
        startedAt: task.startedAt,
        stepCount: task.steps.length,
        originClientDeviceId: task.originClientDeviceId,
        error: firstError(task.steps),
      },
    });
  }

  return outcome;
}

/** Extracts the first step error that halted execution. */
function firstError(
  steps: readonly { error: { code: string; message: string } | null }[],
): TaskView["error"] {
  for (const step of steps) {
    if (step.error !== null) return step.error;
  }
  return null;
}
