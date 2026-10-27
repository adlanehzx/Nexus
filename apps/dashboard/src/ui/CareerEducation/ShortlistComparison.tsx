import type { OpportunityComparisonMatrix } from "@nexus/client-core";

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
  if (!matrix || matrix.opportunities.length === 0) {
    return (
      <div className="career-card" style={{ textAlign: "center", padding: "3rem" }}>
        <h3>No Opportunities Selected for Comparison</h3>
        <p style={{ color: "var(--muted-text)", marginTop: "0.5rem" }}>
          In the <strong>Inbox & Discovery</strong> tab, check the <em>"Compare"</em> checkbox on
          two or more opportunities (for example a doctoral position, permanent role, or independent
          engagement) to view an objective side-by-side evaluation.
        </p>
      </div>
    );
  }

  return (
    <div className="career-edu-container" role="region" aria-label="Opportunity Comparison Matrix">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "1.2rem" }}>
            Multi-Track Opportunity Comparison ({matrix.opportunities.length} positions)
          </h2>
          <p style={{ margin: "0.25rem 0 0", color: "var(--muted-text)", fontSize: "0.85rem" }}>
            Side-by-side metrics across doctoral programmes, permanent employment, and independent
            consulting missions.
          </p>
        </div>

        <button type="button" className="button" onClick={onClearComparison}>
          Reset Comparison Selection
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
        <strong style={{ fontSize: "0.95rem" }}>Strategic Tradeoff Analysis</strong>
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
        <table className="comparison-table" aria-label="Comparison metrics matrix">
          <thead>
            <tr>
              <th scope="col">Evaluation Metric</th>
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
              <th scope="row">Workflow Action</th>
              {matrix.opportunities.map((opp) => (
                <td key={opp.id}>
                  <button
                    type="button"
                    className="button primary compact"
                    onClick={() => onSelectApplication(opp.id)}
                  >
                    Open Application Track
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
