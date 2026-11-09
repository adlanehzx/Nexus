import { useEffect, useMemo, useState } from "react";
import { buildOsintMission, osintInvestigationSchema } from "@nexus/osint/policy";
import type { OsintCaseRecord, OsintEntity } from "@nexus/osint";
import type { DashboardApi, OrchestratedMission } from "../lib/api.js";
import { useI18n } from "./i18n/index.js";
import {
  IconCheck,
  IconClose,
  IconExternalLink,
  IconPlus,
  IconSearch,
  IconTrash,
} from "./icons.js";

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
type Tab = "search" | "evidence" | "graph" | "monitoring" | "enrichment" | "reports";
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
            <strong style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <IconPlus size={14} />
              {tr("New investigation", "Nouvelle enquête")}
            </strong>
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
                {(
                  ["search", "evidence", "graph", "monitoring", "enrichment", "reports"] as Tab[]
                ).map((item) => {
                  const label =
                    item === "search"
                      ? tr("SearXNG Search", "Recherche SearXNG")
                      : item === "evidence"
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
                })}
              </nav>
              {tab === "search" && (
                <SearchPanel
                  caseId={selected.id}
                  api={api}
                  act={act}
                  busy={busy}
                  onEvidenceAdded={() => refresh(selected.id)}
                />
              )}
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
                  deleteEntity={(entityId) =>
                    act(async () => {
                      await api.deleteOsintEntity(selected.id, entityId);
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
                  deleteRelation={(relationId) =>
                    act(async () => {
                      await api.deleteOsintRelation(selected.id, relationId);
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

function SearchPanel({
  caseId,
  api,
  act,
  busy,
  onEvidenceAdded,
}: {
  caseId: string;
  api: DashboardApi;
  act: (operation: () => Promise<void>) => Promise<void>;
  busy: boolean;
  onEvidenceAdded: () => Promise<void>;
}) {
  const { tr } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    Array<{
      title: string;
      url: string;
      snippet: string;
      engines: string[];
      publishedAt?: string | null;
      score?: number | null;
    }>
  >([]);
  const [searched, setSearched] = useState(false);
  const [archivedUrls, setArchivedUrls] = useState<Set<string>>(new Set());
  const [searchError, setSearchError] = useState<string | null>(null);

  const handleSearch = () =>
    act(async () => {
      setSearchError(null);
      try {
        const response = await api.searchOsint(caseId, query.trim(), 15);
        setResults(response.results);
        setSearched(true);
      } catch (err) {
        setSearchError(message(err));
      }
    });

  const handleAddEvidence = (item: { title: string; url: string; snippet: string }) =>
    act(async () => {
      await api.addOsintEvidence(caseId, {
        url: item.url,
        title: item.title,
        excerpt: item.snippet,
        reliability: "corroborated",
        content: item.snippet,
      });
      setArchivedUrls((prev) => new Set(prev).add(item.url));
      await onEvidenceAdded();
    });

  return (
    <div className="osint-panel-stack">
      <p className="muted">
        {tr(
          "Multi-engine search directly through SearXNG (port 18080). Archive any result as case evidence with 1 click.",
          "Recherche multi-moteurs directe via SearXNG (port 18080). Archivez n'importe quel résultat comme preuve du dossier en 1 clic.",
        )}
      </p>
      <div className="osint-search-box">
        <input
          className="field"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && query.trim().length > 1 && !busy) {
              void handleSearch();
            }
          }}
          placeholder={tr(
            "Search public web, registries, domains, people...",
            "Rechercher sur le web public, registres, domaines, personnes...",
          )}
        />
        <button
          className="button primary"
          type="button"
          disabled={busy || query.trim().length < 2}
          onClick={() => void handleSearch()}
          style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
        >
          <IconSearch size={14} />
          {tr("Search", "Rechercher")}
        </button>
      </div>

      {searchError && (
        <div className="banner warning" role="alert">
          {searchError}
        </div>
      )}

      {searched && (
        <div className="osint-search-results">
          <div className="osint-metrics">
            <Metric label={tr("Results found", "Résultats trouvés")} value={results.length} />
            <Metric
              label={tr("Archived into case", "Archivés dans le dossier")}
              value={archivedUrls.size}
            />
          </div>

          {results.length === 0 ? (
            <p className="muted">
              {tr(
                "No public sources returned for this query.",
                "Aucune source publique trouvée pour cette requête.",
              )}
            </p>
          ) : (
            results.map((item, index) => {
              const isArchived = archivedUrls.has(item.url);
              return (
                <article className="osint-search-card" key={`${item.url}-${index}`}>
                  <div className="osint-search-card-header">
                    <div>
                      <strong>
                        <a href={item.url} target="_blank" rel="noreferrer">
                          {item.title}
                          <IconExternalLink size={12} style={{ marginLeft: "4px" }} />
                        </a>
                      </strong>
                      <div className="osint-search-url">{item.url}</div>
                    </div>
                    <button
                      className={isArchived ? "button" : "button primary"}
                      type="button"
                      disabled={busy || isArchived}
                      onClick={() => void handleAddEvidence(item)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        flexShrink: 0,
                      }}
                    >
                      {isArchived ? (
                        <>
                          <IconCheck size={14} />
                          {tr("Archived", "Archivée")}
                        </>
                      ) : (
                        <>
                          <IconPlus size={14} />
                          {tr("Add as evidence", "Ajouter comme preuve")}
                        </>
                      )}
                    </button>
                  </div>
                  {item.snippet && <p className="osint-search-snippet">{item.snippet}</p>}
                  <div className="osint-search-meta">
                    <div className="osint-engines-badge">
                      {item.engines.map((engine) => (
                        <span className="osint-engine-tag" key={engine}>
                          {engine}
                        </span>
                      ))}
                    </div>
                    {item.publishedAt && (
                      <small className="muted">
                        {new Date(item.publishedAt).toLocaleDateString()}
                      </small>
                    )}
                  </div>
                </article>
              );
            })
          )}
        </div>
      )}
    </div>
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

function EntityInspector({
  entity,
  allEntities,
  record,
  onClose,
  onDeleteEntity,
  onDeleteRelation,
}: {
  entity: OsintEntity;
  allEntities: OsintEntity[];
  record: OsintCaseRecord;
  onClose: () => void;
  onDeleteEntity: (id: string) => Promise<void>;
  onDeleteRelation: (id: string) => Promise<void>;
}) {
  const { tr } = useI18n();
  const entityMap = useMemo(() => new Map(allEntities.map((e) => [e.id, e.label])), [allEntities]);

  const incomingRelations = record.relations.filter((r) => r.targetId === entity.id);
  const outgoingRelations = record.relations.filter((r) => r.sourceId === entity.id);

  const connectedRelationEvidenceIds = new Set(
    record.relations
      .filter((r) => r.sourceId === entity.id || r.targetId === entity.id)
      .flatMap((r) => r.evidenceIds),
  );
  const associatedEvidence = record.evidence.filter(
    (ev) =>
      connectedRelationEvidenceIds.has(ev.id) ||
      ev.title.toLowerCase().includes(entity.label.toLowerCase()) ||
      ev.excerpt.toLowerCase().includes(entity.label.toLowerCase()),
  );

  return (
    <aside className="osint-inspector" aria-label={tr("Entity inspector", "Inspecteur d'entité")}>
      <div className="osint-inspector-header">
        <div>
          <span className="eyebrow">{entity.type.toUpperCase()}</span>
          <h4>{entity.label}</h4>
        </div>
        <button
          type="button"
          className="button icon-only"
          onClick={onClose}
          aria-label={tr("Close inspector", "Fermer l'inspecteur")}
        >
          <IconClose size={14} />
        </button>
      </div>

      <div className="osint-inspector-section">
        <h5>{tr("Confidence Score", "Indice de confiance")}</h5>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>{Math.round(entity.confidence * 100)}%</span>
          <small className="muted">
            {entity.confidence >= 0.8
              ? tr("High confidence", "Confiance élevée")
              : tr("Standard confidence", "Confiance standard")}
          </small>
        </div>
        <div className="osint-confidence-bar">
          <div
            className="osint-confidence-fill"
            style={{ width: `${Math.round(entity.confidence * 100)}%` }}
          />
        </div>
      </div>

      <div className="osint-inspector-section">
        <h5>
          {tr("Incoming Relations", "Relations entrantes")} ({incomingRelations.length})
        </h5>
        {incomingRelations.length === 0 ? (
          <small className="muted">{tr("No incoming links", "Aucun lien entrant")}</small>
        ) : (
          incomingRelations.map((rel) => (
            <div className="osint-rel-item" key={rel.id}>
              <span>
                <strong>{entityMap.get(rel.sourceId) ?? rel.sourceId}</strong>
                {" → "}
                <em>{rel.label}</em>
              </span>
              <button
                type="button"
                className="button icon-only"
                onClick={() => void onDeleteRelation(rel.id)}
                title={tr("Delete relation", "Supprimer la relation")}
              >
                <IconTrash size={12} />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="osint-inspector-section">
        <h5>
          {tr("Outgoing Relations", "Relations sortantes")} ({outgoingRelations.length})
        </h5>
        {outgoingRelations.length === 0 ? (
          <small className="muted">{tr("No outgoing links", "Aucun lien sortant")}</small>
        ) : (
          outgoingRelations.map((rel) => (
            <div className="osint-rel-item" key={rel.id}>
              <span>
                <em>{rel.label}</em>
                {" → "}
                <strong>{entityMap.get(rel.targetId) ?? rel.targetId}</strong>
              </span>
              <button
                type="button"
                className="button icon-only"
                onClick={() => void onDeleteRelation(rel.id)}
                title={tr("Delete relation", "Supprimer la relation")}
              >
                <IconTrash size={12} />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="osint-inspector-section">
        <h5>
          {tr("Associated Evidence", "Preuves associées")} ({associatedEvidence.length})
        </h5>
        {associatedEvidence.length === 0 ? (
          <small className="muted">
            {tr("No direct evidence linked", "Aucune preuve directe liée")}
          </small>
        ) : (
          associatedEvidence.slice(0, 4).map((ev) => (
            <div className="osint-evidence-mini" key={ev.id}>
              <strong>{ev.title}</strong>
              <small className="muted">{ev.excerpt.slice(0, 90)}…</small>
              <a
                href={ev.url}
                target="_blank"
                rel="noreferrer"
                style={{
                  fontSize: "11px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "3px",
                }}
              >
                {tr("View source", "Voir la source")}
                <IconExternalLink size={10} />
              </a>
            </div>
          ))
        )}
      </div>

      <div style={{ marginTop: "auto", paddingTop: "12px", borderTop: "1px solid var(--nx-line)" }}>
        <button
          className="button danger"
          type="button"
          onClick={() => void onDeleteEntity(entity.id)}
          style={{
            width: "100%",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "6px",
          }}
        >
          <IconTrash size={14} />
          {tr("Delete entity", "Supprimer l'entité")}
        </button>
      </div>
    </aside>
  );
}

function GraphPanel({
  record,
  addEntity,
  deleteEntity,
  addRelation,
  deleteRelation,
}: {
  record: OsintCaseRecord;
  addEntity: (label: string, type: string) => Promise<void>;
  deleteEntity: (entityId: string) => Promise<void>;
  addRelation: (sourceId: string, targetId: string, label: string) => Promise<void>;
  deleteRelation: (relationId: string) => Promise<void>;
}) {
  const { tr } = useI18n();
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
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
  const selectedEntity = record.entities.find((e) => e.id === selectedEntityId) ?? null;

  return (
    <div className="osint-panel-stack">
      <p className="muted">
        {selectedEntity
          ? `${selectedEntity.label} · ${selectedEntity.type}`
          : `${record.relations.length} ${tr("verified relationships", "relations vérifiées")}`}
      </p>

      <div className={`osint-graph-shell ${selectedEntity ? "has-inspector" : ""}`}>
        <svg
          className="osint-graph"
          viewBox="0 0 600 360"
          role="img"
          aria-label={tr(
            "Interactive entity relationship graph",
            "Graphe interactif des relations entre entités",
          )}
        >
          <defs>
            <marker
              id="osint-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="var(--nx-accent, #6366f1)" />
            </marker>
            <marker
              id="osint-arrow-focused"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="var(--nx-signal, #38bdf8)" />
            </marker>
          </defs>
          {record.relations.map((relation) => {
            const from = positions.get(relation.sourceId);
            const to = positions.get(relation.targetId);
            if (!from || !to) return null;
            const isRelFocused =
              selectedEntityId === relation.sourceId || selectedEntityId === relation.targetId;
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const dist = Math.hypot(dx, dy);
            const r = 38;
            const targetX = dist > 0 ? to.x - (dx / dist) * r : to.x;
            const targetY = dist > 0 ? to.y - (dy / dist) * r : to.y;
            const startX = dist > 0 ? from.x + (dx / dist) * r : from.x;
            const startY = dist > 0 ? from.y + (dy / dist) * r : from.y;
            const midX = (from.x + to.x) / 2;
            const midY = (from.y + to.y) / 2;
            const badgeWidth = Math.max(relation.label.length * 7.5 + 16, 44);

            return (
              <g key={relation.id}>
                <line
                  x1={startX}
                  y1={startY}
                  x2={targetX}
                  y2={targetY}
                  className={isRelFocused ? "focused" : ""}
                  markerEnd={isRelFocused ? "url(#osint-arrow-focused)" : "url(#osint-arrow)"}
                />
                <g className="relation-group">
                  <rect
                    x={midX - badgeWidth / 2}
                    y={midY - 11}
                    width={badgeWidth}
                    height={22}
                    rx={4}
                    className={`relation-badge ${isRelFocused ? "focused" : ""}`}
                  />
                  <text x={midX} y={midY} className="relation-text">
                    {relation.label}
                  </text>
                </g>
              </g>
            );
          })}
          {record.entities.map((entity, index) => {
            const point = position(index);
            const isFocused = selectedEntityId === entity.id;
            return (
              <g
                className={isFocused ? "focused" : ""}
                key={entity.id}
                onClick={() => setSelectedEntityId(isFocused ? null : entity.id)}
                role="button"
                tabIndex={0}
                style={{ cursor: "pointer" }}
              >
                <circle cx={point.x} cy={point.y} r="34" />
                <text className="entity-label" x={point.x} y={point.y - 4}>
                  {entity.label.slice(0, 14)}
                </text>
                <text className="entity-type" x={point.x} y={point.y + 11}>
                  {entity.type.slice(0, 10)}
                </text>
                <title>
                  {entity.label} ({entity.type}) · {Math.round(entity.confidence * 100)}%{" "}
                  {tr("confidence", "confiance")}
                </title>
              </g>
            );
          })}
        </svg>

        {selectedEntity && (
          <EntityInspector
            entity={selectedEntity}
            allEntities={record.entities}
            record={record}
            onClose={() => setSelectedEntityId(null)}
            onDeleteEntity={async (id) => {
              await deleteEntity(id);
              setSelectedEntityId(null);
            }}
            onDeleteRelation={deleteRelation}
          />
        )}
      </div>

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
