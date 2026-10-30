import { useState } from "react";
import type {
  DocumentType,
  DocumentVariant,
  GenerateDocumentInput,
  Opportunity,
} from "@nexus/client-core";
import { useI18n } from "../i18n/index.js";

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
  const { tr } = useI18n();
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
      setNotice(
        tr(
          "Tailored document variant generated with customized highlights and diff summary.",
          "Variante documentaire générée avec points saillants personnalisés et résumé des différences.",
        ),
      );
    } catch (err) {
      setNotice(
        err instanceof Error
          ? err.message
          : tr("Failed to generate document.", "Échec de génération du document."),
      );
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="career-tab-content" role="region" aria-label="Tailored Document Variants">
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
              "Tailored Document Variants & Previews",
              "Variantes Documentaires sur Mesure & Aperçus",
            )}
          </h2>
          <p style={{ margin: "0.25rem 0 0", color: "var(--muted-text)", fontSize: "0.85rem" }}>
            {tr(
              "Role-tailored CVs, motivation letters, research statements, and commercial rate cards with cryptographic digests and diff summaries.",
              "CV ciblés, lettres de motivation, déclarations de recherche et grilles tarifaires avec empreintes cryptographiques et résumés différentiels.",
            )}
          </p>
        </div>

        <button type="button" className="button primary" onClick={() => setShowGenerateModal(true)}>
          {tr("+ Generate Tailored Variant", "+ Générer une variante sur mesure")}
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
            {t === "all" && tr("All Variants", "Toutes les variantes")}
            {t === "cv" && tr("Tailored CVs", "CV sur mesure")}
            {t === "cover_letter" && tr("Cover Letters", "Lettres de motivation")}
            {t === "research_statement" && tr("Research Statements", "Projets de recherche")}
            {t === "rate_card" && tr("Freelance Rate Cards", "Grilles tarifaires freelance")}
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
            background: "var(--nx-ok-bg)",
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
          {tr("Loading document variants...", "Chargement des variantes documentaires...")}
        </div>
      ) : filtered.length === 0 ? (
        <div className="career-card" style={{ textAlign: "center", padding: "3rem" }}>
          <strong>{tr("No tailored documents found", "Aucun document sur mesure trouvé")}</strong>
          <p style={{ color: "var(--muted-text)", marginTop: "0.5rem" }}>
            {tr(
              'Click "Generate Tailored Variant" to craft a role-specific CV, cover letter, or statement.',
              'Cliquez sur "Générer une variante sur mesure" pour concevoir un CV, une lettre ou un projet ciblé.',
            )}
          </p>
        </div>
      ) : (
        <div className="career-grid-2">
          {filtered.map((doc) => (
            <article key={doc.id} className="career-card">
              <div className="career-card-header">
                <div>
                  <span
                    className={`career-track-pill ${doc.type === "rate_card" ? "freelance" : doc.type === "research_statement" ? "phd" : "cdi"}`}
                  >
                    {doc.type.replace("_", " ")}
                  </span>
                  <h3 style={{ margin: "0.35rem 0 0", fontSize: "1rem" }}>{doc.title}</h3>
                  <div style={{ fontSize: "0.8rem", color: "var(--muted-text)" }}>
                    {tr("Target:", "Cible :")} <strong>{doc.targetOrganization}</strong> (
                    {doc.targetRole})
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
              <div
                style={{
                  background: "var(--surface-2)",
                  padding: "0.65rem 0.85rem",
                  borderRadius: "var(--radius)",
                  fontSize: "0.8rem",
                }}
              >
                <strong style={{ color: "var(--bright-accent)" }}>
                  {tr("Tailored Highlights:", "Points saillants adaptés :")}
                </strong>
                <ul style={{ margin: "0.25rem 0 0.5rem", paddingLeft: "1.2rem", lineHeight: 1.4 }}>
                  {doc.tailoredHighlights.map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ul>

                <div
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    flexWrap: "wrap",
                    fontSize: "0.72rem",
                    color: "var(--muted-text)",
                  }}
                >
                  <span>
                    {tr("Sections Tailored:", "Sections adaptées :")}{" "}
                    <strong>{doc.diffSummary.sectionsTailored.join(", ")}</strong>
                  </span>
                  <span>
                    {tr("Skills:", "Compétences :")}{" "}
                    <strong>{doc.diffSummary.skillsEmphasized.join(", ")}</strong>
                  </span>
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
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginTop: "auto",
                  paddingTop: "0.5rem",
                  borderTop: "1px solid var(--border)",
                }}
              >
                <span style={{ fontSize: "0.72rem", color: "var(--muted-text)" }}>
                  {tr("Generated", "Généré le")} {new Date(doc.generatedAt).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  className="button compact"
                  onClick={() =>
                    void onExportConfirmation(doc).then(() =>
                      setNotice(
                        tr(
                          `Export draft initiated for ${doc.title}. Paused at Confirmation Card for safety.`,
                          `Brouillon d'export initialisé pour ${doc.title}. Suspendu à la carte de confirmation pour sécurité.`,
                        ),
                      ),
                    )
                  }
                  title={tr(
                    "Requests explicit confirmation before sending or exporting",
                    "Requiert une confirmation explicite avant tout envoi ou export",
                  )}
                >
                  {tr(
                    "Export Draft (Confirm Action)",
                    "Exporter le brouillon (Confirmer l'action)",
                  )}
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
                {tr(
                  "Generate Tailored Document Variant",
                  "Générer une variante documentaire adaptée",
                )}
              </h3>
              <button
                type="button"
                className="button compact"
                onClick={() => setShowGenerateModal(false)}
                aria-label={tr("Close", "Fermer")}
              >
                ✕
              </button>
            </div>

            <div className="career-form-group">
              <label htmlFor="targetOpp">
                {tr("Select Target Opportunity", "Sélectionner l'opportunité ciblée")}
              </label>
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
              <label htmlFor="docType">
                {tr("Document Variant Type", "Type de document sur mesure")}
              </label>
              <select
                id="docType"
                className="career-select"
                value={newDocType}
                onChange={(e) => setNewDocType(e.target.value as DocumentType)}
              >
                <option value="cv">
                  {tr("Curriculum Vitae (CV / Resume)", "Curriculum Vitae (CV)")}
                </option>
                <option value="cover_letter">
                  {tr("Motivation / Cover Letter", "Lettre de motivation")}
                </option>
                <option value="research_statement">
                  {tr(
                    "Doctoral Research Statement (PhD)",
                    "Projet de recherche doctoral (Doctorat / CIFRE)",
                  )}
                </option>
                <option value="rate_card">
                  {tr(
                    "Commercial Proposal & Rate Card (Freelance)",
                    "Proposition commerciale & TJM (Freelance)",
                  )}
                </option>
              </select>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button
                type="button"
                className="button"
                disabled={generating}
                onClick={() => setShowGenerateModal(false)}
              >
                {tr("Cancel", "Annuler")}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={generating}
                onClick={() => void handleGenerate()}
              >
                {generating
                  ? tr("Generating...", "Génération en cours...")
                  : tr("Generate Variant", "Générer la variante")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
