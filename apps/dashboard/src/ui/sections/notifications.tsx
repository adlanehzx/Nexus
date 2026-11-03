import { useEffect, useState } from "react";
import type { DashboardApi, ExternalNotificationConfigDto } from "../../lib/api.js";
import { formatAge, formatCount } from "../../lib/format.js";
import { Empty, Metric, Section, State, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 10. Notifications
// ─────────────────────────────────────────────────────────────────────────────

export function Notifications({ api }: { api: DashboardApi }) {
  const { tr } = useI18n();
  const state = useSection(() => api.notifications());
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [config, setConfig] = useState<ExternalNotificationConfigDto | null>(null);
  const [configSaving, setConfigSaving] = useState(false);
  const [configFeedback, setConfigFeedback] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  useEffect(() => {
    void api
      .notificationConfig()
      .then(setConfig)
      .catch((cause: unknown) => {
        console.warn(
          "Notification config load skipped:",
          cause instanceof Error ? cause.message : cause,
        );
      });
  }, [api]);

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!config) return;
    setConfigSaving(true);
    setConfigFeedback(null);
    try {
      await api.saveNotificationConfig(config);
      setConfigFeedback(
        tr(
          "External notification configuration saved.",
          "Configuration des notifications externes enregistrée.",
        ),
      );
      setTimeout(() => setConfigFeedback(null), 3500);
    } catch (err) {
      setConfigFeedback(`Save error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConfigSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { report } = await api.testNotification();
      const summary = report.channels
        .map(
          (c) =>
            `${c.channel}: ${c.success ? "[OK] success" : c.skippedReason ? `(skipped: ${c.skippedReason})` : `[FAIL] error (${c.error ?? ""})`}`,
        )
        .join(" | ");
      setTestResult(`Report: ${summary}`);
    } catch (err) {
      setTestResult(`Test failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="content">
      <div className="agents-heading">
        <div>
          <h2>{tr("Notifications", "Notifications")}</h2>
          <p className="muted">
            {tr(
              "Central log and broadcast to external channels (desktop, mobile push ntfy, webhooks).",
              "Journal central et diffusion vers les canaux externes (bureau, push mobile ntfy, webhooks).",
            )}
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            className="button secondary"
            type="button"
            onClick={() => setShowConfig((curr) => !curr)}
          >
            {showConfig
              ? tr("Hide channel config", "Masquer la configuration")
              : tr("Configure channels", "Configurer les canaux")}
          </button>
          <button
            className="button"
            type="button"
            disabled={testing}
            onClick={() => void handleTest()}
          >
            {testing
              ? tr("Testing...", "Test en cours...")
              : tr("Test external channels", "Tester les canaux externes")}
          </button>
        </div>
      </div>

      {testResult !== null ? (
        <p className="banner success" style={{ marginBottom: "1rem" }}>
          {testResult}
        </p>
      ) : null}

      {configFeedback !== null ? (
        <p className="banner success" style={{ marginBottom: "1rem" }}>
          {configFeedback}
        </p>
      ) : null}

      {showConfig && config !== null && (
        <form
          className="card"
          onSubmit={(e) => void handleSaveConfig(e)}
          style={{ padding: "16px", marginBottom: "20px", border: "1px solid var(--border)" }}
        >
          <h3 style={{ marginTop: 0 }}>
            {tr("External Notification Channels", "Canaux de Notification Externes")}
          </h3>

          <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "12px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
              />
              <strong>
                {tr(
                  "Enable external notification broadcast",
                  "Activer la diffusion externe des notifications",
                )}
              </strong>
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <label>
                {tr("Desktop Alert Urgency", "Urgence alerte bureau")}
                <select
                  className="field"
                  value={config.desktop.urgency}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      desktop: {
                        ...config.desktop,
                        urgency: e.target.value as "low" | "normal" | "critical",
                      },
                    })
                  }
                >
                  <option value="low">{tr("Low", "Faible")}</option>
                  <option value="normal">{tr("Normal", "Normal")}</option>
                  <option value="critical">{tr("Critical", "Critique")}</option>
                </select>
              </label>

              <label>
                {tr("Dashboard Base URL", "URL de base du tableau de bord")}
                <input
                  className="field"
                  type="url"
                  value={config.dashboardBaseUrl}
                  onChange={(e) => setConfig({ ...config, dashboardBaseUrl: e.target.value })}
                />
              </label>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <label>
                {tr("Ntfy Server URL", "URL serveur Ntfy")}
                <input
                  className="field"
                  type="url"
                  value={config.ntfy.serverUrl}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      ntfy: { ...config.ntfy, serverUrl: e.target.value },
                    })
                  }
                />
              </label>

              <label>
                {tr("Ntfy Topic", "Sujet Ntfy")}
                <input
                  className="field"
                  type="text"
                  value={config.ntfy.topic}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      ntfy: { ...config.ntfy, topic: e.target.value },
                    })
                  }
                />
              </label>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "12px" }}>
              <label>
                {tr("Webhook URL", "URL Webhook")}
                <input
                  className="field"
                  type="url"
                  placeholder="https://discord.com/api/webhooks/..."
                  value={config.webhook?.url ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      webhook: {
                        enabled: e.target.value.trim().length > 0,
                        url: e.target.value,
                        format: config.webhook?.format ?? "generic",
                      },
                    })
                  }
                />
              </label>

              <label>
                {tr("Webhook Format", "Format Webhook")}
                <select
                  className="field"
                  value={config.webhook?.format ?? "generic"}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      webhook: {
                        enabled: (config.webhook?.url ?? "").length > 0,
                        ...(config.webhook?.url ? { url: config.webhook.url } : {}),
                        format: e.target.value as "discord" | "telegram" | "apprise" | "generic",
                      },
                    })
                  }
                >
                  <option value="generic">Generic JSON</option>
                  <option value="discord">Discord</option>
                  <option value="telegram">Telegram</option>
                  <option value="apprise">Apprise</option>
                </select>
              </label>
            </div>

            <div>
              <button type="submit" className="button primary" disabled={configSaving}>
                {configSaving
                  ? tr("Saving...", "Enregistrement...")
                  : tr("Save notification settings", "Enregistrer les paramètres")}
              </button>
            </div>
          </div>
        </form>
      )}

      <Section state={state}>
        {(data) => (
          <>
            <div className="metrics">
              <Metric value={formatCount(data.unread)} label={tr("unread", "non lues")} />
              <Metric
                value={formatCount(data.notifications.length)}
                label={tr("stored", "enregistrées")}
              />
            </div>

            {data.notifications.length === 0 ? (
              <Empty>{tr("No notifications.", "Aucune notification.")}</Empty>
            ) : (
              <Table
                head={[
                  tr("When", "Quand"),
                  tr("Severity", "Gravité"),
                  tr("Title", "Titre"),
                  tr("Body", "Message"),
                  tr("Read", "Lu"),
                  tr("Actions", "Actions"),
                ]}
              >
                {data.notifications.map((notification) => (
                  <tr key={notification.id}>
                    <td className="muted">{formatAge(notification.createdAt)}</td>
                    <td>
                      <State
                        tone={
                          notification.severity === "error"
                            ? "down"
                            : notification.severity === "warning"
                              ? "degraded"
                              : "ok"
                        }
                        label={notification.severity}
                      />
                    </td>
                    <td>{notification.title}</td>
                    <td className="muted">{notification.body}</td>
                    <td className="muted">
                      {notification.readAt === null ? tr("no", "non") : tr("yes", "oui")}
                    </td>
                    <td>
                      {notification.readAt === null ? (
                        <button
                          className="button"
                          type="button"
                          onClick={() =>
                            void api
                              .markNotificationRead(notification.id)
                              .then(() => state.reload())
                          }
                        >
                          {tr("Mark read", "Marquer comme lu")}
                        </button>
                      ) : (
                        "—"
                      )}
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
