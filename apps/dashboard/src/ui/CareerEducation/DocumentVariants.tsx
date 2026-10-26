import { useState } from "react";
import type {
  DocumentType,
  DocumentVariant,
  GenerateDocumentInput,
  Opportunity,
} from "@nexus/client-core";

interface DocumentVariantsProps {
  documents: DocumentVariant[];
  opportunities: Opportunity[];
  onGenerateDocument: (input: GenerateDocumentInput) => Promise<DocumentVariant>;
  onExportConfirmation: (doc: DocumentVariant) => Promise<void>;
  loading?: boolean;
}

export function DocumentVariants({
  documents,
  opportunities,
  onGenerateDocument,
  onExportConfirmation,
  loading = false,
}: DocumentVariantsProps) {
  const [selectedType, setSelectedType] = useState<DocumentType | "all">("all");
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [targetOppId, setTargetOppId] = useState<string>(opportunities[0]?.id ?? "");
  const [newDocType, setNewDocType] = useState<DocumentType>("cv");
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const filtered = documents.filter((d) => selectedType === "all" || d.type === selectedType);

  const handleGenerate = async () => {
    if (!targetOppId) return;
    setGenerating(true);
    setNotice(null);
    try {
      await onGenerateDocument({
        opportunityId: targetOppId,
        type: newDocType,
      });
      setShowGenerateModal(false);
      setNotice("Tailored document variant generated with customized highlights and diff summary.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Failed to generate document.");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="career-edu-container" role="region" aria-label="Tailored Document Variants">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "1.2rem" }}>Tailored Document Variants & Previews</h2>
          <p style={{ margin: "0.25rem 0 0", color: "var(--muted-text)", fontSize: "0.85rem" }}>
            Role-tailored CVs, motivation letters, research statements, and commercial rate cards with cryptographic digests and diff summaries.
          </p>
        </div>

        <button
          type="button"
          className="button primary"
          onClick={() => setShowGenerateModal(true)}
        >
          + Generate Tailored Variant
        </button>
      </div>

      {/* Filter Tabs */}
      <div className="career-tabs-bar" role="tablist" aria-label="Filter documents by type">
        {(["all", "cv", "cover_letter", "research_statement", "rate_card"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={selectedType === t}
            className="career-tab-btn"
            onClick={() => setSelectedType(t)}
          >
            {t === "all" && "All Variants"}
            {t === "cv" && "Tailored CVs"}
            {t === "cover_letter" && "Cover Letters"}
            {t === "research_statement" && "Research Statements"}
            {t === "rate_card" && "Freelance Rate Cards"}
          </button>
        ))}
      </div>

      {notice && (
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
          {notice}
        </div>
      )}

      {/* Document Grid */}
      {loading ? (
        <div className="career-card" style={{ textAlign: "center", padding: "2rem" }}>
          Loading document variants...
        </div>
      ) : filtered.length === 0 ? (
        <div className="career-card" style={{ textAlign: "center", padding: "3rem" }}>
          <strong>No tailored documents found</strong>
          <p style={{ color: "var(--muted-text)", marginTop: "0.5rem" }}>
            Click <em>"Generate Tailored Variant"</em> to craft a role-specific CV, cover letter, or statement.
          </p>
        </div>
      ) : (
        <div className="career-grid-2">
          {filtered.map((doc) => (
            <article key={doc.id} className="career-card">
              <div className="career-card-header">
                <div>
                  <span className={`career-track-pill ${doc.type === "rate_card" ? "freelance" : doc.type === "research_statement" ? "phd" : "cdi"}`}>
                    {doc.type.replace("_", " ")}
                  </span>
                  <h3 style={{ margin: "0.35rem 0 0", fontSize: "1rem" }}>{doc.title}</h3>
                  <div style={{ fontSize: "0.8rem", color: "var(--muted-text)" }}>
                    Target: <strong>{doc.targetOrganization}</strong> ({doc.targetRole})
                  </div>
                </div>

                <span
                  style={{
                    fontSize: "0.68rem",
                    padding: "0.15rem 0.4rem",
                    background: "var(--surface-2)",
                    borderRadius: "4px",
                    color: "var(--muted-text)",
                  }}
                  title={`Cryptographic SHA-256 Digest: ${doc.digestSha256}`}
                >
                  SHA: {doc.digestSha256.slice(0, 8)}...
                </span>
              </div>

              {/* Tailored Highlights & Diff Summary */}
              <div style={{ background: "var(--surface-2)", padding: "0.65rem 0.85rem", borderRadius: "var(--radius)", fontSize: "0.8rem" }}>
                <strong style={{ color: "var(--bright-accent)" }}>Tailored Highlights:</strong>
                <ul style={{ margin: "0.25rem 0 0.5rem", paddingLeft: "1.2rem", lineHeight: 1.4 }}>
                  {doc.tailoredHighlights.map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>

                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", fontSize: "0.72rem", color: "var(--muted-text)" }}>
                  <span>Sections Tailored: <strong>{doc.diffSummary.sectionsTailored.join(", ")}</strong></span>
                  <span>Skills: <strong>{doc.diffSummary.skillsEmphasized.join(", ")}</strong></span>
                </div>
              </div>

              {/* Markdown Content Preview */}
              <div
                style={{
                  background: "var(--elevated-background)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: "0.75rem",
                  fontSize: "0.8rem",
                  fontFamily: "monospace",
                  maxHeight: "180px",
                  overflowY: "auto",
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.4,
                  color: "var(--text)",
                }}
              >
                {doc.markdownContent}
              </div>

              {/* Actions */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "auto", paddingTop: "0.5rem", borderTop: "1px solid var(--border)" }}>
                <span style={{ fontSize: "0.72rem", color: "var(--muted-text)" }}>
                  Generated {new Date(doc.generatedAt).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  className="button compact"
                  onClick={() =>
                    void onExportConfirmation(doc).then(() =>
                      setNotice(`Export draft initiated for ${doc.title}. Paused at Confirmation Card for safety.`),
                    )
                  }
                  title="Requests explicit confirmation before sending or exporting"
                >
                  Export Draft (Confirm Action)
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Generate Document Modal */}
      {showGenerateModal && (
        <div
          className="career-modal-backdrop"
          onClick={() => setShowGenerateModal(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="gen-modal-title"
        >
          <div className="career-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="career-modal-header">
              <h3 id="gen-modal-title" className="career-modal-title">
                Generate Tailored Document Variant
              </h3>
              <button
                type="button"
                className="button compact"
                onClick={() => setShowGenerateModal(false)}
              >
                ✕
              </button>
            </div>

            <div className="career-form-group">
              <label htmlFor="targetOpp">Select Target Opportunity</label>
              <select
                id="targetOpp"
                className="career-select"
                value={targetOppId}
                onChange={(e) => setTargetOppId(e.target.value)}
              >
                {opportunities.map((o) => (
                  <option key={o.id} value={o.id}>
                    [{o.track.toUpperCase()}] {o.title} — {o.organization}
                  </option>
                ))}
              </select>
            </div>

            <div className="career-form-group">
              <label htmlFor="docType">Document Variant Type</label>
              <select
                id="docType"
                className="career-select"
                value={newDocType}
                onChange={(e) => setNewDocType(e.target.value as DocumentType)}
              >
                <option value="cv">Curriculum Vitae (CV / Resume)</option>
                <option value="cover_letter">Motivation / Cover Letter</option>
                <option value="research_statement">Doctoral Research Statement (PhD)</option>
                <option value="rate_card">Commercial Proposal & Rate Card (Freelance)</option>
              </select>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button
                type="button"
                className="button"
                disabled={generating}
                onClick={() => setShowGenerateModal(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button primary"
                disabled={generating}
                onClick={() => void handleGenerate()}
              >
                {generating ? "Generating..." : "Generate Variant"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
