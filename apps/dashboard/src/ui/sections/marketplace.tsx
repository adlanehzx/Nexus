import { useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import { Empty, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 14. Phase 2: Marketplace (Claude Contract)
// ─────────────────────────────────────────────────────────────────────────────

export function Marketplace({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.marketplacePlugins());
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const act = (op: () => Promise<unknown>) => {
    setActionError(null);
    void op()
      .then(() => state.reload())
      .catch((err: unknown) =>
        setActionError(
          err instanceof Error ? err.message : tr("Action failed.", "Échec de l'action."),
        ),
      );
  };

  return (
    <div className="content">
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <div
        className="filter-bar"
        style={{ marginBottom: "16px", display: "flex", gap: "12px", alignItems: "center" }}
      >
        <input
          className="field"
          type="search"
          placeholder={tr(
            "Filter plugins or declared tools…",
            "Filtrer les plugins ou outils déclarés…",
          )}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: "320px" }}
        />
      </div>
      <Section state={state}>
        {(data) => {
          const filtered = data.plugins.filter((p) => {
            if (!search) return true;
            const q = search.toLowerCase();
            return (
              p.name.toLowerCase().includes(q) ||
              p.description.toLowerCase().includes(q) ||
              p.declaredTools.some((t) => t.toLowerCase().includes(q))
            );
          });

          if (filtered.length === 0) {
            return (
              <Empty>
                {tr("No marketplace plugins found.", "Aucun plugin trouvé sur le marketplace.")}
              </Empty>
            );
          }

          return (
            <Table
              head={[
                tr("Plugin", "Plugin"),
                tr("Publisher", "Éditeur"),
                tr("Version", "Version"),
                tr("Status", "Statut"),
                tr("Declared Tools", "Outils Déclarés"),
                tr("Reputation", "Réputation"),
                tr("Actions", "Actions"),
              ]}
            >
              {filtered.map((plugin) => (
                <tr key={plugin.id}>
                  <td>
                    <strong>{plugin.name}</strong>
                    <div className="muted">{plugin.description}</div>
                  </td>
                  <td>{plugin.publisher}</td>
                  <td className="mono muted">{plugin.version}</td>
                  <td>
                    <State
                      tone={
                        plugin.status === "installed"
                          ? "ok"
                          : plugin.status === "paused"
                            ? "degraded"
                            : plugin.status === "revoked"
                              ? "revoked"
                              : "muted"
                      }
                      label={plugin.status.toUpperCase()}
                    />
                  </td>
                  <td>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                      {plugin.declaredTools.map((t) => (
                        <span
                          key={t}
                          className="badge mono"
                          style={{
                            fontSize: "0.75rem",
                            background: "var(--nx-surface-hover)",
                            padding: "2px 6px",
                            borderRadius: "4px",
                          }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    {plugin.reputationScore !== undefined
                      ? `${String(plugin.reputationScore)} / 100`
                      : "—"}
                  </td>
                  <td>
                    <div className="table-actions">
                      {plugin.status === "uninstalled" ? (
                        <button
                          className="button primary compact"
                          type="button"
                          onClick={() => act(() => api.installPlugin(plugin.id))}
                        >
                          {tr("Install", "Installer")}
                        </button>
                      ) : null}
                      {plugin.status === "installed" ? (
                        <button
                          className="button compact"
                          type="button"
                          onClick={() => act(() => api.togglePlugin(plugin.id, true))}
                        >
                          {tr("Pause", "Suspendre")}
                        </button>
                      ) : null}
                      {plugin.status === "paused" ? (
                        <button
                          className="button compact"
                          type="button"
                          onClick={() => act(() => api.togglePlugin(plugin.id, false))}
                        >
                          {tr("Resume", "Reprendre")}
                        </button>
                      ) : null}
                      {plugin.status === "installed" || plugin.status === "paused" ? (
                        <button
                          className="button danger compact"
                          type="button"
                          onClick={() => {
                            if (
                              window.confirm(
                                tr(
                                  `Revoke plugin "${plugin.name}"? This permanently uninstalls and disables all declared tools.`,
                                  `Révoquer le plugin "${plugin.name}" ? Cela désinstalle définitivement et désactive tous les outils déclarés.`,
                                ),
                              )
                            ) {
                              act(() => api.revokePlugin(plugin.id));
                            }
                          }}
                        >
                          {tr("Revoke", "Révoquer")}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          );
        }}
      </Section>
    </div>
  );
}
