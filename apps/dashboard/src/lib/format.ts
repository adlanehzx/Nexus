import type { ActivityEntry, HealthEntry, TaskRow, WorkerRow } from "./api.js";

/**
 * Le peu de logique que le tableau de bord contient.
 *
 * Un écran de supervision doit trancher : à quoi la barre d'état ressemble-t-elle
 * quand un exécutant est déconnecté et qu'un serveur MCP n'a jamais été branché ?
 * Ce genre de question a une bonne réponse et plusieurs mauvaises, et les
 * mauvaises ne se voient qu'au moment où l'on a besoin du tableau de bord —
 * c'est-à-dire trop tard. Elles sont donc résolues ici, et éprouvées.
 *
 * Les composants, eux, ne décident de rien.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Santé
// ─────────────────────────────────────────────────────────────────────────────

export type OverallHealth = "ok" | "degraded" | "down" | "unknown";

/**
 * Santé globale à partir des sous-systèmes.
 *
 * Deux règles, et la seconde est celle qu'on oublie :
 *
 *  1. **le pire l'emporte.** Un système dont un composant est à terre n'est pas
 *     « partiellement en ligne » ;
 *  2. **un composant non configuré ne compte pas.** Ne jamais avoir branché de
 *     serveur MCP n'est pas une panne, et le peindre en rouge enverrait chercher
 *     un incident qui n'existe pas. S'il n'y a *que* du non-configuré, la
 *     réponse est `unknown` — on ne sait rien, et le dire vaut mieux que
 *     d'afficher un vert qui ne repose sur rien.
 */
export function overallHealth(entries: readonly HealthEntry[]): OverallHealth {
  const measured = entries.filter((entry) => entry.level !== "unconfigured");
  if (measured.length === 0) return "unknown";

  if (measured.some((entry) => entry.level === "down")) return "down";
  if (measured.some((entry) => entry.level === "degraded")) return "degraded";
  return "ok";
}

export const HEALTH_LABELS: Record<HealthEntry["level"], string> = {
  ok: "opérationnel",
  degraded: "dégradé",
  down: "hors service",
  unconfigured: "non configuré",
};

// ─────────────────────────────────────────────────────────────────────────────
// Exécutants
// ─────────────────────────────────────────────────────────────────────────────

export type WorkerState = "accepting" | "saturated" | "degraded" | "disconnected" | "revoked";

/**
 * État affiché d'un exécutant.
 *
 * L'ordre des tests **est** la décision. Un appareil révoqué peut rester marqué
 * `ONLINE` le temps que la déconnexion se propage ; l'afficher comme disponible
 * pendant ces quelques secondes serait le pire moment pour se tromper. La
 * révocation prime donc sur tout, puis la connexion réelle du canal, puis
 * seulement la charge.
 */
export function workerState(worker: WorkerRow): WorkerState {
  if (worker.trust === "REVOKED" || worker.status === "REVOKED") return "revoked";
  if (!worker.connected) return "disconnected";
  if (worker.status === "DEGRADED") return "degraded";
  if (worker.health.activeTasks >= worker.health.maxConcurrentTasks) return "saturated";
  return "accepting";
}

export const WORKER_LABELS: Record<WorkerState, string> = {
  accepting: "disponible",
  saturated: "saturé",
  degraded: "dégradé",
  disconnected: "déconnecté",
  revoked: "révoqué",
};

// ─────────────────────────────────────────────────────────────────────────────
// Tâches
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Les exécutants réellement retenus pour une tâche.
 *
 * Le plan déclare des capacités ; c'est le cœur qui choisit. La page de tâche
 * doit donc montrer **ce qui a été décidé**, pas ce qui avait été demandé — sans
 * quoi on ne peut pas répondre à « pourquoi ça a tourné là ? ».
 */
export function selectedWorkers(task: TaskRow): { id: string; name: string; steps: number }[] {
  const counts = new Map<string, { name: string; steps: number }>();

  for (const step of task.steps) {
    if (step.selectedDeviceId === null) continue;

    const existing = counts.get(step.selectedDeviceId);
    counts.set(step.selectedDeviceId, {
      name: step.selectedDeviceName ?? step.selectedDeviceId,
      steps: (existing?.steps ?? 0) + 1,
    });
  }

  return [...counts.entries()].map(([id, value]) => ({ id, ...value }));
}

/** Étapes en échec, celles qu'on vient chercher en premier. */
export function failedSteps(task: TaskRow): TaskRow["steps"] {
  return task.steps.filter((step) => step.error !== null || step.status === "failed");
}

// ─────────────────────────────────────────────────────────────────────────────
// Mise en forme
// ─────────────────────────────────────────────────────────────────────────────

/** Durée lisible. Les millisecondes n'apprennent rien au-delà de la seconde. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${String(Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${String(minutes)} min ${String(seconds)} s`;
}

/**
 * Âge d'un horodatage, en relatif.
 *
 * « il y a 3 min » se lit d'un coup d'œil ; une date absolue oblige à calculer.
 * Sur un écran de supervision, ce calcul est justement ce qu'on n'a pas le temps
 * de faire.
 */
export function formatAge(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "jamais";

  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";

  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1_000));
  if (seconds < 60) return `il y a ${String(seconds)} s`;
  if (seconds < 3_600) return `il y a ${String(Math.floor(seconds / 60))} min`;
  if (seconds < 86_400) return `il y a ${String(Math.floor(seconds / 3_600))} h`;

  return `il y a ${String(Math.floor(seconds / 86_400))} j`;
}

/** Nombre compact. Un compteur à six chiffres déborde toutes les colonnes. */
export function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} k`;
  return `${(value / 1_000_000).toFixed(1)} M`;
}

/**
 * Activité récente, la plus fraîche d'abord.
 *
 * Le tri est fait côté serveur, mais il est refait ici : les entrées de
 * plusieurs sources se rejoignent, et une liste de supervision qui n'est pas
 * chronologique induit en erreur bien plus qu'elle n'informe.
 */
export function sortActivity(entries: readonly ActivityEntry[]): ActivityEntry[] {
  return [...entries].sort((left, right) => (left.at < right.at ? 1 : -1));
}
