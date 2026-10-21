import { describe, expect, it } from "vitest";
import { initialState, reduce, type ClientAction, type ClientState } from "../src/store.js";
import { isUnfinished, resyncTasks, unfinishedTaskIds } from "../src/resync.js";
import type { ApiTask } from "../src/api.js";

/**
 * Reconnection state resynchronization tests.
 */

function taskState(...tasks: { id: string; status: string; title?: string }[]): ClientState {
  let state = initialState;

  for (const task of tasks) {
    state = reduce(state, {
      kind: "taskSync",
      task: {
        id: task.id,
        title: task.title ?? "Task",
        status: task.status,
        startedAt: null,
        completedAt: null,
        stepCount: 1,
        originClientDeviceId: null,
        error: null,
      },
    });
  }

  return state;
}

function apiTask(overrides: Partial<ApiTask> & { id: string; status: string }): ApiTask {
  return {
    title: "Task",
    originClientDeviceId: "device-iphone",
    steps: [],
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function core(tasks: Record<string, ApiTask | "absent">) {
  const read: string[] = [];

  return {
    read,
    api: {
      getTask: (taskId: string): Promise<ApiTask> => {
        read.push(taskId);
        const found = tasks[taskId];
        if (found === undefined || found === "absent") {
          return Promise.reject(new Error("Unknown task"));
        }
        return Promise.resolve(found);
      },
    },
  };
}

function collect(): { actions: ClientAction[]; dispatch: (action: ClientAction) => void } {
  const actions: ClientAction[] = [];
  return { actions, dispatch: (action) => actions.push(action) };
}

describe("selection of tasks to resynchronize", () => {
  it("only checks unfinished tasks", () => {
    expect(isUnfinished("pending")).toBe(true);
    expect(isUnfinished("running")).toBe(true);
    expect(isUnfinished("waiting_for_confirmation")).toBe(true);

    expect(isUnfinished("succeeded")).toBe(false);
    expect(isUnfinished("failed")).toBe(false);
    expect(isUnfinished("cancelled")).toBe(false);
    expect(isUnfinished("partial")).toBe(false);
  });

  it("ignores completed tasks", () => {
    const state = taskState(
      { id: "t1", status: "running" },
      { id: "t2", status: "succeeded" },
      { id: "t3", status: "waiting_for_confirmation" },
    );

    expect([...unfinishedTaskIds(state)].sort()).toEqual(["t1", "t3"]);
  });

  it("does nothing when all tasks are complete", async () => {
    const state = taskState({ id: "t1", status: "succeeded" });
    const { api, read } = core({});
    const { actions } = collect();

    const outcome = await resyncTasks({ api, state, dispatch: () => undefined });

    expect(read).toEqual([]);
    expect(actions).toEqual([]);
    expect(outcome.checked).toBe(0);
  });
});

describe("resynchronization", () => {
  it("updates task completed during disconnection", async () => {
    const state = taskState({ id: "t1", status: "running", title: "Open Chrome" });
    const { api } = core({
      t1: apiTask({ id: "t1", status: "succeeded", completedAt: "2026-01-01T10:00:00.000Z" }),
    });
    const { actions, dispatch } = collect();

    const outcome = await resyncTasks({ api, state, dispatch });

    expect(outcome).toMatchObject({ checked: 1, updated: 1, unreachable: 0 });

    const after = actions.reduce(reduce, state);
    const task = after.tasks.find((entry) => entry.id === "t1");

    expect(task?.status).toBe("succeeded");
    expect(task?.percent).toBe(100);
    expect(task?.label).toBeNull();
    expect(task?.completedAt).toBe("2026-01-01T10:00:00.000Z");
  });

  it("propagates error from the step that halted the plan", async () => {
    const state = taskState({ id: "t1", status: "running" });
    const { api } = core({
      t1: apiTask({
        id: "t1",
        status: "failed",
        steps: [
          {
            id: "s1",
            description: "a",
            status: "succeeded",
            selectedDeviceId: null,
            riskLevel: "LOW",
            error: null,
          },
          {
            id: "s2",
            description: "b",
            status: "failed",
            selectedDeviceId: null,
            riskLevel: "LOW",
            error: { code: "WORKER_UNAVAILABLE", message: "Desktop worker is offline." },
          },
        ],
      }),
    });
    const { actions, dispatch } = collect();

    await resyncTasks({ api, state, dispatch });
    const after = actions.reduce(reduce, state);

    expect(after.tasks[0]?.status).toBe("failed");
    expect(after.tasks[0]?.error).toEqual({
      code: "WORKER_UNAVAILABLE",
      message: "Desktop worker is offline.",
    });
  });

  it("does not update task whose status has not changed", async () => {
    const state = taskState({ id: "t1", status: "running" });
    const { api } = core({ t1: apiTask({ id: "t1", status: "running" }) });
    const { actions, dispatch } = collect();

    const outcome = await resyncTasks({ api, state, dispatch });

    expect(outcome).toMatchObject({ checked: 1, updated: 0 });
    expect(actions).toEqual([]);
  });
});

describe("invariants", () => {
  it("never creates new tasks", async () => {
    const state = taskState({ id: "t1", status: "running" });
    const { api } = core({ t1: apiTask({ id: "t1", status: "succeeded" }) });
    const { actions, dispatch } = collect();

    await resyncTasks({ api, state, dispatch });

    for (const action of actions) {
      expect(action.kind).toBe("taskSync");
    }

    const after = actions.reduce(reduce, state);
    expect(after.tasks).toHaveLength(1);
  });

  it("preserves task if core does not return it", async () => {
    const state = taskState({ id: "t1", status: "running", title: "Open Chrome" });
    const { api } = core({ t1: "absent" });
    const { actions, dispatch } = collect();

    const outcome = await resyncTasks({ api, state, dispatch });

    expect(outcome).toMatchObject({ checked: 0, updated: 0, unreachable: 1 });
    expect(actions).toEqual([]);

    const after = actions.reduce(reduce, state);
    expect(after.tasks[0]?.status).toBe("running");
    expect(after.tasks[0]?.title).toBe("Open Chrome");
  });

  it("does not throw when core server is unreachable", async () => {
    const state = taskState({ id: "t1", status: "running" }, { id: "t2", status: "running" });
    const api = {
      getTask: () => Promise.reject(new Error("ECONNREFUSED")),
    };

    await expect(resyncTasks({ api, state, dispatch: () => undefined })).resolves.toMatchObject({
      unreachable: 2,
    });
  });

  it("caps number of tasks checked in a single pass", async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      id: `t${String(index)}`,
      status: "running",
    }));
    const state = taskState(...many);
    const { api, read } = core(
      Object.fromEntries(
        many.map((task) => [task.id, apiTask({ id: task.id, status: "running" })]),
      ),
    );

    await resyncTasks({ api, state, dispatch: () => undefined, limit: 5 });

    expect(read).toHaveLength(5);
  });

  it("ignores unknown task statuses from newer core versions", async () => {
    const state = taskState({ id: "t1", status: "running" });
    const { api } = core({ t1: apiTask({ id: "t1", status: "something_new" }) });
    const { actions, dispatch } = collect();

    await resyncTasks({ api, state, dispatch });
    const after = actions.reduce(reduce, state);

    expect(after.tasks[0]?.status).toBe("running");
  });
});
