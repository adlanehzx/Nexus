import type { OpportunityComparisonMatrix } from "@nexus/client-core";
import { useI18n } from "../i18n/index.js";

interface ShortlistComparisonProps {
  matrix: OpportunityComparisonMatrix | null;
  onClearComparison: () => void;
  onSelectApplication: (oppId: string) => void;
}

export function ShortlistComparison({
  matrix,
  onClearComparison,
  onSelectApplication,
}: ShortlistComparisonProps) {
  const { tr } = useI18n();

  if (!matrix || matrix.opportunities.length === 0) {
    return (
      <div className="career-card" style={{ textAlign: "center", padding: "3rem" }}>
        <h3>
          {tr(
            "No Opportunities Selected for Comparison",
            "Aucune opportunité sélectionnée pour comparaison",
          )}
        </h3>
        <p style={{ color: "var(--muted-text)", marginTop: "0.5rem" }}>
          {tr(
            'In the Inbox & Discovery tab, check the "Compare" checkbox on two or more opportunities (for example a doctoral position, permanent role, or independent engagement) to view an objective side-by-side evaluation.',
            'Dans l\'onglet Découverte & Flux, cochez la case "Comparer" sur deux opportunités ou plus (par exemple une thèse, un poste CDI ou une mission freelance) pour afficher une évaluation comparative objective.',
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="career-edu-container" role="region" aria-label="Opportunity Comparison Matrix">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "1.2rem" }}>
            {tr(
              `Multi-Track Opportunity Comparison (${matrix.opportunities.length} positions)`,
              `Comparaison Multi-Filières (${matrix.opportunities.length} opportunités)`,
            )}
          </h2>
          <p style={{ margin: "0.25rem 0 0", color: "var(--muted-text)", fontSize: "0.85rem" }}>
            {tr(
              "Side-by-side metrics across doctoral programmes, permanent employment, and independent consulting missions.",
              "Métriques comparatives entre programmes doctoraux, emplois en CDI et missions indépendantes.",
            )}
          </p>
        </div>

        <button type="button" className="button" onClick={onClearComparison}>
          {tr("Reset Comparison Selection", "Réinitialiser la sélection")}
        </button>
      </div>

      {/* Tradeoffs Summary Box */}
      <div
        className="career-card"
        style={{
          background: "var(--surface-2)",
          borderLeft: "4px solid var(--accent)",
          gap: "0.5rem",
        }}
      >
        <strong style={{ fontSize: "0.95rem" }}>
          {tr("Strategic Tradeoff Analysis", "Analyse Stratégique des Compromis")}
        </strong>
        <ul
          style={{
            margin: "0.25rem 0 0",
            paddingLeft: "1.2rem",
            fontSize: "0.85rem",
            lineHeight: 1.5,
          }}
        >
          {matrix.tradeoffsSummary.map((item, idx) => (
            <li key={idx}>{item}</li>
          ))}
        </ul>
      </div>

      {/* Comparison Matrix Table */}
      <div className="comparison-table-wrapper">
        <table
          className="comparison-table"
          aria-label={tr("Comparison metrics matrix", "Matrice des métriques comparatives")}
        >
          <thead>
            <tr>
              <th scope="col">{tr("Evaluation Metric", "Métrique d'évaluation")}</th>
              {matrix.opportunities.map((opp) => (
                <th key={opp.id} scope="col">
                  <div>
                    <span
                      className={`career-track-pill ${opp.track}`}
                      style={{ marginBottom: "0.35rem" }}
                    >
                      {opp.track}
                    </span>
                    <div style={{ fontSize: "0.95rem", fontWeight: 700 }}>{opp.title}</div>
                    <div
                      style={{ fontSize: "0.8rem", color: "var(--muted-text)", fontWeight: 400 }}
                    >
                      {opp.organization}
                    </div>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.metrics.map((metric) => (
              <tr key={metric.key}>
                <th scope="row">{metric.label}</th>
                {matrix.opportunities.map((opp) => {
                  const val = metric.valuesByOpportunityId[opp.id];
                  const isWinner = metric.winnerOpportunityId === opp.id;

                  return (
                    <td key={opp.id} className={isWinner ? "winner-cell" : ""}>
                      {isWinner && (
                        <span style={{ marginRight: "0.35rem", color: "var(--ok)" }}>★</span>
                      )}
                      {String(val ?? "—")}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <th scope="row">{tr("Workflow Action", "Action du flux")}</th>
              {matrix.opportunities.map((opp) => (
                <td key={opp.id}>
                  <button
                    type="button"
                    className="button primary compact"
                    onClick={() => onSelectApplication(opp.id)}
                  >
                    {tr("Open Application Track", "Ouvrir le suivi de candidature")}
                  </button>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
