import type { ApiClient } from "./api.js";
import type { ClientAction, ClientState, TaskStatus, TaskView } from "./store.js";

/**
 * Rattrapage de l'état après une reconnexion.
 *
 * ## Le problème
 *
 * Le canal temps réel ne rejoue rien. Une tâche qui s'achève pendant que le
 * téléphone est dans le métro voit son `task.completed` partir vers une socket
 * fermée — et à la reconnexion, l'écran affiche encore « en cours ». C'est le
 * pire des états : faux, définitif, et parfaitement crédible.
 *
 * ## Ce que fait ce module
 *
 * Il relit, **auprès du cœur**, l'état des tâches que le client croit encore
 * actives. Le cœur est l'autorité ; le client rattrape.
 *
 * Trois propriétés, et chacune répond à un piège :
 *
 *  1. **Il ne relit que ce qui est inachevé.** Une tâche terminée ne change
 *     plus ; la relire coûterait une requête par tâche à chaque passage de
 *     tunnel.
 *  2. **Il ne crée jamais de tâche.** Le rattrapage est une *lecture*. Un
 *     rattrapage qui pourrait créer une tâche transformerait une coupure réseau
 *     en seconde commande — exactement ce qu'on veut empêcher.
 *  3. **Une tâche disparue du cœur est laissée telle quelle.** Un 404 peut être
 *     une purge d'historique comme un incident ; effacer la tâche de l'écran
 *     ferait disparaître la trace sous les yeux de l'utilisateur.
 *
 * ## Ce qu'il ne fait pas
 *
 * Il ne rejoue pas d'événements, ne reconstruit pas d'historique de messages et
 * ne réimplémente rien de la reprise côté cœur. Il lit un état et le pousse
 * dans le même réducteur que les trames temps réel.
 */

/** Statuts pour lesquels le cœur a encore quelque chose à dire. */
const UNFINISHED: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "pending",
  "running",
  "waiting_for_confirmation",
]);

export function isUnfinished(status: TaskStatus): boolean {
  return UNFINISHED.has(status);
}

/** Tâches que le client croit actives, et qu'il faut donc revérifier. */
export function unfinishedTaskIds(state: ClientState): string[] {
  return state.tasks.filter((task) => isUnfinished(task.status)).map((task) => task.id);
}

export interface ResyncOptions {
  api: Pick<ApiClient, "getTask">;
  state: ClientState;
  dispatch: (action: ClientAction) => void;
  /**
   * Plafond de tâches relues en une passe.
   *
   * Une reconnexion après une longue absence ne doit pas déclencher cinquante
   * requêtes d'un coup au moment précis où le cœur redémarre.
   */
  limit?: number;
}

export interface ResyncOutcome {
  /** Tâches effectivement relues auprès du cœur. */
  checked: number;
  /** Tâches dont l'état affiché était périmé. */
  updated: number;
  /** Tâches que le cœur n'a pas rendues — laissées intactes. */
  unreachable: number;
}

/**
 * Relit l'état des tâches inachevées et corrige l'affichage.
 *
 * Ne lève jamais : un rattrapage qui échoue laisse l'écran tel qu'il était,
 * ce qui est exactement l'état d'avant. Faire remonter l'erreur transformerait
 * une reconnexion en message d'échec alors que la connexion vient de revenir.
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

/**
 * Première erreur rencontrée dans le plan.
 *
 * Le cœur ne porte pas d'erreur au niveau de la tâche : elle vit sur l'étape
 * qui a échoué. On remonte la première, celle qui a arrêté le plan — les
 * suivantes n'ont pas eu lieu.
 */
function firstError(
  steps: readonly { error: { code: string; message: string } | null }[],
): TaskView["error"] {
  for (const step of steps) {
    if (step.error !== null) return step.error;
  }
  return null;
}
