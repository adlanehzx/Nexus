import { useCallback, useEffect, useState } from "react";
import type { ConnectionCatalogEntry, ConnectionObservation, DashboardApi } from "../lib/api.js";
import { classifyConnection } from "../lib/format.js";
import { useI18n } from "./i18n/index.js";
import { Futuristic3DCard } from "./Futuristic3DCard.js";

export function Connections({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const [connections, setConnections] = useState<ConnectionCatalogEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setConnections((await api.connections()).connections);
    } catch (cause) {
      setError(
        messageOf(
          cause,
          tr("Unable to load connections.", "Impossible de charger les connexions."),
        ),
      );
    }
  }, [api, tr]);

  useEffect(() => {
    void load();
  }, [load]);

  const scan = async (): Promise<void> => {
    setBusy("all");
    setError(null);
    try {
      setConnections((await api.detectConnections()).connections);
    } catch (cause) {
      setError(messageOf(cause, tr("Host scan failed.", "Échec de l'analyse de l'hôte.")));
    } finally {
      setBusy(null);
    }
  };

  const test = async (providerId: string): Promise<void> => {
    setBusy(providerId);
    setError(null);
    try {
      const updated = await api.testConnection(providerId);
      setConnections(
        (current) =>
          current?.map((entry) => (entry.providerId === providerId ? updated : entry)) ?? [updated],
      );
    } catch (cause) {
      setError(
        messageOf(
          cause,
          tr(`Unable to test ${providerId}.`, `Impossible de tester ${providerId}.`),
        ),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="content connections-page">
      <section className="connection-hero">
        <div>
          <span className="connection-kicker">{tr("Local discovery", "Découverte locale")}</span>
          <h2>
            {tr(
              "Connect the tools already installed on this host.",
              "Connectez les outils déjà installés sur cet hôte.",
            )}
          </h2>
          <p>
            {tr(
              "NEXUS runs only declared, read-only diagnostics. Credentials stay inside each provider's own CLI and never pass through the dashboard.",
              "NEXUS exécute uniquement des diagnostics déclarés en lecture seule. Les identifiants restent dans chaque CLI et ne transitent jamais par le tableau de bord.",
            )}
          </p>
        </div>
        <button
          className="button primary"
          type="button"
          disabled={busy !== null}
          onClick={() => void scan()}
        >
          {busy === "all"
            ? tr("Scanning…", "Analyse en cours…")
            : tr("Scan this host", "Analyser cet hôte")}
        </button>
      </section>

      <div className="connection-scope" role="note">
        <strong>{tr("Scope:", "Périmètre :")}</strong>{" "}
        {tr(
          "discovery runs on the machine hosting the NEXUS API. If the API runs in Docker, the CLI must be available inside that container or exposed through a NEXUS host connector.",
          "la découverte s'exécute sur la machine hébergeant l'API NEXUS. Si l'API s'exécute dans Docker, le CLI doit être disponible dans ce conteneur ou exposé via un connecteur d'hôte NEXUS.",
        )}
      </div>

      {error === null ? null : (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}

      {connections === null ? (
        <div
          className="loading-state"
          role="status"
          aria-label={tr("Loading connections", "Chargement des connexions")}
        >
          <span />
          <span />
          <span />
        </div>
      ) : (
        <div className="connection-grid">
          {connections.map((entry) => (
            <Futuristic3DCard key={entry.providerId} className="cyber-3d-card">
              <ConnectionCard
                entry={entry}
                busy={busy === entry.providerId || busy === "all"}
                onTest={() => void test(entry.providerId)}
              />
            </Futuristic3DCard>
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionCard({
  entry,
  busy,
  onTest,
}: {
  entry: ConnectionCatalogEntry;
  busy: boolean;
  onTest: () => void;
}) {
  const { tr } = useI18n();
  const observation = entry.observation;
  const state = connectionState(entry, tr);

  return (
    <article className="connection-card cyber-card" style={{ height: "100%", margin: 0 }}>
      <div className="connection-card-heading">
        <span className={`connection-logo ${state.tone}`} aria-hidden="true">
          {entry.displayName.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <h3>{entry.displayName}</h3>
          <span className="connection-provider-id">{entry.providerId} · ACP</span>
        </div>
        <span className={`connection-state ${state.tone}`}>{state.label}</span>
      </div>

      <dl className="connection-details">
        <ConnectionDetail
          label={tr("CLI version", "Version CLI")}
          value={observation?.version ?? tr("Not checked", "Non vérifié")}
        />
        <ConnectionDetail
          label={tr("Authentication", "Authentification")}
          value={authLabel(observation, tr)}
        />
        <ConnectionDetail
          label={tr("ACP adapter", "Adaptateur ACP")}
          value={observation?.adapter?.availability ?? tr("unknown", "inconnu")}
        />
        <ConnectionDetail label={tr("Provenance", "Provenance")} value={entry.adapter.provenance} />
      </dl>

      {observation?.executablePath === null || observation?.executablePath === undefined ? null : (
        <code className="connection-path">{observation.executablePath}</code>
      )}

      {observation?.userMessage === null || observation?.userMessage === undefined ? null : (
        <p className="connection-message">{observation.userMessage}</p>
      )}

      <p className="connection-evidence">{entry.adapter.provenanceEvidence}</p>

      <div className="connection-card-footer">
        <span>{checkedLabel(observation, tr)}</span>
        <div className="connection-actions">
          {entry.docsUrl === null ? null : (
            <a className="button compact" href={entry.docsUrl} target="_blank" rel="noreferrer">
              {tr("Documentation", "Documentation")}
            </a>
          )}
          <button
            className="button compact"
            type="button"
            disabled={busy || !entry.supportedOnThisHost}
            onClick={onTest}
          >
            {busy ? tr("Testing…", "Test en cours…") : tr("Test", "Tester")}
          </button>
        </div>
      </div>
    </article>
  );
}

function ConnectionDetail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value.replaceAll("_", " ")}</dd>
    </div>
  );
}

function connectionState(
  entry: ConnectionCatalogEntry,
  tr: (en: string, fr: string) => string,
): { label: string; tone: string } {
  const classified = classifyConnection(entry);
  const labels: Record<string, string> = {
    "Unsupported host": tr("Unsupported host", "Hôte non supporté"),
    "Not installed": tr("Not installed", "Non installé"),
    Detected: tr("Detected", "Détecté"),
    "Missing adapter": tr("Missing adapter", "Adaptateur manquant"),
    "Connection required": tr("Connection required", "Connexion requise"),
    Connected: tr("Connected", "Connecté"),
    Degraded: tr("Degraded", "Dégradé"),
    Failed: tr("Failed", "Échec"),
  };
  return { label: labels[classified.label] ?? classified.label, tone: classified.tone };
}

function authLabel(
  observation: ConnectionObservation | null,
  tr: (en: string, fr: string) => string,
): string {
  if (observation === null) return tr("Not checked", "Non vérifié");
  const map: Record<string, string> = {
    authenticated: tr("Authenticated", "Authentifié"),
    missing: tr("Missing", "Manquant"),
    expired: tr("Expired", "Expiré"),
    unsupported: tr("Unsupported", "Non supporté"),
    not_checked: tr("Not checked", "Non vérifié"),
  };
  return map[observation.authStatus.toLowerCase()] ?? observation.authStatus;
}

function checkedLabel(
  observation: ConnectionObservation | null,
  tr: (en: string, fr: string) => string,
): string {
  if (observation?.lastCheckedAt === null || observation?.lastCheckedAt === undefined) {
    return tr("Never checked", "Jamais vérifié");
  }
  return `${tr("Checked", "Vérifié")} ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(observation.lastCheckedAt))}`;
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
