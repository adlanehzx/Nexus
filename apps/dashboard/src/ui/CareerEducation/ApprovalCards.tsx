import { useState } from "react";
import type { ConfirmationRequest, ConfirmationStatus } from "@nexus/client-core";
import { useI18n } from "../i18n/index.js";

interface ApprovalCardsProps {
  confirmations: ConfirmationRequest[];
  onResolveConfirmation: (
    id: string,
    decision: "approve" | "reject" | "cancel",
    reason?: string,
  ) => Promise<ConfirmationRequest>;
  loading?: boolean;
}

export function ApprovalCards({
  confirmations,
  onResolveConfirmation,
  loading = false,
}: ApprovalCardsProps) {
  const { tr } = useI18n();
  const [filterStatus, setFilterStatus] = useState<ConfirmationStatus | "all">("pending");
  const [rejectionReasons, setRejectionReasons] = useState<Record<string, string>>({});
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const filtered = confirmations.filter((c) => filterStatus === "all" || c.status === filterStatus);

  const handleResolve = async (
    id: string,
    decision: "approve" | "reject" | "cancel",
    defaultNotice: string,
  ) => {
    setProcessingId(id);
    setActionNotice(null);
    try {
      const reason = rejectionReasons[id];
      await onResolveConfirmation(id, decision, reason);
      setActionNotice(defaultNotice);
    } catch (err) {
      setActionNotice(
        err instanceof Error
          ? err.message
          : tr("Failed to process confirmation.", "Échec du traitement de la confirmation."),
      );
    } finally {
      setProcessingId(null);
    }
  };

  const pendingCount = confirmations.filter((c) => c.status === "pending").length;

  return (
    <div
      className="career-edu-container"
      role="region"
      aria-label="Human-in-the-Loop Approval Action Center"
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: "1.2rem" }}>
            {tr(
              "Consequential Action Approval Center",
              "Centre d'approbation des actions à conséquences",
            )}
          </h2>
          <p style={{ margin: "0.25rem 0 0", color: "var(--muted-text)", fontSize: "0.85rem" }}>
            {tr(
              "Every external action stops here. Inspect destination, documents, risks, and consequences before granting explicit human approval.",
              "Toute action externe s'arrête ici. Inspectez la destination, les documents, les risques et les conséquences avant d'accorder une approbation humaine explicite.",
            )}
          </p>
        </div>
      </div>

      {/* Safety Policy Callout */}
      <div
        className="career-card"
        style={{
          background: "var(--nx-warn-bg)",
          borderLeft: "4px solid var(--gradient)",
          gap: "0.4rem",
        }}
      >
        <strong style={{ color: "var(--gradient)", fontSize: "0.95rem" }}>
          🛡️ {tr("Zero Silent Mutations Policy", "Politique Zéro Mutation Silencieuse")}
        </strong>
        <p style={{ margin: 0, fontSize: "0.82rem", lineHeight: 1.4 }}>
          {tr(
            "NEXUS web search, browser automation, and Google Workspace reach preview/draft states only. No application form is submitted, no email is transmitted, and no calendar event is written without your durable, explicit confirmation.",
            "La recherche web, l'automatisation de navigateur et Google Workspace atteignent uniquement des états de prévisualisation ou brouillon. Aucun formulaire n'est soumis, aucun e-mail n'est transmis et aucun événement n'est écrit sans votre confirmation explicite et persistante.",
          )}
        </p>
      </div>

      {/* Status Filter Tabs */}
      <div className="career-tabs-bar" role="tablist" aria-label="Filter confirmations by status">
        {(["pending", "approved", "rejected", "cancelled", "expired", "all"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={filterStatus === s}
            className="career-tab-btn"
            onClick={() => setFilterStatus(s)}
          >
            {s === "pending" && (
              <>
                {tr("Pending Decisions", "Décisions en attente")}
                {pendingCount > 0 && <span className="badge-counter">{pendingCount}</span>}
              </>
            )}
            {s === "approved" && tr("Approved", "Approuvées")}
            {s === "rejected" && tr("Rejected", "Refusées")}
            {s === "cancelled" && tr("Cancelled", "Annulées")}
            {s === "expired" && tr("Expired", "Expirées")}
            {s === "all" && tr("All History", "Tout l'historique")}
          </button>
        ))}
      </div>

      {actionNotice && (
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: "0.65rem 1rem",
            borderRadius: "var(--radius)",
            background: "var(--nx-ok-bg)",
            color: "var(--ok)",
            fontSize: "0.85rem",
          }}
        >
          {actionNotice}
        </div>
      )}

      {/* Confirmation Cards Grid */}
      {loading ? (
        <div className="career-card" style={{ textAlign: "center", padding: "2rem" }}>
          {tr("Loading pending confirmations...", "Chargement des confirmations en attente...")}
        </div>
      ) : filtered.length === 0 ? (
        <div className="career-card" style={{ textAlign: "center", padding: "3rem" }}>
          <strong>
            {tr(
              `No actions in status "${filterStatus}"`,
              `Aucune action avec le statut "${filterStatus}"`,
            )}
          </strong>
          <p style={{ color: "var(--muted-text)", marginTop: "0.5rem" }}>
            {tr(
              "All actions requiring human confirmation have been resolved.",
              "Toutes les actions requérant une confirmation humaine ont été traitées.",
            )}
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {filtered.map((conf) => {
            const isPending = conf.status === "pending";
            const isProcessing = processingId === conf.id;

            return (
              <article
                key={conf.id}
                className={`approval-card ${conf.status}`}
                aria-labelledby={`conf-title-${conf.id}`}
              >
                <div className="action-type-header">
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span className="action-badge">
                      {conf.actionType === "browser_submit_application" &&
                        tr("🌐 Browser Form Submission", "🌐 Soumission de formulaire web")}
                      {conf.actionType === "gmail_send_draft" &&
                        tr("✉️ Gmail Outreach Email", "✉️ Envoi d'e-mail Gmail")}
                      {conf.actionType === "calendar_create_event" &&
                        tr("📅 Google Calendar Mutation", "📅 Création d'événement Google Agenda")}
                      {conf.actionType === "document_export" &&
                        tr("📄 Document Package Export", "📄 Export de dossier documentaire")}
                    </span>
                    <span
                      style={{
                        fontSize: "0.75rem",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        color:
                          conf.status === "approved"
                            ? "var(--ok)"
                            : conf.status === "pending"
                              ? "var(--gradient)"
                              : "var(--down)",
                      }}
                    >
                      {conf.status}
                    </span>
                  </div>

                  <span style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>
                    {tr("Expires:", "Expire le :")} {new Date(conf.expiresAt).toLocaleString()}
                  </span>
                </div>

                <div>
                  <h3
                    id={`conf-title-${conf.id}`}
                    style={{ margin: "0 0 0.35rem", fontSize: "1.1rem" }}
                  >
                    {conf.title}
                  </h3>
                  <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--text)" }}>
                    {conf.summary}
                  </p>
                </div>

                {/* Destination Banner */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    padding: "0.5rem 0.75rem",
                    background: "var(--surface-2)",
                    borderRadius: "4px",
                    fontSize: "0.82rem",
                  }}
                >
                  <strong style={{ color: "var(--muted-text)" }}>
                    {tr("DESTINATION:", "DESTINATION :")}
                  </strong>
                  <code style={{ color: "var(--bright-accent)", wordBreak: "break-all" }}>
                    {conf.destination}
                  </code>
                </div>

                {/* Attached Documents */}
                {conf.attachedDocuments.length > 0 && (
                  <div style={{ fontSize: "0.82rem" }}>
                    <strong style={{ color: "var(--text)" }}>
                      {tr("Attached Documents & Hashes:", "Documents joints & Empreintes :")}
                    </strong>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.3rem",
                        marginTop: "0.35rem",
                      }}
                    >
                      {conf.attachedDocuments.map((doc) => (
                        <div
                          key={doc.documentId}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            padding: "0.35rem 0.6rem",
                            background: "var(--surface-2)",
                            borderRadius: "4px",
                            fontSize: "0.78rem",
                          }}
                        >
                          <span>
                            📄 {doc.title} ({doc.type})
                          </span>
                          <span style={{ color: "var(--muted-text)", fontFamily: "monospace" }}>
                            SHA: {doc.digest.slice(0, 12)}...
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Form / Payload Preview */}
                <details style={{ fontSize: "0.8rem", color: "var(--muted-text)" }}>
                  <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                    {tr(
                      "Inspect Draft Payload / Transmitted Data",
                      "Inspecter la charge utile / données transmises",
                    )}
                  </summary>
                  <pre
                    style={{
                      background: "var(--elevated-background)",
                      padding: "0.75rem",
                      borderRadius: "4px",
                      overflowX: "auto",
                      marginTop: "0.5rem",
                      color: "var(--text)",
                    }}
                  >
                    {JSON.stringify(conf.payload, null, 2)}
                  </pre>
                </details>

                {/* Explicit Risks Box */}
                <div className="risks-box" role="alert">
                  <strong>
                    {tr("⚠️ Explicit Risks Identified:", "⚠️ Risques explicites identifiés :")}
                  </strong>
                  <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.2rem", lineHeight: 1.4 }}>
                    {conf.risks.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>

                {/* Explicit Consequences Box */}
                <div className="consequences-box" role="status">
                  <strong>
                    {tr(
                      "⚡ Anticipated Real-World Consequences:",
                      "⚡ Conséquences réelles anticipées :",
                    )}
                  </strong>
                  <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.2rem", lineHeight: 1.4 }}>
                    {conf.consequences.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </div>

                {/* Resolved Record if already decided */}
                {!isPending && (
                  <div
                    style={{
                      padding: "0.6rem 0.85rem",
                      background: "var(--surface-2)",
                      borderRadius: "var(--radius)",
                      fontSize: "0.82rem",
                      borderLeft: `3px solid ${conf.status === "approved" ? "var(--ok)" : "var(--down)"}`,
                    }}
                  >
                    <strong>{tr("Resolution Record:", "Registre de résolution :")}</strong>{" "}
                    {tr("Marked as", "Marqué comme")} <em>{conf.status.toUpperCase()}</em>{" "}
                    {tr("by", "par")}{" "}
                    <strong>{conf.resolvedBy ?? tr("User", "Utilisateur")}</strong> {tr("at", "le")}{" "}
                    {conf.decidedAt ? new Date(conf.decidedAt).toLocaleString() : "—"}.
                    {conf.decisionRationale && (
                      <div style={{ marginTop: "0.25rem", color: "var(--muted-text)" }}>
                        {tr("Rationale:", "Justification :")} {conf.decisionRationale}
                      </div>
                    )}
                  </div>
                )}

                {/* Pending Actions Decision Controls */}
                {isPending && (
                  <div className="approval-actions-bar">
                    <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", flex: 1 }}>
                      <button
                        type="button"
                        className="button ok"
                        disabled={isProcessing}
                        onClick={() =>
                          void handleResolve(
                            conf.id,
                            "approve",
                            tr(
                              `Action "${conf.title}" explicitly approved and recorded in audit log.`,
                              `Action "${conf.title}" explicitement approuvée et consignée dans l'audit.`,
                            ),
                          )
                        }
                      >
                        {tr("✓ Grant Explicit Approval", "✓ Accorder l'approbation explicite")}
                      </button>

                      <button
                        type="button"
                        className="button danger"
                        disabled={isProcessing}
                        onClick={() =>
                          void handleResolve(
                            conf.id,
                            "reject",
                            tr(
                              `Action "${conf.title}" rejected. External transmission blocked.`,
                              `Action "${conf.title}" rejetée. Transmission externe bloquée.`,
                            ),
                          )
                        }
                      >
                        {tr("✕ Reject Action", "✕ Rejeter l'action")}
                      </button>

                      <button
                        type="button"
                        className="button"
                        disabled={isProcessing}
                        onClick={() =>
                          void handleResolve(
                            conf.id,
                            "cancel",
                            tr(
                              `Action "${conf.title}" cancelled by user.`,
                              `Action "${conf.title}" annulée par l'utilisateur.`,
                            ),
                          )
                        }
                      >
                        {tr("Cancel Request", "Annuler la demande")}
                      </button>
                    </div>

                    <input
                      type="text"
                      className="career-input"
                      style={{ maxWidth: "260px" }}
                      placeholder={tr(
                        "Optional rationale / reason...",
                        "Justification / motif facultatif...",
                      )}
                      value={rejectionReasons[conf.id] ?? ""}
                      onChange={(e) =>
                        setRejectionReasons({ ...rejectionReasons, [conf.id]: e.target.value })
                      }
                      aria-label={tr("Decision rationale", "Justification de la décision")}
                    />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
