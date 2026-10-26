import { useMemo, useState } from "react";
import { buildOsintMission, osintInvestigationSchema } from "@nexus/osint";
import type { DashboardApi, OrchestratedMission } from "../lib/api.js";

const TEMPLATES = [
  {
    id: "professional_person",
    label: "Professional footprint",
    detail: "Public roles, publications, affiliations and career chronology.",
  },
  {
    id: "organization",
    label: "Organization intelligence",
    detail: "Ownership, leadership, filings, products, risks and public activity.",
  },
  {
    id: "technical_asset",
    label: "Technical exposure",
    detail: "Public domains, certificates, repositories and documented infrastructure.",
  },
  {
    id: "claim_verification",
    label: "Claim verification",
    detail: "Corroborate a statement and expose contradictions with cited evidence.",
  },
] as const;

export function OsintWorkspace({
  api,
  onOpenMissions,
}: {
  api: DashboardApi;
  onOpenMissions: () => void;
}) {
  const [kind, setKind] = useState<(typeof TEMPLATES)[number]["id"]>("organization");
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [objective, setObjective] = useState("");
  const [lawful, setLawful] = useState(false);
  const [mission, setMission] = useState<OrchestratedMission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useMemo(() => TEMPLATES.find((template) => template.id === kind)!, [kind]);

  const launch = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const request = osintInvestigationSchema.parse({
        title,
        kind,
        target,
        objective,
        maxSources: 12,
        lawfulPurposeConfirmed: lawful,
      });
      setMission(await api.sendToNexus(buildOsintMission(request)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Investigation could not be started.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="domain-workspace osint-workspace">
      <section className="domain-hero osint-hero">
        <div>
          <span className="domain-kicker">PUBLIC-SOURCE INTELLIGENCE</span>
          <h2>Turn open information into traceable evidence.</h2>
          <p>
            Delegate research across agents, preserve citations, surface contradictions, and keep
            every conclusion auditable.
          </p>
        </div>
        <div className="domain-hero-stat">
          <strong>Public only</strong>
          <span>No access-control bypass</span>
        </div>
      </section>

      <div className="osint-layout">
        <section className="domain-panel">
          <div className="section-heading">
            <div>
              <span className="eyebrow">01 · SCOPE</span>
              <h3>Investigation type</h3>
            </div>
          </div>
          <div className="template-grid">
            {TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                className={`template-card ${kind === template.id ? "active" : ""}`}
                onClick={() => setKind(template.id)}
              >
                <span className="template-marker" aria-hidden="true" />
                <strong>{template.label}</strong>
                <small>{template.detail}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="domain-panel osint-brief">
          <div className="section-heading">
            <div>
              <span className="eyebrow">02 · BRIEF</span>
              <h3>{active.label}</h3>
            </div>
          </div>
          <div className="settings-grid">
            <label>
              Case title
              <input
                className="field"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="e.g. Supplier ownership review"
              />
            </label>
            <label>
              Public target
              <input
                className="field"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder="Organization, professional, domain or claim"
              />
            </label>
            <label className="settings-wide">
              Decision or question
              <textarea
                className="field"
                rows={5}
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                placeholder="What decision should this investigation support?"
              />
            </label>
          </div>
          <label className="consent-row">
            <input
              type="checkbox"
              checked={lawful}
              onChange={(event) => setLawful(event.target.checked)}
            />
            <span>
              I confirm a legitimate purpose and authorize research limited to lawfully accessible
              public sources.
            </span>
          </label>
          <div className="settings-actions">
            <button
              className="button primary domain-cta"
              type="button"
              disabled={
                busy ||
                !lawful ||
                title.trim().length < 3 ||
                target.trim().length < 2 ||
                objective.trim().length < 10
              }
              onClick={() => void launch()}
            >
              {busy ? "Building investigation…" : "Launch investigation"}
            </button>
          </div>
          {error === null ? null : <p className="banner error">{error}</p>}
        </section>
      </div>

      <section className="domain-panel evidence-contract">
        <div>
          <span className="eyebrow">EVIDENCE CONTRACT</span>
          <h3>What NEXUS must deliver</h3>
        </div>
        <div className="evidence-grid">
          <span>Executive summary</span>
          <span>Verified timeline</span>
          <span>Entity relationships</span>
          <span>Confidence levels</span>
          <span>Contradictions</span>
          <span>Direct citations</span>
        </div>
      </section>

      {mission === null ? null : (
        <section className="domain-panel mission-launched">
          <div>
            <span className="status-dot" />
            <strong>Investigation dispatched</strong>
            <p className="muted">
              Mission {mission.missionId} is durable and can continue after a restart.
            </p>
          </div>
          <button className="button" type="button" onClick={onOpenMissions}>
            Open mission control
          </button>
        </section>
      )}
    </div>
  );
}
