import { useState } from "react";
import type { Application, ApplicationStage } from "@nexus/client-core";

interface ApplicationKanbanProps {
  applications: Application[];
  onUpdateStage: (appId: string, stage: ApplicationStage, note?: string) => Promise<void>;
  onOpenDocuments: (appId: string) => void;
  onOpenApprovals: () => void;
}

const STAGES: { id: ApplicationStage; label: string }[] = [
  { id: "discovered", label: "Discovered" },
  { id: "shortlisted", label: "Shortlisted" },
  { id: "preparing", label: "Preparing" },
  { id: "pending_approval", label: "Pending Approval" },
  { id: "submitted", label: "Submitted" },
  { id: "interviewing", label: "Interviewing" },
  { id: "offer", label: "Offer / Accepted" },
  { id: "rejected", label: "Closed / Rejected" },
];

export function ApplicationKanban({
  applications,
  onUpdateStage,
  onOpenDocuments,
  onOpenApprovals,
}: ApplicationKanbanProps) {
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [stageNote, setStageNote] = useState("");
  const [updating, setUpdating] = useState(false);

  const selectedApp = applications.find((a) => a.id === selectedAppId);

  const handleStageMove = async (appId: string, stage: ApplicationStage) => {
    setUpdating(true);
    try {
      await onUpdateStage(appId, stage, stageNote || undefined);
      setStageNote("");
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="career-edu-container" role="region" aria-label="Application Kanban Pipeline">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "1.2rem" }}>Application Kanban & Pipeline Timeline</h2>
          <p style={{ margin: "0.25rem 0 0", color: "var(--muted-text)", fontSize: "0.85rem" }}>
            Track application progression from initial discovery through tailored documents, human
            confirmation, interviews, and offers.
          </p>
        </div>
      </div>

      {/* Horizontal Kanban Columns */}
      <div className="kanban-board-scroll">
        {STAGES.map((col) => {
          const inStage = applications.filter((a) => a.stage === col.id);
          const isApprovalCol = col.id === "pending_approval";

          return (
            <div key={col.id} className="kanban-column">
              <div className="kanban-col-header">
                <span>{col.label}</span>
                <span className="kanban-col-count">{inStage.length}</span>
              </div>

              {isApprovalCol && inStage.length > 0 && (
                <div
                  style={{
                    padding: "0.4rem 0.6rem",
                    background: "var(--nx-warn-bg)",
                    border: "1px solid var(--gradient)",
                    borderRadius: "4px",
                    fontSize: "0.75rem",
                    color: "var(--gradient)",
                    cursor: "pointer",
                  }}
                  onClick={onOpenApprovals}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onOpenApprovals();
                  }}
                >
                  ⚡ Consequential action awaiting explicit confirmation! Click to inspect.
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
                {inStage.map((app) => (
                  <div
                    key={app.id}
                    className={`kanban-card ${app.stage === "pending_approval" ? "pending-approval-card" : ""}`}
                    onClick={() => setSelectedAppId(app.id)}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open application details for ${app.opportunity.title}`}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setSelectedAppId(app.id);
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <span className={`career-track-pill ${app.opportunity.track}`}>
                        {app.opportunity.track}
                      </span>
                      {app.tailoredDocumentIds.length > 0 && (
                        <span style={{ fontSize: "0.72rem", color: "var(--accent)" }}>
                          📄 {app.tailoredDocumentIds.length} Docs
                        </span>
                      )}
                    </div>

                    <strong style={{ fontSize: "0.9rem", color: "var(--text)" }}>
                      {app.opportunity.title}
                    </strong>

                    <div style={{ fontSize: "0.78rem", color: "var(--muted-text)" }}>
                      {app.opportunity.organization}
                    </div>

                    {app.nextDeadlineAt && (
                      <div
                        style={{
                          fontSize: "0.72rem",
                          color: "var(--gradient)",
                          marginTop: "0.25rem",
                        }}
                      >
                        ⏱ Deadline: {new Date(app.nextDeadlineAt).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Application Detail Drawer / Modal */}
      {selectedApp && (
        <div
          className="career-modal-backdrop"
          onClick={() => setSelectedAppId(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="app-drawer-title"
        >
          <div
            className="career-modal-content"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSelectedAppId(null);
            }}
          >
            <div className="career-modal-header">
              <h3 id="app-drawer-title" className="career-modal-title">
                {selectedApp.opportunity.title}
              </h3>
              <button
                type="button"
                className="button compact"
                onClick={() => setSelectedAppId(null)}
                aria-label="Close details"
              >
                ✕
              </button>
            </div>

            <div style={{ fontSize: "0.85rem", color: "var(--muted-text)" }}>
              <strong>{selectedApp.opportunity.organization}</strong> · Track:{" "}
              {selectedApp.opportunity.track.toUpperCase()} · Status:{" "}
              <strong style={{ color: "var(--bright-accent)" }}>{selectedApp.stage}</strong>
            </div>

            {/* Quick Actions Bar */}
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                type="button"
                className="button primary compact"
                onClick={() => {
                  onOpenDocuments(selectedApp.id);
                  setSelectedAppId(null);
                }}
              >
                Inspect / Tailor Documents ({selectedApp.tailoredDocumentIds.length})
              </button>
              {selectedApp.stage === "pending_approval" && (
                <button
                  type="button"
                  className="button compact warn"
                  onClick={() => {
                    onOpenApprovals();
                    setSelectedAppId(null);
                  }}
                >
                  Go to Approval Card ⚡
                </button>
              )}
            </div>

            {/* Stage Transition Controls */}
            <div className="career-card" style={{ gap: "0.75rem" }}>
              <strong>Transition Stage</strong>
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                {STAGES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    disabled={updating || selectedApp.stage === s.id}
                    className={`button compact ${selectedApp.stage === s.id ? "primary" : ""}`}
                    onClick={() => void handleStageMove(selectedApp.id, s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <input
                type="text"
                className="career-input"
                placeholder="Optional transition note or rationale..."
                value={stageNote}
                onChange={(e) => setStageNote(e.target.value)}
              />
            </div>

            {/* Stage History Timeline */}
            <div className="career-card" style={{ gap: "0.6rem" }}>
              <strong>Stage Transition History & Audit</strong>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.4rem",
                  fontSize: "0.8rem",
                }}
              >
                {selectedApp.stageHistory.map((h, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: "0.6rem",
                      padding: "0.4rem 0",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <span style={{ color: "var(--accent)", fontWeight: 700 }}>●</span>
                    <div style={{ flex: 1 }}>
                      <strong>{h.stage.toUpperCase()}</strong> —{" "}
                      <span style={{ color: "var(--muted-text)" }}>
                        {new Date(h.transitionedAt).toLocaleString()}
                      </span>
                      {h.note && (
                        <div style={{ marginTop: "0.2rem", color: "var(--text)" }}>{h.note}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
