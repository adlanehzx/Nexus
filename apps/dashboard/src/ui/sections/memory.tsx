import { useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import { formatAge, formatCount } from "../../lib/format.js";
import { Empty, Metric, Section, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 9. Memory
// ─────────────────────────────────────────────────────────────────────────────

export function Memory({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.memory());
  const [content, setContent] = useState("");
  const [layer, setLayer] = useState<"LONG_TERM" | "PREFERENCE">("LONG_TERM");
  const [tags, setTags] = useState("");
  const [acknowledgedSensitive, setAcknowledgedSensitive] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <div className="content">
      <div className="admin-form-card">
        <h3>{tr("Add Memory", "Ajouter une Mémoire")}</h3>
        <div className="inline-admin-form memory-form">
          <input
            aria-label={tr("What NEXUS should remember", "Ce dont NEXUS doit se souvenir")}
            className="field"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={tr("What NEXUS should remember", "Ce dont NEXUS doit se souvenir")}
          />
          <select
            className="field"
            aria-label={tr("Memory layer", "Couche mémoire")}
            value={layer}
            onChange={(event) => setLayer(event.target.value as "LONG_TERM" | "PREFERENCE")}
          >
            <option value="LONG_TERM">{tr("Long-term", "Long terme")}</option>
            <option value="PREFERENCE">{tr("Preference", "Préférence")}</option>
          </select>
          <input
            aria-label={tr("tags, comma, separated", "tags, séparés, par des virgules")}
            className="field"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder={tr("tags, comma, separated", "tags, séparés, par des virgules")}
          />
          <label className="check-label">
            <input
              type="checkbox"
              checked={acknowledgedSensitive}
              onChange={(event) => setAcknowledgedSensitive(event.target.checked)}
            />
            {tr("sensitive content verified", "contenu sensible vérifié")}
          </label>
          <button
            className="button primary"
            type="button"
            disabled={content.trim().length === 0}
            onClick={() => {
              setActionError(null);
              void api
                .remember({
                  content: content.trim(),
                  layer,
                  tags: tags
                    .split(",")
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                  acknowledgedSensitive,
                })
                .then(() => {
                  setContent("");
                  setTags("");
                  state.reload();
                })
                .catch((cause: unknown) =>
                  setActionError(
                    cause instanceof Error
                      ? cause.message
                      : tr("Unable to save.", "Impossible d'enregistrer."),
                  ),
                );
            }}
          >
            {tr("Remember", "Mémoriser")}
          </button>
        </div>
      </div>
      {actionError === null ? null : <p className="banner error">{actionError}</p>}
      <Section state={state}>
        {(data) => (
          <>
            <div className="metrics">
              <Metric value={formatCount(data.total)} label={tr("memories", "mémoires")} />
              <Metric
                value={formatCount(data.byLayer.PREFERENCE ?? 0)}
                label={tr("preferences", "préférences")}
              />
              <Metric
                value={formatCount(data.byOrigin.AGENT ?? 0)}
                label={tr("inferred by agent", "déduit par l'agent")}
              />
              <Metric
                value={formatCount(data.bySensitivity.PERSONAL ?? 0)}
                label={tr("marked personal", "marqué personnel")}
              />
            </div>

            <h3>{tr("Recent Memories", "Mémoires Récentes")}</h3>
            {data.recent.length === 0 ? (
              <Empty>{tr("No memories stored.", "Aucune mémoire enregistrée.")}</Empty>
            ) : (
              <Table
                head={[
                  tr("Content", "Contenu"),
                  tr("Layer", "Couche"),
                  tr("Origin", "Origine"),
                  tr("Created", "Créé"),
                  tr("Actions", "Actions"),
                ]}
              >
                {data.recent.map((record) => (
                  <tr key={record.id}>
                    <td>{record.content}</td>
                    <td className="muted">{record.layer}</td>
                    <td className="muted">{record.origin}</td>
                    <td className="muted">{formatAge(record.createdAt)}</td>
                    <td>
                      <button
                        className="button danger"
                        type="button"
                        onClick={() => {
                          if (
                            !window.confirm(
                              tr(
                                "Permanently forget this memory?",
                                "Oublier définitivement cette mémoire ?",
                              ),
                            )
                          )
                            return;
                          void api
                            .forget(record.id)
                            .then(() => state.reload())
                            .catch((cause: unknown) =>
                              setActionError(
                                cause instanceof Error
                                  ? cause.message
                                  : tr("Deletion failed.", "Échec de suppression."),
                              ),
                            );
                        }}
                      >
                        {tr("Forget", "Oublier")}
                      </button>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )}
      </Section>
    </div>
  );
}
