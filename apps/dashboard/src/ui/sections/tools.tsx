import type { DashboardApi } from "../../lib/api.js";
import { Empty, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 6. Tools
// ─────────────────────────────────────────────────────────────────────────────

export function Tools({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.tools());

  return (
    <div className="content">
      <Section state={state}>
        {(data) =>
          data.tools.length === 0 ? (
            <Empty>
              {tr(
                "No registered tools. The catalog populates when the agent service starts.",
                "Aucun outil enregistré. Le catalogue se remplit au démarrage du service d'agent.",
              )}
            </Empty>
          ) : (
            <Table
              head={[
                tr("Tool", "Outil"),
                tr("Source", "Source"),
                tr("Description", "Description"),
                tr("Risk", "Risque"),
                tr("Permissions", "Permissions"),
                tr("Allowed", "Autorisé"),
              ]}
            >
              {data.tools.map((tool) => (
                <tr key={tool.name}>
                  <td className="mono">{tool.name}</td>
                  <td>{tool.source}</td>
                  <td className="muted">{tool.description}</td>
                  <td>{tool.riskLevel}</td>
                  <td className="mono muted">{tool.requiredPermissions.join(", ") || "—"}</td>
                  <td>
                    <State
                      tone={tool.allowed ? "ok" : "degraded"}
                      label={tool.allowed ? tr("yes", "oui") : tr("no", "non")}
                    />
                  </td>
                </tr>
              ))}
            </Table>
          )
        }
      </Section>
    </div>
  );
}
