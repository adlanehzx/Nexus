import { useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import { formatDuration } from "../../lib/format.js";
import { Empty, Metric, Section, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 17. Phase 2: Run Comparison (Codex Contract)
// ─────────────────────────────────────────────────────────────────────────────

export function RunComparison({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const [runA, setRunA] = useState("");
  const [runB, setRunB] = useState("");
  const [queryRuns, setQueryRuns] = useState<{ a: string; b: string } | null>(null);
  const state = useSection(
    () => (queryRuns === null ? Promise.resolve(null) : api.compareRuns(queryRuns.a, queryRuns.b)),
    [queryRuns],
  );

  return (
    <div className="content">
      <section className="card" style={{ marginBottom: "16px" }}>
        <div style={{ display: "flex", gap: "12px", alignItems: "flex-end" }}>
          <div>
            <label
              htmlFor="run-a-input"
              style={{ display: "block", marginBottom: "4px", fontSize: "0.85rem" }}
            >
              {tr("Baseline Run (A)", "Exécution de Référence (A)")}
            </label>
            <input
              id="run-a-input"
              className="field"
              value={runA}
              onChange={(e) => setRunA(e.target.value)}
              placeholder="e.g. run-1"
            />
          </div>
          <div>
            <label
              htmlFor="run-b-input"
              style={{ display: "block", marginBottom: "4px", fontSize: "0.85rem" }}
            >
              {tr("Comparison Run (B)", "Exécution de Comparaison (B)")}
            </label>
            <input
              id="run-b-input"
              className="field"
              value={runB}
              onChange={(e) => setRunB(e.target.value)}
              placeholder="e.g. run-2"
            />
          </div>
          <button
            className="button primary"
            type="button"
            disabled={runA.trim().length === 0 || runB.trim().length === 0}
            onClick={() => setQueryRuns({ a: runA, b: runB })}
          >
            {tr("Compare Runs", "Comparer les Exécutions")}
          </button>
        </div>
      </section>

      <Section state={state}>
        {(comparison) =>
          comparison === null ? (
            <Empty>
              {tr(
                "Enter two run IDs from the Agent runs page to compare them.",
                "Entrez deux identifiants d'exécution depuis la page Exécutions pour les comparer.",
              )}
            </Empty>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div className="metrics">
                <Metric
                  value={`${formatDuration(Math.abs(comparison.diffSummary.durationDeltaMs))}`}
                  label={tr(
                    `duration delta (${comparison.diffSummary.fasterRunId} faster)`,
                    `écart de durée (${comparison.diffSummary.fasterRunId} plus rapide)`,
                  )}
                />
                <Metric
                  value={`${comparison.diffSummary.tokenDelta > 0 ? "+" : ""}${String(comparison.diffSummary.tokenDelta)}`}
                  label={tr("token delta (B - A)", "écart de jetons (B - A)")}
                />
                <Metric
                  value={comparison.diffSummary.cheaperRunId}
                  label={tr("cheaper run", "exécution la plus économique")}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                <section className="card">
                  <h3>
                    {tr("Run A", "Exécution A")} ({comparison.runA.id})
                  </h3>
                  <div
                    style={{
                      marginTop: "12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                    }}
                  >
                    <div>
                      <strong>{tr("Agent:", "Agent :")}</strong> {comparison.runA.agentKey}
                    </div>
                    <div>
                      <strong>{tr("Status:", "Statut :")}</strong> {comparison.runA.status}
                    </div>
                    <div>
                      <strong>{tr("Duration:", "Durée :")}</strong>{" "}
                      {formatDuration(comparison.runA.durationMs)}
                    </div>
                    <div>
                      <strong>{tr("Tokens:", "Jetons :")}</strong>{" "}
                      {comparison.runA.tokenCount.toLocaleString()}
                    </div>
                    <div>
                      <strong>{tr("Cost:", "Coût :")}</strong> $
                      {comparison.runA.costEstimateUsd.toFixed(4)}
                    </div>
                    <div>
                      <strong>{tr("Steps:", "Étapes :")}</strong>{" "}
                      {String(comparison.runA.stepCount)}
                    </div>
                  </div>
                </section>

                <section className="card">
                  <h3>
                    {tr("Run B", "Exécution B")} ({comparison.runB.id})
                  </h3>
                  <div
                    style={{
                      marginTop: "12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                    }}
                  >
                    <div>
                      <strong>{tr("Agent:", "Agent :")}</strong> {comparison.runB.agentKey}
                    </div>
                    <div>
                      <strong>{tr("Status:", "Statut :")}</strong> {comparison.runB.status}
                    </div>
                    <div>
                      <strong>{tr("Duration:", "Durée :")}</strong>{" "}
                      {formatDuration(comparison.runB.durationMs)}
                    </div>
                    <div>
                      <strong>{tr("Tokens:", "Jetons :")}</strong>{" "}
                      {comparison.runB.tokenCount.toLocaleString()}
                    </div>
                    <div>
                      <strong>{tr("Cost:", "Coût :")}</strong> $
                      {comparison.runB.costEstimateUsd.toFixed(4)}
                    </div>
                    <div>
                      <strong>{tr("Steps:", "Étapes :")}</strong>{" "}
                      {String(comparison.runB.stepCount)}
                    </div>
                  </div>
                </section>
              </div>
            </div>
          )
        }
      </Section>
    </div>
  );
}
