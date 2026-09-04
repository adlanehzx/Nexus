import { useState } from "react";
import type { ConfirmationView, MessageView, TaskView, ToolCallView } from "@nexus/client-core";

/**
 * Les briques d'affichage communes.
 *
 * Elles sont volontairement bêtes : elles reçoivent une vue déjà calculée par
 * `@nexus/client-core` et la dessinent. Aucune ne décide de rien — pas de
 * filtrage, pas de tri, pas d'interprétation d'un statut. Ce qui se décide se
 * teste, et ce qui se teste ne vit pas dans un composant.
 */

// ─────────────────────────────────────────────────────────────────────────────

export function MessageBubble({ message }: { message: MessageView }) {
  return (
    <div className={`bulle ${message.role}`}>
      {message.content}
      {message.streaming ? <span aria-label="réponse en cours"> ▌</span> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const LIBELLE_STATUT: Record<TaskView["status"], string> = {
  pending: "en attente",
  running: "en cours",
  waiting_for_confirmation: "attend une confirmation",
  succeeded: "terminée",
  partial: "terminée partiellement",
  failed: "échouée",
  cancelled: "annulée",
};

function tonStatut(status: TaskView["status"]): string {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "cancelled") return "ko";
  if (status === "partial" || status === "waiting_for_confirmation") return "attention";
  return "";
}

export function TaskCard(props: {
  task: TaskView;
  /** Nom lisible de l'exécutant. L'identifiant seul ne dit rien à personne. */
  deviceName?: string | undefined;
  onCancel?: ((taskId: string) => void) | undefined;
}) {
  const { task } = props;
  const enCours = task.status === "running" || task.status === "pending";

  return (
    <article className="carte">
      <header>
        <strong>{task.title}</strong>
        <span className={`etiquette ${tonStatut(task.status)}`}>{LIBELLE_STATUT[task.status]}</span>
      </header>

      <div className="faible">
        {task.label ?? `${String(task.stepCount)} étape(s)`}
        {props.deviceName === undefined ? null : ` · sur ${props.deviceName}`}
        {task.startedAt === null ? null : ` · démarrée à ${heure(task.startedAt)}`}
        {task.durationMs === null ? null : ` · ${String(Math.round(task.durationMs / 1000))} s`}
      </div>

      {task.originClientDeviceId === null ? null : (
        <div className="faible">Demandée depuis : {task.originClientDeviceId}</div>
      )}

      {task.error === null ? null : (
        <div className="faible" style={{ color: "var(--erreur)" }}>
          {task.error.code} — {task.error.message}
        </div>
      )}

      <div className="jauge">
        <div style={{ width: `${String(task.percent)}%` }} />
      </div>

      {enCours && props.onCancel !== undefined ? (
        <div className="rangee" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="bouton danger"
            onClick={() => {
              props.onCancel?.(task.id);
            }}
          >
            Annuler
          </button>
        </div>
      ) : null}
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function ToolCard({ call }: { call: ToolCallView }) {
  return (
    <article className="carte">
      <header>
        <strong>{call.tool}</strong>
        <span
          className={`etiquette ${
            call.status === "succeeded" ? "ok" : call.status === "failed" ? "ko" : ""
          }`}
        >
          {call.status === "running"
            ? "en cours"
            : call.status === "succeeded"
              ? "terminé"
              : "échoué"}
        </span>
      </header>
      {/* Le résumé, jamais les arguments : ils peuvent contenir un chemin, un
          jeton, ou le contenu d'un fichier. */}
      <div className="faible">{call.summary}</div>
      <div className="faible">risque : {call.riskLevel}</div>
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Demande de confirmation.
 *
 * Trois garde-fous contre l'approbation accidentelle, les mêmes que sur
 * l'iPhone parce que le risque est le même :
 *
 *  1. **Refuser à gauche, Approuver à droite** — le geste réflexe n'est pas
 *     l'accord.
 *  2. **Double appui** pour les risques élevés : le premier arme, le second
 *     confirme. Une confirmation sur un clic est une confirmation par accident.
 *  3. **Le niveau de risque est écrit**, en toutes lettres et en couleur.
 */
export function ConfirmationCard(props: {
  confirmation: ConfirmationView;
  onDecide: (id: string, decision: "approved" | "rejected") => void;
}) {
  const { confirmation } = props;
  const [arme, setArme] = useState(false);

  const eleve = confirmation.riskLevel === "HIGH" || confirmation.riskLevel === "CRITICAL";

  return (
    <article className={`carte confirmation ${eleve ? "critique" : ""}`}>
      <header>
        <strong>{confirmation.action}</strong>
        <span className={`etiquette ${eleve ? "ko" : "attention"}`}>
          risque {confirmation.riskLevel}
        </span>
      </header>

      <div>{confirmation.description}</div>
      {confirmation.capability === null ? null : (
        <div className="faible">capacité : {confirmation.capability}</div>
      )}
      <div className="faible">valable jusqu'à {heure(confirmation.expiresAt)}</div>

      <div className="actions">
        <button
          type="button"
          className="bouton"
          disabled={confirmation.answered}
          onClick={() => {
            props.onDecide(confirmation.id, "rejected");
          }}
        >
          Refuser
        </button>

        {eleve && !arme ? (
          <button
            type="button"
            className="bouton approuver"
            disabled={confirmation.answered}
            onClick={() => {
              setArme(true);
            }}
          >
            Approuver…
          </button>
        ) : (
          <button
            type="button"
            className="bouton primaire approuver"
            disabled={confirmation.answered}
            onClick={() => {
              props.onDecide(confirmation.id, "approved");
            }}
          >
            {eleve ? "Confirmer l'approbation" : "Approuver"}
          </button>
        )}
      </div>
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function ConnectionBanner({ connection, online }: { connection: string; online: boolean }) {
  if (connection === "connected") return null;

  const texte = !online
    ? "Hors ligne. NEXUS reprendra dès le retour du réseau."
    : connection === "reconnecting"
      ? "Reconnexion au cœur NEXUS…"
      : connection === "connecting" || connection === "authenticating"
        ? "Connexion au cœur NEXUS…"
        : "Déconnecté du cœur NEXUS.";

  return <div className="banniere">{texte}</div>;
}

export function ErrorBanner(props: {
  error: { code: string; message: string } | null;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  if (props.error === null) return null;

  return (
    <div className="banniere erreur rangee">
      <span style={{ flex: 1 }}>{props.error.message}</span>
      <button type="button" className="bouton" onClick={props.onRetry}>
        Réessayer
      </button>
      <button type="button" className="bouton" onClick={props.onDismiss}>
        Fermer
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/** Heure locale, sans la date : la fenêtre affiche surtout de l'aujourd'hui. */
function heure(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
