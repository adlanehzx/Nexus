import { useEffect, useMemo, useState } from "react";
import { buildOsintMission, osintInvestigationSchema } from "@nexus/osint/policy";
import type { OsintCaseRecord } from "@nexus/osint";
import type { DashboardApi, OrchestratedMission } from "../lib/api.js";
import { useI18n } from "./i18n/index.js";

const TEMPLATES = [
  [
    "professional_person",
    "Professional footprint",
    "Roles, publications, affiliations and career chronology.",
    "Empreinte professionnelle",
    "Rôles, publications, affiliations et chronologie de carrière.",
  ],
  [
    "organization",
    "Organization intelligence",
    "Ownership, leadership, filings, products and public activity.",
    "Renseignement d'organisation",
    "Actionnariat, dirigeants, dépôts légaux, produits et activité publique.",
  ],
  [
    "technical_asset",
    "Technical exposure",
    "Public domains, certificates, repositories and infrastructure.",
    "Exposition technique",
    "Domaines publics, certificats, dépôts et infrastructure.",
  ],
  [
    "claim_verification",
    "Claim verification",
    "Corroborate a statement and expose contradictions.",
    "Vérification d'allégations",
    "Corroborer une déclaration et exposer les contradictions.",
  ],
] as const;
type Tab = "evidence" | "graph" | "monitoring" | "enrichment" | "reports";
type Enrichment =
  "sherlock" | "dns" | "rdap" | "certificate" | "company_registry" | "virustotal" | "shodan";

export function OsintWorkspace({
  api,
  onOpenMissions,
}: {
  api: DashboardApi;
  onOpenMissions: () => void;
}) {
  const { tr, locale } = useI18n();
  const [cases, setCases] = useState<OsintCaseRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("evidence");
  const [kind, setKind] = useState<(typeof TEMPLATES)[number][0]>("organization");
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [objective, setObjective] = useState("");
  const [lawful, setLawful] = useState(false);
  const [dataset, setDataset] = useState("");
  const [watchUrl, setWatchUrl] = useState("");
  const [enrichment, setEnrichment] = useState<Enrichment>("dns");
  const [enrichmentQuery, setEnrichmentQuery] = useState("");
  const [secretRef, setSecretRef] = useState("");
  const [mission, setMission] = useState<OrchestratedMission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = cases.find((item) => item.id === selectedId) ?? null;
  const active = useMemo(() => TEMPLATES.find((template) => template[0] === kind)!, [kind]);

  const refresh = async (select?: string): Promise<void> => {
    const result = await api.osintCases();
    setCases(result.cases);
    setSelectedId(select ?? selectedId ?? result.cases[0]?.id ?? null);
  };
  useEffect(() => {
    void refresh().catch((cause: unknown) => setError(message(cause)));
  }, []);

  const act = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const launch = (): Promise<void> =>
    act(async () => {
      const request = osintInvestigationSchema.parse({
        title,
        kind,
        target,
        objective,
        maxSources: 12,
        lawfulPurposeConfirmed: lawful,
      });
      const record = await api.createOsintCase(request);
      setMission(
        await api.sendToNexus(
          `${buildOsintMission(request)}\nPersistent NEXUS case ID: ${record.id}. Archive material findings and citations against this case.`,
        ),
      );
      setTitle("");
      setTarget("");
      setObjective("");
      setLawful(false);
      await refresh(record.id);
    });

  return (
    <div className="domain-workspace osint-workspace">
      <section className="domain-hero osint-hero">
        <div>
          <span className="domain-kicker">
            {tr("PUBLIC-SOURCE INTELLIGENCE", "RENSEIGNEMENT DE SOURCES OUVERTES")}
          </span>
          <h2>
            {tr("Evidence, not speculation.", "Des preuves vérifiées, pas des spéculations.")}
          </h2>
          <p>
            {tr(
              "Coordinate analyst, verifier and critic agents; preserve source fingerprints; monitor lawful public pages; export an auditable report.",
              "Coordonnez les agents analystes, vérificateurs et critiques ; conservez les empreintes de sources ; surveillez les pages publiques légales ; exportez un rapport vérifiable.",
            )}
          </p>
        </div>
        <div className="domain-hero-stat">
          <strong>
            {cases.length} {tr("cases", "dossiers")}
          </strong>
          <span>
            {cases.reduce((sum, item) => sum + item.evidence.length, 0)}{" "}
            {tr("archived sources", "sources archivées")}
          </span>
        </div>
      </section>

      <div className="osint-case-shell">
        <aside className="domain-panel osint-case-list">
          <div className="section-heading">
            <div>
              <span className="eyebrow">{tr("CASEBOOK", "REGISTRE")}</span>
              <h3>{tr("Investigations", "Enquêtes")}</h3>
            </div>
          </div>
          <button
            type="button"
            className={`osint-case-row ${selectedId === null ? "active" : ""}`}
            onClick={() => setSelectedId(null)}
          >
            <strong>{tr("＋ New investigation", "＋ Nouvelle enquête")}</strong>
            <span>
              {tr("Define scope and launch agents", "Définir le périmètre et lancer les agents")}
            </span>
          </button>
          {cases.map((item) => (
            <button
              type="button"
              className={`osint-case-row ${item.id === selectedId ? "active" : ""}`}
              key={item.id}
              onClick={() => setSelectedId(item.id)}
            >
              <strong>{item.investigation.title}</strong>
              <span>
                {item.status} · {item.evidence.length} {tr("sources", "sources")}
              </span>
            </button>
          ))}
        </aside>

        <main className="domain-panel osint-case-main">
          {selected === null ? (
            <NewCaseForm
              kind={kind}
              setKind={setKind}
              title={title}
              setTitle={setTitle}
              target={target}
              setTarget={setTarget}
              objective={objective}
              setObjective={setObjective}
              lawful={lawful}
              setLawful={setLawful}
              busy={busy}
              hint={locale === "fr" ? active[4] : active[2]}
              launch={launch}
            />
          ) : (
            <>
              <div className="section-heading">
                <div>
                  <span className="eyebrow">
                    {selected.investigation.kind.replaceAll("_", " ")}
                  </span>
                  <h3>{selected.investigation.title}</h3>
                  <p className="muted">{selected.investigation.objective}</p>
                </div>
                <span className="status-badge">{selected.status}</span>
              </div>
              <nav className="osint-tabs" aria-label="Investigation views">
                {(["evidence", "graph", "monitoring", "enrichment", "reports"] as Tab[]).map(
                  (item) => {
                    const label =
                      item === "evidence"
                        ? tr("Evidence", "Preuves")
                        : item === "graph"
                          ? tr("Graph", "Graphe")
                          : item === "monitoring"
                            ? tr("Monitoring", "Surveillance")
                            : item === "enrichment"
                              ? tr("Tools & Enrichment", "Outils & Enrichissement")
                              : tr("Reports", "Rapports");
                    return (
                      <button
                        type="button"
                        className={tab === item ? "active" : ""}
                        key={item}
                        onClick={() => setTab(item)}
                      >
                        {label}
                      </button>
                    );
                  },
                )}
              </nav>
              {tab === "evidence" && (
                <EvidencePanel
                  record={selected}
                  dataset={dataset}
                  setDataset={setDataset}
                  busy={busy}
                  importDataset={() =>
                    act(async () => {
                      await api.importOsintEvidence(selected.id, dataset);
                      setDataset("");
                      await refresh(selected.id);
                    })
                  }
                />
              )}
              {tab === "graph" && (
                <GraphPanel
                  record={selected}
                  addEntity={(label, type) =>
                    act(async () => {
                      await api.addOsintEntity(selected.id, { label, type, confidence: 0.7 });
                      await refresh(selected.id);
                    })
                  }
                  addRelation={(sourceId, targetId, label) =>
                    act(async () => {
                      await api.addOsintRelation(selected.id, {
                        sourceId,
                        targetId,
                        label,
                        confidence: 0.7,
                        evidenceIds: [],
                      });
                      await refresh(selected.id);
                    })
                  }
                />
              )}
              {tab === "monitoring" && (
                <MonitoringPanel
                  record={selected}
                  watchUrl={watchUrl}
                  setWatchUrl={setWatchUrl}
                  busy={busy}
                  addWatch={() =>
                    act(async () => {
                      await api.addOsintWatch(selected.id, watchUrl, 60);
                      setWatchUrl("");
                      await refresh(selected.id);
                    })
                  }
                  acknowledge={(alertId) =>
                    act(async () => {
                      await api.acknowledgeOsintAlert(selected.id, alertId);
                      await refresh(selected.id);
                    })
                  }
                />
              )}
              {tab === "enrichment" && (
                <EnrichmentPanel
                  enrichment={enrichment}
                  setEnrichment={setEnrichment}
                  query={enrichmentQuery}
                  setQuery={setEnrichmentQuery}
                  secretRef={secretRef}
                  setSecretRef={setSecretRef}
                  busy={busy}
                  run={() =>
                    act(async () => {
                      await api.enrichOsintCase(selected.id, {
                        provider: enrichment,
                        query: enrichmentQuery,
                        ...(enrichment === "virustotal" || enrichment === "shodan"
                          ? { secretRef }
                          : {}),
                      });
                      setEnrichmentQuery("");
                      await refresh(selected.id);
                    })
                  }
                />
              )}
              {tab === "reports" && <ReportsPanel api={api} record={selected} act={act} />}
            </>
          )}
        </main>
      </div>

      {selected !== null && (
        <section className="domain-panel evidence-contract">
          <div>
            <span className="eyebrow">
              {tr("COLLABORATION CONTRACT", "CONTRAT DE COLLABORATION")}
            </span>
            <h3>
              {tr(
                "Three roles, one evidence standard",
                "Trois rôles, un standard de preuve unique",
              )}
            </h3>
          </div>
          <div className="evidence-grid">
            <span>{tr("Analyst · collect", "Analyste · collecte")}</span>
            <span>{tr("Verifier · corroborate", "Vérificateur · corrobore")}</span>
            <span>{tr("Critic · challenge", "Critique · conteste")}</span>
            <span>{tr("Source hashes", "Empreintes de sources")}</span>
            <span>{tr("Confidence levels", "Niveaux de confiance")}</span>
            <span>{tr("Recorded disagreements", "Désaccords consignés")}</span>
          </div>
        </section>
      )}
      {mission !== null && (
        <section className="domain-panel mission-launched">
          <div>
            <span className="status-dot" />
            <strong>{tr("Investigation dispatched", "Enquête déployée")}</strong>
            <p className="muted">
              {tr(
                `Mission ${mission.missionId} is durable and can continue after a restart.`,
                `La mission ${mission.missionId} est persistante et peut continuer après redémarrage.`,
              )}
            </p>
          </div>
          <button className="button" type="button" onClick={onOpenMissions}>
            {tr("Open mission control", "Ouvrir le contrôle de mission")}
          </button>
        </section>
      )}
      {error === null ? null : <p className="banner error">{error}</p>}
    </div>
  );
}

function NewCaseForm(props: {
  kind: (typeof TEMPLATES)[number][0];
  setKind: (value: (typeof TEMPLATES)[number][0]) => void;
  title: string;
  setTitle: (value: string) => void;
  target: string;
  setTarget: (value: string) => void;
  objective: string;
  setObjective: (value: string) => void;
  lawful: boolean;
  setLawful: (value: boolean) => void;
  busy: boolean;
  hint: string;
  launch: () => Promise<void>;
}) {
  const { tr, locale } = useI18n();
  return (
    <>
      <div className="section-heading">
        <div>
          <span className="eyebrow">{tr("NEW CASE", "NOUVEAU DOSSIER")}</span>
          <h3>{tr("Define a lawful investigation", "Définir une enquête légitime")}</h3>
        </div>
      </div>
      <div className="template-grid">
        {TEMPLATES.map(([id, labelEn, detailEn, labelFr, detailFr]) => (
          <button
            key={id}
            type="button"
            className={`template-card ${props.kind === id ? "active" : ""}`}
            onClick={() => props.setKind(id)}
          >
            <span className="template-marker" />
            <strong>{locale === "fr" ? labelFr : labelEn}</strong>
            <small>{locale === "fr" ? detailFr : detailEn}</small>
          </button>
        ))}
      </div>
      <div className="banner info" role="note">
        <strong>
          {tr(
            "Investigation tools unlock after the case is created.",
            "Les outils d'investigation se débloquent après création du dossier.",
          )}
        </strong>{" "}
        {tr(
          "Select the case, then open Tools & enrichment to run Sherlock, DNS, RDAP, TLS, company registry, VirusTotal, or Shodan checks and archive their results.",
          "Sélectionnez le dossier, puis ouvrez Outils & enrichissement pour lancer Sherlock, DNS, RDAP, TLS, registres d'entreprises, VirusTotal ou Shodan et archiver leurs résultats.",
        )}
      </div>
      <div className="settings-grid osint-form">
        <label>
          {tr("Case title", "Titre du dossier")}
          <input
            className="field"
            value={props.title}
            onChange={(event) => props.setTitle(event.target.value)}
          />
        </label>
        <label>
          {tr("Public target", "Cible publique")}
          <input
            className="field"
            value={props.target}
            onChange={(event) => props.setTarget(event.target.value)}
          />
        </label>
        <label className="settings-wide">
          {tr("Decision or question", "Décision ou question clé")}
          <textarea
            className="field"
            rows={4}
            value={props.objective}
            onChange={(event) => props.setObjective(event.target.value)}
            placeholder={props.hint}
          />
        </label>
      </div>
      <label className="consent-row">
        <input
          type="checkbox"
          checked={props.lawful}
          onChange={(event) => props.setLawful(event.target.checked)}
        />
        <span>
          {tr(
            "I confirm a legitimate purpose and authorize research limited to lawfully accessible public sources.",
            "Je confirme un objectif légitime et autorise la recherche limitée aux sources publiques légalement accessibles.",
          )}
        </span>
      </label>
      <button
        className="button primary domain-cta"
        type="button"
        disabled={
          props.busy ||
          !props.lawful ||
          props.title.trim().length < 3 ||
          props.target.trim().length < 2 ||
          props.objective.trim().length < 10
        }
        onClick={() => void props.launch()}
      >
        {props.busy
          ? tr("Building investigation…", "Création de l'enquête…")
          : tr("Create case and launch agents", "Créer le dossier et lancer les agents")}
      </button>
    </>
  );
}

function EvidencePanel({
  record,
  dataset,
  setDataset,
  busy,
  importDataset,
}: {
  record: OsintCaseRecord;
  dataset: string;
  setDataset: (value: string) => void;
  busy: boolean;
  importDataset: () => Promise<void>;
}) {
  const { tr } = useI18n();
  return (
    <div className="osint-panel-stack">
      <div className="osint-metrics">
        <Metric label={tr("Evidence", "Preuves")} value={record.evidence.length} />
        <Metric label={tr("Entities", "Entités")} value={record.entities.length} />
        <Metric
          label={tr("Alerts", "Alertes")}
          value={record.alerts.filter((item) => !item.acknowledged).length}
        />
      </div>
      <div className="osint-evidence-list">
        {record.evidence.length === 0 ? (
          <p className="muted">
            {tr(
              "Import CSV/JSON or run an enrichment to archive the first evidence.",
              "Importez un fichier CSV/JSON ou lancez un enrichissement pour archiver la première preuve.",
            )}
          </p>
        ) : (
          record.evidence.map((item) => (
            <article key={item.id}>
              <div>
                <strong>{item.title}</strong>
                <p>{item.excerpt}</p>
                <a href={item.url} target="_blank" rel="noreferrer">
                  {tr("Open source", "Source d'origine")}
                </a>
                {item.contentSnapshot.length > 0 && (
                  <details>
                    <summary>{tr("Archived snapshot", "Instantané archivé")}</summary>
                    <pre>{item.contentSnapshot.slice(0, 20_000)}</pre>
                  </details>
                )}
              </div>
              <span>
                {item.reliability}
                <small>{item.contentHash.slice(0, 12)}…</small>
              </span>
            </article>
          ))
        )}
      </div>
      <label>
        {tr("Import CSV or JSON", "Importer CSV ou JSON")}
        <textarea
          className="field"
          rows={5}
          value={dataset}
          onChange={(event) => setDataset(event.target.value)}
          placeholder={"url,title,excerpt\nhttps://…"}
        />
      </label>
      <button
        className="button"
        disabled={busy || dataset.trim().length < 2}
        type="button"
        onClick={() => void importDataset()}
      >
        {tr("Import and fingerprint", "Importer et calculer l'empreinte")}
      </button>
    </div>
  );
}

function MonitoringPanel({
  record,
  watchUrl,
  setWatchUrl,
  busy,
  addWatch,
  acknowledge,
}: {
  record: OsintCaseRecord;
  watchUrl: string;
  setWatchUrl: (value: string) => void;
  busy: boolean;
  addWatch: () => Promise<void>;
  acknowledge: (id: string) => Promise<void>;
}) {
  const { tr } = useI18n();
  return (
    <div className="osint-panel-stack">
      <p className="muted">
        {tr(
          "HTTPS pages are checked automatically when due. Redirects and private network targets are refused.",
          "Les pages HTTPS sont vérifiées automatiquement à échéance. Les redirections et cibles réseau privées sont refusées.",
        )}
      </p>
      <div className="inline-fields">
        <input
          className="field"
          value={watchUrl}
          onChange={(event) => setWatchUrl(event.target.value)}
          placeholder="https://public.example/page"
        />
        <button
          className="button"
          disabled={busy || !watchUrl.startsWith("https://")}
          type="button"
          onClick={() => void addWatch()}
        >
          {tr("Watch hourly", "Surveiller chaque heure")}
        </button>
      </div>
      {record.watches.map((watch) => (
        <div className="osint-watch" key={watch.id}>
          <div>
            <strong>{watch.query}</strong>
            <small>
              {tr(`Every ${watch.intervalMinutes} min`, `Toutes les ${watch.intervalMinutes} min`)}{" "}
              · {tr("last checked", "dernière vérification")}{" "}
              {watch.lastCheckedAt
                ? new Date(watch.lastCheckedAt).toLocaleString()
                : tr("pending", "en attente")}
            </small>
          </div>
          <span className="status-badge">
            {watch.enabled ? tr("active", "actif") : tr("paused", "en pause")}
          </span>
        </div>
      ))}
      <h4>{tr("Alerts", "Alertes")}</h4>
      {record.alerts.length === 0 ? (
        <p className="muted">
          {tr("No content change detected.", "Aucun changement de contenu détecté.")}
        </p>
      ) : (
        record.alerts.map((alert) => (
          <div className={`osint-alert ${alert.acknowledged ? "acknowledged" : ""}`} key={alert.id}>
            <div>
              <strong>{alert.title}</strong>
              <p>{alert.detail}</p>
            </div>
            {!alert.acknowledged && (
              <button className="button" type="button" onClick={() => void acknowledge(alert.id)}>
                {tr("Acknowledge", "Acquitter")}
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function EnrichmentPanel({
  enrichment,
  setEnrichment,
  query,
  setQuery,
  secretRef,
  setSecretRef,
  busy,
  run,
}: {
  enrichment: Enrichment;
  setEnrichment: (value: Enrichment) => void;
  query: string;
  setQuery: (value: string) => void;
  secretRef: string;
  setSecretRef: (value: string) => void;
  busy: boolean;
  run: () => Promise<void>;
}) {
  const { tr } = useI18n();
  const paid = enrichment === "virustotal" || enrichment === "shodan";
  return (
    <div className="osint-panel-stack">
      <p className="muted">
        {tr(
          "Sherlock username discovery, DNS, RDAP, TLS certificates and official registries work without a paid key. VirusTotal and Shodan use a vault reference; secrets never reach agent prompts or browser responses.",
          "La recherche de pseudo Sherlock, DNS, RDAP, certificats TLS et registres officiels fonctionnent sans clé payante. VirusTotal et Shodan utilisent une référence de coffre ; les secrets ne transitent jamais dans les invites d'agents ni dans les réponses du navigateur.",
        )}
      </p>
      <div className="settings-grid">
        <label>
          {tr("Provider", "Fournisseur")}
          <select
            className="field"
            value={enrichment}
            onChange={(event) => setEnrichment(event.target.value as Enrichment)}
          >
            <option value="sherlock">
              {tr("Sherlock username search", "Recherche de pseudo Sherlock")}
            </option>
            <option value="dns">DNS</option>
            <option value="rdap">RDAP / WHOIS</option>
            <option value="certificate">{tr("TLS certificate", "Certificat TLS")}</option>
            <option value="company_registry">
              {tr("Company registries", "Registres d'entreprises")}
            </option>
            <option value="virustotal">VirusTotal</option>
            <option value="shodan">Shodan</option>
          </select>
        </label>
        <label>
          {enrichment === "sherlock"
            ? tr("Public username", "Nom d'utilisateur public")
            : tr("Domain, IP or company", "Domaine, IP ou entreprise")}
          <input
            className="field"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {paid && (
          <label className="settings-wide">
            {tr("Vault reference", "Référence de coffre (vault)")}
            <input
              className="field"
              value={secretRef}
              onChange={(event) => setSecretRef(event.target.value)}
              placeholder="vault://nexus/osint-provider"
            />
          </label>
        )}
      </div>
      <button
        className="button primary"
        type="button"
        disabled={
          busy || query.trim().length < 2 || (paid && !secretRef.startsWith("vault://nexus/"))
        }
        onClick={() => void run()}
      >
        {tr("Run and archive", "Exécuter et archiver")}
      </button>
    </div>
  );
}

function ReportsPanel({
  api,
  record,
  act,
}: {
  api: DashboardApi;
  record: OsintCaseRecord;
  act: (operation: () => Promise<void>) => Promise<void>;
}) {
  const { tr } = useI18n();
  const download = (format: "markdown" | "pdf") =>
    void act(async () => {
      const result = await api.osintReport(record.id, format);
      const bytes =
        format === "pdf"
          ? Uint8Array.from(atob(result.content), (character) => character.charCodeAt(0))
          : result.content;
      const blob = new Blob([bytes], {
        type: format === "pdf" ? "application/pdf" : "text/markdown",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${record.investigation.title.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}.${format === "pdf" ? "pdf" : "md"}`;
      anchor.click();
      URL.revokeObjectURL(url);
    });
  return (
    <div className="osint-panel-stack">
      <p>
        {tr(
          "Reports include the case objective, entities, source links, reliability labels and SHA-256 evidence fingerprints.",
          "Les rapports incluent l'objectif du dossier, les entités, les liens sources, les niveaux de fiabilité et les empreintes SHA-256 des preuves.",
        )}
      </p>
      <div className="settings-actions">
        <button className="button primary" type="button" onClick={() => download("pdf")}>
          {tr("Download PDF", "Télécharger le PDF")}
        </button>
        <button className="button" type="button" onClick={() => download("markdown")}>
          {tr("Download Markdown", "Télécharger en Markdown")}
        </button>
      </div>
    </div>
  );
}

function GraphPanel({
  record,
  addEntity,
  addRelation,
}: {
  record: OsintCaseRecord;
  addEntity: (label: string, type: string) => Promise<void>;
  addRelation: (sourceId: string, targetId: string, label: string) => Promise<void>;
}) {
  const { tr } = useI18n();
  const [focus, setFocus] = useState<string | null>(null);
  const [entityLabel, setEntityLabel] = useState("");
  const [entityType, setEntityType] = useState("organization");
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [relationLabel, setRelationLabel] = useState("");
  const count = Math.max(record.entities.length, 1);
  const position = (index: number) => ({
    x: 300 + Math.cos((index / count) * Math.PI * 2) * 210,
    y: 180 + Math.sin((index / count) * Math.PI * 2) * 125,
  });
  const positions = new Map(record.entities.map((entity, index) => [entity.id, position(index)]));
  return (
    <div className="osint-panel-stack">
      <p className="muted">
        {focus ??
          `${record.relations.length} ${tr("verified relationships", "relations vérifiées")}`}
      </p>
      <svg
        className="osint-graph"
        viewBox="0 0 600 360"
        role="img"
        aria-label={tr(
          "Interactive entity relationship graph",
          "Graphe interactif des relations entre entités",
        )}
      >
        {record.relations.map((relation) => {
          const from = positions.get(relation.sourceId);
          const to = positions.get(relation.targetId);
          return from && to ? (
            <g key={relation.id}>
              <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
              <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2}>
                {relation.label}
              </text>
            </g>
          ) : null;
        })}
        {record.entities.map((entity, index) => {
          const point = position(index);
          return (
            <g
              className={focus === entity.label ? "focused" : ""}
              key={entity.id}
              onClick={() => setFocus(entity.label)}
              role="button"
            >
              <circle cx={point.x} cy={point.y} r="34" />
              <text x={point.x} y={point.y}>
                {entity.label.slice(0, 16)}
              </text>
              <title>
                {entity.label} · {Math.round(entity.confidence * 100)}%{" "}
                {tr("confidence", "confiance")}
              </title>
            </g>
          );
        })}
      </svg>
      {record.entities.length === 0 && (
        <p className="muted">
          {tr(
            "Add the first entity or wait for the investigation results.",
            "Ajoutez la première entité ou attendez les résultats de l'enquête.",
          )}
        </p>
      )}
      <div className="settings-grid">
        <label>
          {tr("Entity label", "Libellé de l'entité")}
          <input
            className="field"
            value={entityLabel}
            onChange={(event) => setEntityLabel(event.target.value)}
          />
        </label>
        <label>
          {tr("Entity type", "Type d'entité")}
          <select
            className="field"
            value={entityType}
            onChange={(event) => setEntityType(event.target.value)}
          >
            <option value="organization">{tr("Organization", "Organisation")}</option>
            <option value="person">{tr("Person", "Personne")}</option>
            <option value="domain">{tr("Domain", "Domaine")}</option>
            <option value="asset">{tr("Asset", "Ressource / Actif")}</option>
            <option value="claim">{tr("Claim", "Allégation / Fait")}</option>
          </select>
        </label>
      </div>
      <button
        className="button"
        type="button"
        disabled={entityLabel.trim().length < 1}
        onClick={() => void addEntity(entityLabel, entityType).then(() => setEntityLabel(""))}
      >
        {tr("Add entity", "Ajouter l'entité")}
      </button>
      {record.entities.length >= 2 && (
        <>
          <div className="settings-grid">
            <label>
              {tr("From", "De")}
              <select
                className="field"
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
              >
                <option value="">{tr("Select entity", "Sélectionner une entité")}</option>
                {record.entities.map((entity) => (
                  <option key={entity.id} value={entity.id}>
                    {entity.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tr("To", "Vers")}
              <select
                className="field"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
              >
                <option value="">{tr("Select entity", "Sélectionner une entité")}</option>
                {record.entities.map((entity) => (
                  <option key={entity.id} value={entity.id}>
                    {entity.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-wide">
              {tr("Relationship", "Relation")}
              <input
                className="field"
                value={relationLabel}
                onChange={(event) => setRelationLabel(event.target.value)}
                placeholder={tr("owns, directs, resolves to…", "détient, dirige, résout vers…")}
              />
            </label>
          </div>
          <button
            className="button"
            type="button"
            disabled={
              !sourceId || !targetId || sourceId === targetId || relationLabel.trim().length < 1
            }
            onClick={() =>
              void addRelation(sourceId, targetId, relationLabel).then(() => {
                setRelationLabel("");
                setSourceId("");
                setTargetId("");
              })
            }
          >
            {tr("Add relationship", "Ajouter la relation")}
          </button>
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "OSINT operation failed.";
}
