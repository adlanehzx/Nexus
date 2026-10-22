import { useCallback, useEffect, useState } from "react";
import type { ConnectionCatalogEntry, ConnectionObservation, DashboardApi } from "../lib/api.js";

export function Connections({ api }: { api: DashboardApi }) {
  const [connections, setConnections] = useState<ConnectionCatalogEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setConnections((await api.connections()).connections);
    } catch (cause) {
      setError(messageOf(cause, "Unable to load connections."));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const scan = async (): Promise<void> => {
    setBusy("all");
    setError(null);
    try {
      setConnections((await api.detectConnections()).connections);
    } catch (cause) {
      setError(messageOf(cause, "Host scan failed."));
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
      setError(messageOf(cause, `Unable to test ${providerId}.`));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="contenu connections-page">
      <section className="connection-hero">
        <div>
          <span className="connection-kicker">Local discovery</span>
          <h2>Connect the tools already installed on this host.</h2>
          <p>
            NEXUS runs only declared, read-only diagnostics. Credentials stay inside each provider's
            own CLI and never pass through the dashboard.
          </p>
        </div>
        <button
          className="bouton primary"
          type="button"
          disabled={busy !== null}
          onClick={() => void scan()}
        >
          {busy === "all" ? "Scanning…" : "Scan this host"}
        </button>
      </section>

      <div className="connection-scope" role="note">
        <strong>Scope:</strong> discovery runs on the machine hosting the NEXUS API. If the API runs
        in Docker, the CLI must be available inside that container or exposed through a NEXUS host
        connector.
      </div>

      {error === null ? null : (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}

      {connections === null ? (
        <div className="loading-state" role="status" aria-label="Loading connections">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <div className="connection-grid">
          {connections.map((entry) => (
            <ConnectionCard
              key={entry.providerId}
              entry={entry}
              busy={busy === entry.providerId || busy === "all"}
              onTest={() => void test(entry.providerId)}
            />
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
  const observation = entry.observation;
  const state = connectionState(entry);

  return (
    <article className="connection-card">
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
        <ConnectionDetail label="CLI version" value={observation?.version ?? "Not checked"} />
        <ConnectionDetail label="Authentication" value={authLabel(observation)} />
        <ConnectionDetail
          label="ACP adapter"
          value={observation?.adapter?.availability ?? "unknown"}
        />
        <ConnectionDetail label="Provenance" value={entry.adapter.provenance} />
      </dl>

      {observation?.executablePath === null || observation?.executablePath === undefined ? null : (
        <code className="connection-path">{observation.executablePath}</code>
      )}

      {observation?.userMessage === null || observation?.userMessage === undefined ? null : (
        <p className="connection-message">{observation.userMessage}</p>
      )}

      <p className="connection-evidence">{entry.adapter.provenanceEvidence}</p>

      <div className="connection-card-footer">
        <span>{checkedLabel(observation)}</span>
        <div className="connection-actions">
          {entry.docsUrl === null ? null : (
            <a className="bouton compact" href={entry.docsUrl} target="_blank" rel="noreferrer">
              Documentation
            </a>
          )}
          <button
            className="bouton compact"
            type="button"
            disabled={busy || !entry.supportedOnThisHost}
            onClick={onTest}
          >
            {busy ? "Testing…" : "Test"}
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

function connectionState(entry: ConnectionCatalogEntry): { label: string; tone: string } {
  if (!entry.supportedOnThisHost) return { label: "Unsupported", tone: "muted" };
  const state = entry.observation?.state;
  if (state === undefined) return { label: "Not checked", tone: "muted" };
  if (state === "connected") return { label: "Connected", tone: "good" };
  if (state === "detected") return { label: "Detected", tone: "good" };
  if (state === "authentication_required" || state === "expired") {
    return { label: "Action needed", tone: "warning" };
  }
  if (state === "not_installed") return { label: "Not installed", tone: "muted" };
  return { label: state.replaceAll("_", " "), tone: "danger" };
}

function authLabel(observation: ConnectionObservation | null): string {
  if (observation === null) return "Not checked";
  return observation.authStatus;
}

function checkedLabel(observation: ConnectionObservation | null): string {
  if (observation?.lastCheckedAt === null || observation?.lastCheckedAt === undefined) {
    return "Never checked";
  }
  return `Checked ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(observation.lastCheckedAt))}`;
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
