import type { DashboardApi } from "../../lib/api.js";
import { formatAge, formatCount } from "../../lib/format.js";
import { Empty, Metric, Section, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 11. Security
// ─────────────────────────────────────────────────────────────────────────────

export function Security({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.security());

  return (
    <div className="content">
      <Section state={state}>
        {(data) => (
          <>
            <div className="metrics">
              <Metric
                value={formatCount(data.trust.trusted)}
                label={tr("trusted devices", "appareils de confiance")}
              />
              <Metric
                value={formatCount(data.trust.pending)}
                label={tr("pending approval", "en attente d'approbation")}
                alert={data.trust.pending > 0}
              />
              <Metric value={formatCount(data.trust.revoked)} label={tr("revoked", "révoqués")} />
              <Metric
                value={formatCount(data.byKind["auth.login_failed"] ?? 0)}
                label={tr("login failures", "échecs de connexion")}
                alert={(data.byKind["auth.login_failed"] ?? 0) > 0}
              />
              <Metric
                value={formatCount(data.byKind["memory.refused"] ?? 0)}
                label={tr("rejected memories", "mémoires refusées")}
              />
            </div>

            <h3>{tr("Effective Permissions", "Permissions Effectives")}</h3>
            <p className="mono muted">
              {data.permissions.length === 0 ? tr("none", "aucune") : data.permissions.join(", ")}
            </p>

            <h3>{tr("Events", "Événements")}</h3>
            {data.events.length === 0 ? (
              <Empty>{tr("No security events.", "Aucun événement de sécurité.")}</Empty>
            ) : (
              <Table head={[tr("When", "Quand"), tr("Type", "Type"), tr("Summary", "Résumé")]}>
                {data.events.map((event, index) => (
                  <tr key={`${event.at}-${String(index)}`}>
                    <td className="muted">{formatAge(event.at)}</td>
                    <td className="mono">{event.kind}</td>
                    <td>{event.summary}</td>
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
