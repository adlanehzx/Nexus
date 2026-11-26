import { useEffect, useState } from "react";
import type { DashboardApi } from "../lib/api.js";
import { useI18n } from "./i18n/index.js";
import { useSection } from "./parts.js";

/** Account-wide requests: an engine subtask can have its own conversation. */
export function PendingApprovals({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const requests = useSection(() => api.listApprovals(), [api]);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      requests.reload();
    }, 5000);
    return () => clearInterval(timer);
  }, [requests.reload]);
  async function respond(id: string, decision: "approved" | "rejected") {
    if (busy !== null) return;
    setBusy(id);
    setFeedback(null);
    try {
      const result = await api.respondToConfirmation(id, decision);
      setFeedback(
        result.accepted
          ? tr("Decision recorded.", "Décision enregistrée.")
          : tr(
              "This request expired or was already answered.",
              "Cette demande a expiré ou a déjà reçu une réponse.",
            ),
      );
      requests.reload();
    } catch (cause) {
      setFeedback(
        cause instanceof Error
          ? cause.message
          : tr("Unable to record decision.", "Impossible d’enregistrer la décision."),
      );
    } finally {
      setBusy(null);
    }
  }
  if (!requests.error && !feedback && !requests.data?.length) return null;
  return (
    <section className="card" aria-label={tr("Account approvals", "Accords de votre compte")}>
      <h2>{tr("Actions awaiting your approval", "Actions en attente de votre accord")}</h2>
      <p className="muted">
        {tr(
          "Requests from all your tasks. Approving authorizes only the action described.",
          "Demandes de toutes vos tâches. L’accord autorise uniquement l’action décrite.",
        )}
      </p>
      {requests.error ? <p role="alert">{requests.error}</p> : null}
      {feedback ? <p role="status">{feedback}</p> : null}
      {requests.data?.map((request) => {
        const expired = Date.parse(request.expiresAt) <= now;
        return (
          <article key={request.id}>
            <h3>
              {request.action} · {request.riskLevel}
            </h3>
            <p>{request.description}</p>
            <p>
              <code>{request.capability}</code> · {tr("Task", "Tâche")}{" "}
              <code>{request.taskId}</code>
            </p>
            <p>
              {tr("Expires", "Expire le")} {new Date(request.expiresAt).toLocaleString()}
            </p>
            <button
              className="button primary"
              disabled={busy !== null || expired}
              onClick={() => void respond(request.id, "approved")}
            >
              {tr("Approve this action", "Approuver cette action")}
            </button>{" "}
            <button
              className="button secondary"
              disabled={busy !== null || expired}
              onClick={() => void respond(request.id, "rejected")}
            >
              {tr("Reject", "Refuser")}
            </button>
          </article>
        );
      })}
    </section>
  );
}
