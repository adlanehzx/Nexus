import type { TaskCoordinator, TaskPlan } from "@nexus/devices";
import type { NotificationService } from "./notification-service.js";

/**
 * Suit les plans en cours d'exécution.
 *
 * `TaskCoordinator.execute()` s'annule par `AbortSignal` — c'est le bon
 * mécanisme, il propage jusqu'au processus enfant sur la machine cible. Mais un
 * client qui annule ne détient pas ce signal : il envoie `task.cancel` avec un
 * identifiant, des minutes plus tard, depuis un autre appareil que celui qui a
 * lancé la tâche.
 *
 * Ce superviseur fait le lien : il garde le contrôleur de chaque exécution en
 * vol et le déclenche sur demande. Il vit dans l'API plutôt que dans le
 * coordinateur, et c'est délibéré — le coordinateur n'a pas à savoir qu'il
 * existe des clients, des identifiants de requête ou des sessions.
 *
 * Il est aussi le seul endroit qui décide qu'une tâche terminée mérite une
 * notification : centraliser cette décision est ce qui garantit que l'iPhone et
 * le portable en reçoivent exactement une, identique.
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
   * Lance un plan **sans attendre sa fin**.
   *
   * Un plan peut durer des minutes ; une requête HTTP qui l'attendrait
   * expirerait. Le client suit la suite par le canal temps réel — c'est
   * exactement à cela qu'il sert.
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
   * Annule un plan en cours.
   *
   * Retourne `false` quand rien n'est en vol : la tâche est déjà terminée, ou
   * le serveur a redémarré depuis. Ce n'est pas une erreur — le client voulait
   * qu'elle s'arrête, et elle est arrêtée.
   */
  /**
   * Interrompt une exécution.
   *
   * `userId` est **exigé**, et vérifié contre le propriétaire du plan. Le
   * superviseur connaissait déjà ce propriétaire ; ne pas s'en servir laissait
   * n'importe quel compte authentifié arrêter l'exécution de quelqu'un d'autre
   * en devinant un identifiant de tâche.
   *
   * Un refus est indiscernable d'une tâche inconnue : les distinguer permettrait
   * de sonder l'existence des tâches d'autrui.
   */
  cancel(taskId: string, userId: string): boolean {
    const running = this.#running.get(taskId);
    if (running?.userId !== userId) return false;

    running.controller.abort();
    return true;
  }

  /** Interrompt tout — arrêt du serveur. */
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
