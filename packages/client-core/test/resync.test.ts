import { describe, expect, it } from "vitest";
import { initialState, reduce, type ClientAction, type ClientState } from "../src/store.js";
import { isUnfinished, resyncTasks, unfinishedTaskIds } from "../src/resync.js";
import type { ApiTask } from "../src/api.js";

/**
 * Rattrapage après reconnexion.
 *
 * Le scénario que ces tests protègent : une tâche part de l'iPhone, le
 * téléphone entre dans un tunnel, la tâche s'achève, `task.completed` part vers
 * une socket fermée. À la sortie du tunnel, l'écran affiche encore « en cours ».
 *
 * C'est le pire état possible — faux, définitif, et crédible.
 */

function taskState(...tasks: { id: string; status: string; title?: string }[]): ClientState {
  let state = initialState;

  for (const task of tasks) {
    state = reduce(state, {
      kind: "taskSync",
      task: {
        id: task.id,
        title: task.title ?? "Tâche",
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
    title: "Tâche",
    originClientDeviceId: "device-iphone",
    steps: [],
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

/** Cœur simulé : ne rend que ce qu'on lui a donné, et compte les lectures. */
function core(tasks: Record<string, ApiTask | "absent">) {
  const read: string[] = [];

  return {
    read,
    api: {
      getTask: (taskId: string): Promise<ApiTask> => {
        read.push(taskId);
        const found = tasks[taskId];
        if (found === undefined || found === "absent") {
          return Promise.reject(new Error("Tâche inconnue"));
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

// ─────────────────────────────────────────────────────────────────────────────
// Ce qu'on relit
// ─────────────────────────────────────────────────────────────────────────────

describe("sélection des tâches à relire", () => {
  it("ne relit que les tâches inachevées", () => {
    expect(isUnfinished("pending")).toBe(true);
    expect(isUnfinished("running")).toBe(true);
    expect(isUnfinished("waiting_for_confirmation")).toBe(true);

    // Une tâche terminée ne change plus : la relire coûterait une requête par
    // tâche à chaque passage de tunnel.
    expect(isUnfinished("succeeded")).toBe(false);
    expect(isUnfinished("failed")).toBe(false);
    expect(isUnfinished("cancelled")).toBe(false);
    expect(isUnfinished("partial")).toBe(false);
  });

  it("ignore les tâches déjà terminées", () => {
    const state = taskState(
      { id: "t1", status: "running" },
      { id: "t2", status: "succeeded" },
      { id: "t3", status: "waiting_for_confirmation" },
    );

    // L'ordre appartient au magasin, qui présente les tâches récentes d'abord.
    // Ce qui compte ici est l'ensemble.
    expect([...unfinishedTaskIds(state)].sort()).toEqual(["t1", "t3"]);
  });

  it("ne fait rien quand tout est terminé", async () => {
    const state = taskState({ id: "t1", status: "succeeded" });
    const { api, read } = core({});
    const { actions } = collect();

    const outcome = await resyncTasks({ api, state, dispatch: () => undefined });

    expect(read).toEqual([]);
    expect(actions).toEqual([]);
    expect(outcome.checked).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Correction de l'état périmé
// ─────────────────────────────────────────────────────────────────────────────

describe("rattrapage", () => {
  it("corrige une tâche achevée pendant la coupure", async () => {
    // Le scénario central de la phase.
    const state = taskState({ id: "t1", status: "running", title: "Ouvrir Chrome" });
    const { api } = core({
      t1: apiTask({ id: "t1", status: "succeeded", completedAt: "2026-01-01T10:00:00.000Z" }),
    });
    const { actions, dispatch } = collect();

    const outcome = await resyncTasks({ api, state, dispatch });

    expect(outcome).toMatchObject({ checked: 1, updated: 1, unreachable: 0 });

    const after = actions.reduce(reduce, state);
    const task = after.tasks.find((entry) => entry.id === "t1");

    expect(task?.status).toBe("succeeded");
    // La dernière trame de progression n'est jamais arrivée : une tâche
    // terminée est à 100 %, pas à 40.
    expect(task?.percent).toBe(100);
    expect(task?.label).toBeNull();
    expect(task?.completedAt).toBe("2026-01-01T10:00:00.000Z");
  });

  it("remonte l'erreur de l'étape qui a arrêté le plan", async () => {
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
            error: { code: "WORKER_UNAVAILABLE", message: "Le poste fixe est hors ligne." },
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
      message: "Le poste fixe est hors ligne.",
    });
  });

  it("ne touche pas une tâche dont l'état n'a pas bougé", async () => {
    const state = taskState({ id: "t1", status: "running" });
    const { api } = core({ t1: apiTask({ id: "t1", status: "running" }) });
    const { actions, dispatch } = collect();

    const outcome = await resyncTasks({ api, state, dispatch });

    expect(outcome).toMatchObject({ checked: 1, updated: 0 });
    expect(actions).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ce que le rattrapage ne doit jamais faire
// ─────────────────────────────────────────────────────────────────────────────

describe("garanties", () => {
  it("ne crée jamais de tâche", async () => {
    // Le point de sécurité : un rattrapage est une **lecture**. S'il pouvait
    // créer, une coupure réseau deviendrait une seconde commande.
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

  it("laisse intacte une tâche que le cœur ne rend pas", async () => {
    // Un 404 peut être une purge d'historique comme un incident. Effacer la
    // tâche ferait disparaître la trace sous les yeux de l'utilisateur.
    const state = taskState({ id: "t1", status: "running", title: "Ouvrir Chrome" });
    const { api } = core({ t1: "absent" });
    const { actions, dispatch } = collect();

    const outcome = await resyncTasks({ api, state, dispatch });

    expect(outcome).toMatchObject({ checked: 0, updated: 0, unreachable: 1 });
    expect(actions).toEqual([]);

    const after = actions.reduce(reduce, state);
    expect(after.tasks[0]?.status).toBe("running");
    expect(after.tasks[0]?.title).toBe("Ouvrir Chrome");
  });

  it("ne lève pas quand le cœur est injoignable", async () => {
    const state = taskState({ id: "t1", status: "running" }, { id: "t2", status: "running" });
    const api = {
      getTask: () => Promise.reject(new Error("ECONNREFUSED")),
    };

    await expect(resyncTasks({ api, state, dispatch: () => undefined })).resolves.toMatchObject({
      unreachable: 2,
    });
  });

  it("borne le nombre de tâches relues en une passe", async () => {
    // Une reconnexion après une longue absence ne doit pas déclencher cinquante
    // requêtes au moment précis où le cœur redémarre.
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

  it("ignore un statut que ce client ne connaît pas", async () => {
    // Un cœur plus récent que l'application : on garde l'état précédent plutôt
    // que d'afficher un état inventé.
    const state = taskState({ id: "t1", status: "running" });
    const { api } = core({ t1: apiTask({ id: "t1", status: "quelque_chose_de_neuf" }) });
    const { actions, dispatch } = collect();

    await resyncTasks({ api, state, dispatch });
    const after = actions.reduce(reduce, state);

    expect(after.tasks[0]?.status).toBe("running");
  });
});
