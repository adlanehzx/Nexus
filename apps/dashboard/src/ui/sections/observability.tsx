import { useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import { Empty, Metric, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

const HEALTH_TONES = {
  ok: "ok",
  degraded: "degraded",
  down: "down",
  unconfigured: "muted",
} as const;

/**
 * Strips any sensitive credentials, bearer tokens, or API keys from messages.
 */
export function redactSensitiveSecrets(raw: string): string {
  return raw
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{10,}/gi, "$1[REDACTED_TOKEN]")
    .replace(/(ghp_|github_pat_)[A-Za-z0-9_]+/gi, "[REDACTED_GITHUB_TOKEN]")
    .replace(/(sk-[A-Za-z0-9_-]{12,})/gi, "[REDACTED_API_KEY]")
    .replace(/(password|secret|token)=["']?[^"'\s&]+["']?/gi, "$1=[REDACTED]");
}

/** Diagnostic resolution guides for each subsystem. */
const RESOLUTION_GUIDES: Record<string, { en: string; fr: string }> = {
  Workers: {
    en: "Ensure @nexus/windows-worker or client worker daemon is running and has authenticated with a paired device token.",
    fr: "Vérifiez que @nexus/windows-worker ou le daemon worker est actif et authentifié avec un token d'appareil appairé.",
  },
  "Mission Engine": {
    en: "Start the local Python research engine on port 18100: `uv run uvicorn nexus_engine.main:app --port 18100`.",
    fr: "Démarrez le moteur de recherche Python sur le port 18100 : `uv run uvicorn nexus_engine.main:app --port 18100`.",
  },
  MCP: {
    en: "Configure MCP servers under Settings -> MCP or install required capabilities from the server catalog.",
    fr: "Configurez les serveurs MCP dans Paramètres -> MCP ou installez les capacités depuis le catalogue.",
  },
  "Real-time clients": {
    en: "Verify WebSocket connection on `/ws/client` and ensure no firewall or proxy is blocking streaming upgrades.",
    fr: "Vérifiez la connexion WebSocket sur `/ws/client` et assurez-vous qu'aucun proxy ne bloque les connexions streaming.",
  },
  Database: {
    en: "Verify DATABASE_URL in .env and ensure PostgreSQL / Prisma migrations are applied via `pnpm db:migrate`.",
    fr: "Vérifiez DATABASE_URL dans .env et assurez-vous que les migrations Prisma sont appliquées (`pnpm db:migrate`).",
  },
  Providers: {
    en: "Set up at least one LLM provider (OpenAI, Anthropic, Gemini, or local Ollama) in Settings -> Providers.",
    fr: "Configurez au moins un fournisseur LLM (OpenAI, Anthropic, Gemini ou Ollama local) dans Paramètres -> Fournisseurs.",
  },
};

/** One place to diagnose NEXUS. Refreshes on demand: nothing here justifies constant polling. */
export function Observability({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const overview = useSection(() => api.overview());
  const engine = useSection(() => api.missionControl());
  const mcp = useSection(() => api.mcp());
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [lastPingMs, setLastPingMs] = useState<number | null>(null);
  const [pinging, setPinging] = useState(false);
  const [showGuides, setShowGuides] = useState(false);

  const logs = useSection(
    () => api.logs(search.length > 0 ? { search } : { level: "warn" }),
    [search],
  );

  const refresh = () => {
    overview.reload();
    engine.reload();
    mcp.reload();
    logs.reload();
  };

  const runDiagnosticPing = async () => {
    setPinging(true);
    const start = performance.now();
    try {
      await api.overview();
      setLastPingMs(Math.round(performance.now() - start));
      refresh();
    } catch {
      setLastPingMs(null);
    } finally {
      setPinging(false);
    }
  };

  return (
    <div className="content">
      <h2>{tr("Observability & System Diagnostics", "Observabilité & Diagnostics Système")}</h2>

      {/* Non-destructive diagnostic actions bar */}
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "1rem" }}>
        <button className="button compact" type="button" onClick={refresh}>
          {tr("Refresh", "Actualiser")}
        </button>
        <button
          className="button compact"
          type="button"
          disabled={pinging}
          onClick={() => void runDiagnosticPing()}
        >
          {pinging
            ? tr("Pinging...", "Test en cours...")
            : tr("Run Diagnostic Ping", "Tester la connectivité")}
        </button>
        <button
          className="button compact secondary"
          type="button"
          onClick={() => setShowGuides((prev) => !prev)}
        >
          {showGuides
            ? tr("Hide Resolution Guides", "Masquer guides de résolution")
            : tr("Show Resolution Guides", "Afficher guides de résolution")}
        </button>
        {lastPingMs !== null && (
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            {tr(`Round-trip ping: ${String(lastPingMs)} ms`, `Ping aller-retour : ${String(lastPingMs)} ms`)}
          </span>
        )}
      </div>

      <Section state={overview}>
        {(data) => (
          <>
            <div className="metrics">
              <Metric
                value={`${String(data.workers.connected)} / ${String(data.workers.total)}`}
                label={tr("workers connected", "workers connectés")}
              />
              <Metric
                value={String(data.tasks.running)}
                label={tr("tasks running", "tâches en cours")}
              />
              <Metric
                value={String(data.tasks.failed)}
                label={tr("tasks failed", "tâches en échec")}
                alert={data.tasks.failed > 0}
              />
              <Metric
                value={String(data.agentRuns.failed)}
                label={tr("runs failed", "runs en échec")}
                alert={data.agentRuns.failed > 0}
              />
            </div>

            <h3>{tr("Subsystem Health Matrix", "Matrice de santé des sous-systèmes")}</h3>
            <Table
              head={[
                tr("Subsystem", "Sous-système"),
                tr("Status", "État"),
                tr("Standardized State", "État standardisé"),
                tr("Detail", "Détail"),
              ]}
            >
              {data.health.map((entry) => {
                const standardizedLabel =
                  entry.level === "ok"
                    ? tr("Healthy", "Sain")
                    : entry.level === "degraded"
                      ? tr("Degraded", "Dégradé")
                      : entry.level === "down"
                        ? tr("Unavailable", "Indisponible")
                        : tr("Unknown / Unconfigured", "Inconnu / Non configuré");

                return (
                  <tr key={entry.name} data-health={entry.name}>
                    <td><strong>{entry.name}</strong></td>
                    <td>
                      <State tone={HEALTH_TONES[entry.level]} label={entry.level} />
                    </td>
                    <td>
                      <span className={`status-badge status-${entry.level}`}>
                        {standardizedLabel}
                      </span>
                    </td>
                    <td>{entry.detail}</td>
                  </tr>
                );
              })}
            </Table>
          </>
        )}
      </Section>

      {/* Actionable troubleshooting guides */}
      {showGuides && (
        <div className="resolution-guides-card" style={{ marginTop: "1.5rem", padding: "1rem", border: "1px solid var(--border-subtle, #333)", borderRadius: "6px" }}>
          <h3>{tr("Troubleshooting & Resolution Instructions", "Instructions de dépannage & résolution")}</h3>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "1rem" }}>
            {tr(
              "Non-destructive actions and instructions to recover degraded or unavailable subsystems.",
              "Actions non destructives et instructions pour restaurer les sous-systèmes dégradés ou indisponibles.",
            )}
          </p>
          <ul style={{ paddingLeft: "1.2rem", lineHeight: "1.6" }}>
            {Object.entries(RESOLUTION_GUIDES).map(([subsystem, guide]) => (
              <li key={subsystem} style={{ marginBottom: "0.5rem" }}>
                <strong>{subsystem}</strong>: {tr(guide.en, guide.fr)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3>{tr("Mission Engine", "Mission Engine")}</h3>
      <Section state={engine}>
        {(data) => (
          <p data-testid="engine-status">
            <State
              tone={!data.configured ? "muted" : data.reachable ? "ok" : "down"}
              label={
                !data.configured
                  ? tr("not configured", "non configuré")
                  : data.reachable
                    ? tr("reachable", "accessible")
                    : tr("unreachable", "inaccessible")
              }
            />
          </p>
        )}
      </Section>

      <h3>{tr("MCP servers", "Serveurs MCP")}</h3>
      <Section state={mcp}>
        {(data) =>
          data.servers.length === 0 ? (
            <Empty>{tr("No MCP server.", "Aucun serveur MCP.")}</Empty>
          ) : (
            <Table head={[tr("Server", "Serveur"), tr("State", "État"), tr("Error", "Erreur")]}>
              {data.servers.map((server) => (
                <tr key={server.name}>
                  <td>{server.name}</td>
                  <td>{server.status}</td>
                  <td>{server.lastError ? redactSensitiveSecrets(server.lastError) : "—"}</td>
                </tr>
              ))}
            </Table>
          )
        }
      </Section>

      <h3>{tr("Incidents & Diagnostic Logs", "Incidents & Journaux de diagnostic")}</h3>
      <form
        className="usage-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(draft.trim());
        }}
      >
        <label>
          {tr("Correlation ID or message", "Identifiant de corrélation ou message")}{" "}
          <input value={draft} onChange={(event) => setDraft(event.target.value)} />
        </label>
        <button className="button compact" type="submit">
          {tr("Search", "Rechercher")}
        </button>
        {search.length > 0 && (
          <button
            className="button compact secondary"
            type="button"
            onClick={() => {
              setDraft("");
              setSearch("");
            }}
          >
            {tr("Clear filter", "Effacer le filtre")}
          </button>
        )}
      </form>
      <p className="muted">
        {search.length > 0
          ? tr("All levels for this search (secrets redacted).", "Tous les niveaux pour cette recherche (secrets masqués).")
          : tr("Recent warnings and errors (secrets redacted).", "Avertissements et erreurs récents (secrets masqués).")}
      </p>
      <Section state={logs}>
        {(data) =>
          data.entries.length === 0 ? (
            <Empty>{tr("Nothing found.", "Rien de trouvé.")}</Empty>
          ) : (
            <Table
              head={[
                tr("Time", "Heure"),
                tr("Level", "Niveau"),
                tr("Message", "Message"),
                tr("Correlation ID", "Corrélation"),
              ]}
            >
              {data.entries.map((entry, index) => (
                <tr key={`${entry.at}-${String(index)}`} data-log-correlation={entry.correlationId}>
                  <td className="mono">{new Date(entry.at).toLocaleTimeString()}</td>
                  <td>{entry.level}</td>
                  <td>{redactSensitiveSecrets(entry.message)}</td>
                  <td className="mono">{entry.correlationId ?? "—"}</td>
                </tr>
              ))}
            </Table>
          )
        }
      </Section>
    </div>
  );
}
