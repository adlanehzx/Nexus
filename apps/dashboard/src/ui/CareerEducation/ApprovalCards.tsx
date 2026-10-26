import { useState } from "react";
import type { ConfirmationRequest, ConfirmationStatus } from "@nexus/client-core";

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
      setActionNotice(err instanceof Error ? err.message : "Failed to process confirmation.");
    } finally {
      setProcessingId(null);
    }
  };

  const pendingCount = confirmations.filter((c) => c.status === "pending").length;

  return (
    <div className="career-edu-container" role="region" aria-label="Human-in-the-Loop Approval Action Center">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "1.2rem" }}>Consequential Action Approval Center</h2>
          <p style={{ margin: "0.25rem 0 0", color: "var(--muted-text)", fontSize: "0.85rem" }}>
            Every external action stops here. Inspect destination, documents, risks, and consequences before granting explicit human approval.
          </p>
        </div>
      </div>

      {/* Safety Policy Callout */}
      <div
        className="career-card"
        style={{
          background: "rgb(233 173 91 / 8%)",
          borderLeft: "4px solid var(--gradient)",
          gap: "0.4rem",
        }}
      >
        <strong style={{ color: "var(--gradient)", fontSize: "0.95rem" }}>
          🛡️ Zero Silent Mutations Policy
        </strong>
        <p style={{ margin: 0, fontSize: "0.82rem", lineHeight: 1.4 }}>
          NEXUS web search, browser automation, and Google Workspace reach <strong>preview/draft states only</strong>.
          No application form is submitted, no email is transmitted, and no calendar event is written without your durable, explicit confirmation.
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
                Pending Decisions
                {pendingCount > 0 && <span className="badge-counter">{pendingCount}</span>}
              </>
            )}
            {s === "approved" && "Approved"}
            {s === "rejected" && "Rejected"}
            {s === "cancelled" && "Cancelled"}
            {s === "expired" && "Expired"}
            {s === "all" && "All History"}
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
            background: "rgb(95 211 154 / 12%)",
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
          Loading pending confirmations...
        </div>
      ) : filtered.length === 0 ? (
        <div className="career-card" style={{ textAlign: "center", padding: "3rem" }}>
          <strong>No actions in status "{filterStatus}"</strong>
          <p style={{ color: "var(--muted-text)", marginTop: "0.5rem" }}>
            All actions requiring human confirmation have been resolved.
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
                      {conf.actionType === "browser_submit_application" && "🌐 Browser Form Submission"}
                      {conf.actionType === "gmail_send_draft" && "✉️ Gmail Outreach Email"}
                      {conf.actionType === "calendar_create_event" && "📅 Google Calendar Mutation"}
                      {conf.actionType === "document_export" && "📄 Document Package Export"}
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
                    Expires: {new Date(conf.expiresAt).toLocaleString()}
                  </span>
                </div>

                <div>
                  <h3 id={`conf-title-${conf.id}`} style={{ margin: "0 0 0.35rem", fontSize: "1.1rem" }}>
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
                  <strong style={{ color: "var(--muted-text)" }}>DESTINATION:</strong>
                  <code style={{ color: "var(--bright-accent)", wordBreak: "break-all" }}>
                    {conf.destination}
                  </code>
                </div>

                {/* Attached Documents */}
                {conf.attachedDocuments.length > 0 && (
                  <div style={{ fontSize: "0.82rem" }}>
                    <strong style={{ color: "var(--text)" }}>Attached Documents & Hashes:</strong>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", marginTop: "0.35rem" }}>
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
                          <span>📄 {doc.title} ({doc.type})</span>
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
                    Inspect Draft Payload / Transmitted Data
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
                  <strong>⚠️ Explicit Risks Identified:</strong>
                  <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.2rem", lineHeight: 1.4 }}>
                    {conf.risks.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>

                {/* Explicit Consequences Box */}
                <div className="consequences-box" role="status">
                  <strong>⚡ Anticipated Real-World Consequences:</strong>
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
                    <strong>Resolution Record:</strong> Marked as <em>{conf.status.toUpperCase()}</em> by{" "}
                    <strong>{conf.resolvedBy ?? "User"}</strong> at{" "}
                    {conf.decidedAt ? new Date(conf.decidedAt).toLocaleString() : "—"}.
                    {conf.decisionRationale && (
                      <div style={{ marginTop: "0.25rem", color: "var(--muted-text)" }}>
                        Rationale: {conf.decisionRationale}
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
                        className="button primary"
                        style={{ background: "var(--ok)", borderColor: "var(--ok)", color: "#000", fontWeight: 700 }}
                        disabled={isProcessing}
                        onClick={() =>
                          void handleResolve(
                            conf.id,
                            "approve",
                            `Action "${conf.title}" explicitly approved and recorded in audit log.`,
                          )
                        }
                      >
                        ✓ Grant Explicit Approval
                      </button>

                      <button
                        type="button"
                        className="button danger"
                        disabled={isProcessing}
                        onClick={() =>
                          void handleResolve(
                            conf.id,
                            "reject",
                            `Action "${conf.title}" rejected. External transmission blocked.`,
                          )
                        }
                      >
                        ✕ Reject Action
                      </button>

                      <button
                        type="button"
                        className="button"
                        disabled={isProcessing}
                        onClick={() =>
                          void handleResolve(
                            conf.id,
                            "cancel",
                            `Action "${conf.title}" cancelled by user.`,
                          )
                        }
                      >
                        Cancel Request
                      </button>
                    </div>

                    <input
                      type="text"
                      className="career-input"
                      style={{ maxWidth: "260px" }}
                      placeholder="Optional rationale / reason..."
                      value={rejectionReasons[conf.id] ?? ""}
                      onChange={(e) =>
                        setRejectionReasons({ ...rejectionReasons, [conf.id]: e.target.value })
                      }
                      aria-label="Decision rationale"
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
