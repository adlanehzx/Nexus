import { useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import { Empty, Metric, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

const HEALTH_TONES = { ok: "ok", degraded: "degraded", down: "down", unconfigured: "muted" };

/** One place to diagnose NEXUS. Refreshes on demand: nothing here justifies constant polling. */
export function Observability({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const overview = useSection(() => api.overview());
  const engine = useSection(() => api.missionControl());
  const mcp = useSection(() => api.mcp());
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
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

  return (
    <div className="content">
      <h2>{tr("Observability", "Observabilité")}</h2>
      <button className="button compact" type="button" onClick={refresh}>
        {tr("Refresh", "Actualiser")}
      </button>
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
            <h3>{tr("Service health", "Santé des services")}</h3>
            <Table head={[tr("Service", "Service"), tr("State", "État"), tr("Detail", "Détail")]}>
              {data.health.map((entry) => (
                <tr key={entry.name} data-health={entry.name}>
                  <td>{entry.name}</td>
                  <td>
                    <State tone={HEALTH_TONES[entry.level]} label={entry.level} />
                  </td>
                  <td>{entry.detail}</td>
                </tr>
              ))}
            </Table>
          </>
        )}
      </Section>
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
                  <td>{server.lastError ?? "—"}</td>
                </tr>
              ))}
            </Table>
          )
        }
      </Section>
      <h3>{tr("Incidents", "Incidents")}</h3>
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
      </form>
      <p className="muted">
        {search.length > 0
          ? tr("All levels for this search.", "Tous les niveaux pour cette recherche.")
          : tr("Recent warnings and errors.", "Avertissements et erreurs récents.")}
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
                  <td>{entry.message}</td>
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
