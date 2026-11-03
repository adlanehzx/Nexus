import { useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import { Empty, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 12. Logs
// ─────────────────────────────────────────────────────────────────────────────

export function Logs({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const [level, setLevel] = useState<string>("");
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState<{ level?: string; search?: string }>({});

  const state = useSection(() => api.logs(applied), [applied]);

  return (
    <div className="content">
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <select
          className="field"
          value={level}
          onChange={(event) => {
            setLevel(event.target.value);
          }}
        >
          <option value="">{tr("all levels", "tous les niveaux")}</option>
          <option value="info">{tr("info and above", "info et supérieur")}</option>
          <option value="warn">{tr("warnings", "avertissements")}</option>
          <option value="error">{tr("errors", "erreurs")}</option>
        </select>

        <input
          className="field"
          style={{ flex: 1 }}
          value={search}
          placeholder={tr("Search messages…", "Rechercher des messages…")}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        ></input>

        <button
          type="button"
          className="button"
          onClick={() => {
            setApplied({
              ...(level === "" ? {} : { level }),
              ...(search === "" ? {} : { search }),
            });
          }}
        >
          {tr("Filter", "Filtrer")}
        </button>
      </div>

      <Section state={state}>
        {(data) =>
          data.entries.length === 0 ? (
            <Empty>{tr("No log lines matched.", "Aucune ligne de journal correspondante.")}</Empty>
          ) : (
            <Table
              head={[
                tr("When", "Quand"),
                tr("Level", "Niveau"),
                tr("Message", "Message"),
                tr("Correlation", "Corrélation"),
              ]}
            >
              {data.entries.map((entry, index) => (
                <tr key={`${entry.at}-${String(index)}`}>
                  <td className="muted mono">{entry.at.slice(11, 23)}</td>
                  <td>
                    <State
                      tone={
                        entry.level === "error" || entry.level === "fatal"
                          ? "down"
                          : entry.level === "warn"
                            ? "degraded"
                            : "ok"
                      }
                      label={entry.level}
                    />
                  </td>
                  <td>{entry.message}</td>
                  <td className="muted mono">{entry.correlationId ?? "—"}</td>
                </tr>
              ))}
            </Table>
          )
        }
      </Section>
    </div>
  );
}
