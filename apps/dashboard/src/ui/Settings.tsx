import { useEffect, useState } from "react";
import type {
  BrowserSection,
  DashboardApi,
  FreeLlmStatus,
  McpConfiguration,
  RuntimeSettings,
} from "../lib/api.js";
import { Section, useSection } from "./parts.js";

export function Settings({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.runtimeSettings());
  const secrets = useSection(() => api.secrets());
  const linkedin = useSection(() => api.linkedInStatus());
  const freeLlm = useSection(() => api.freeLlmStatus());

  return (
    <div className="content settings-page">
      <div className="agents-heading">
        <div>
          <h2>Settings</h2>
          <p className="muted">Persistent settings for the NEXUS multi-agent engine.</p>
        </div>
        <button className="button" type="button" onClick={state.reload}>
          Refresh
        </button>
      </div>
      <Section state={state}>
        {(data) => <SettingsForm api={api} initial={data} reload={state.reload} />}
      </Section>
      <Section state={secrets}>
        {(data) => <SecretsForm api={api} names={data.names} reload={secrets.reload} />}
      </Section>
      <Section state={freeLlm}>
        {(data) => <FreeLlmForm api={api} status={data} reload={freeLlm.reload} />}
      </Section>
      <Section state={linkedin}>
        {(data) => <LinkedInForm api={api} status={data} reload={linkedin.reload} />}
      </Section>
      <BackupRestorePanel
        api={api}
        onReloadAll={() => {
          state.reload();
          secrets.reload();
        }}
      />
    </div>
  );
}

function FreeLlmForm({
  api,
  status,
  reload,
}: {
  api: DashboardApi;
  status: FreeLlmStatus;
  reload: () => void;
}) {
  const [enabled, setEnabled] = useState(status.enabled);
  const [model, setModel] = useState(status.model);
  const [strategy, setStrategy] = useState<FreeLlmStatus["strategy"]>(status.strategy);
  const [allowKeyless, setAllowKeyless] = useState(status.allowKeyless);
  const [nvidiaKey, setNvidiaKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(status.enabled);
    setModel(status.model);
    setStrategy(status.strategy);
    setAllowKeyless(status.allowKeyless);
  }, [status.allowKeyless, status.enabled, status.model, status.strategy]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      if (nvidiaKey.trim().length > 0) {
        await api.saveSecret("nvidia-api-key", nvidiaKey.trim());
      }
      await api.configureFreeLlm({
        enabled,
        model: model.trim() || "auto",
        strategy,
        allowKeyless,
        nvidiaKeyRef:
          status.nvidiaConfigured || nvidiaKey.trim().length > 0
            ? "vault://nexus/nvidia-api-key"
            : null,
      });
      setNvidiaKey("");
      setMessage("FreeLLM routing saved. Changes apply to the next model request.");
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "FreeLLM configuration failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-panel">
      <h3>Free models · FreeLLM and NVIDIA NIM</h3>
      <p className="muted">
        Adds a free-tier fallback after your subscription-backed agents and local models. NVIDIA NIM
        access is intended for development, research, and evaluation—not production use.
      </p>
      <p className={status.enabled ? "banner success" : "banner"}>
        {status.enabled
          ? `Enabled · ${status.activeProviders.join(", ") || "provider required"}`
          : "Disabled"}
      </p>
      <div className="settings-grid">
        <label>
          Routing model
          <select
            className="field"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="auto">Auto · best available</option>
            <option value="chat:fast">Fast chat</option>
            <option value="chat:large">Large model</option>
            <option value="chat:tools">Tool calling</option>
            <option value="reasoning">Reasoning</option>
          </select>
        </label>
        <label>
          Routing strategy
          <select
            className="field"
            value={strategy}
            onChange={(event) => setStrategy(event.target.value as FreeLlmStatus["strategy"])}
          >
            <option value="quota_aware">Quota aware</option>
            <option value="smart">Smart latency</option>
            <option value="priority">Fixed priority</option>
            <option value="round_robin">Round robin</option>
            <option value="latency">Lowest latency</option>
          </select>
        </label>
        <label className="settings-wide">
          NVIDIA API key {status.nvidiaConfigured ? "· stored" : ""}
          <input
            className="field mono"
            type="password"
            autoComplete="new-password"
            value={nvidiaKey}
            placeholder={status.nvidiaConfigured ? "Leave blank to keep the stored key" : "nvapi-…"}
            onChange={(event) => setNvidiaKey(event.target.value)}
          />
        </label>
        <label className="check-label settings-wide">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enable FreeLLM fallback
        </label>
        <label className="check-label settings-wide">
          <input
            type="checkbox"
            checked={allowKeyless}
            onChange={(event) => setAllowKeyless(event.target.checked)}
          />
          Allow anonymous Kilo and OVH fallbacks (prompts may be retained by those providers)
        </label>
      </div>
      <div className="settings-actions">
        <button
          className="button primary"
          type="button"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save free-model routing"}
        </button>
        <button
          className="button"
          type="button"
          disabled={busy || !status.enabled}
          title="Consumes one small request from the configured free quota"
          onClick={() => {
            setBusy(true);
            setMessage(null);
            setError(null);
            void api
              .testFreeLlm()
              .then((result) => setMessage(`Ready · ${result.model} · ${result.text}`))
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "FreeLLM test failed."),
              )
              .finally(() => setBusy(false));
          }}
        >
          Test with one request
        </button>
        <a
          className="button secondaire"
          href="https://build.nvidia.com/"
          target="_blank"
          rel="noreferrer"
        >
          Get an NVIDIA development key
        </a>
      </div>
      {message === null ? null : <p className="banner success">{message}</p>}
      {error === null ? null : <p className="banner error">{error}</p>}
    </section>
  );
}

function LinkedInForm({
  api,
  status,
  reload,
}: {
  api: DashboardApi;
  status: { configured: boolean; connected: boolean; tools: string[] };
  reload: () => void;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const redirectUri = `${window.location.origin}/api/v1/linkedin/oauth/callback`;

  return (
    <section className="settings-panel">
      <h3>LinkedIn · Official API</h3>
      <p className="muted">
        Connect through LinkedIn OAuth. NEXUS can publish and comment only after your explicit
        confirmation. It never scrapes or automates the LinkedIn interface.
      </p>
      <p className={status.connected ? "banner success" : "banner"}>
        {status.connected
          ? `Connected · ${status.tools.length} official tools active`
          : status.configured
            ? "Configured, authorization required"
            : "Not configured"}
      </p>
      {!status.connected ? (
        <>
          <div className="settings-grid">
            <label>
              LinkedIn application Client ID
              <input
                className="field mono"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
              />
            </label>
            <label>
              LinkedIn application Client Secret
              <input
                className="field mono"
                type="password"
                autoComplete="new-password"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
              />
            </label>
            <label className="settings-wide">
              Authorized redirect URL
              <input className="field mono" readOnly value={redirectUri} />
            </label>
          </div>
          <div className="settings-actions">
            <button
              className="button primary"
              type="button"
              disabled={busy || clientId.trim() === "" || clientSecret.length < 4}
              onClick={() => {
                setBusy(true);
                setError(null);
                void api
                  .saveSecret("linkedin-client-secret", clientSecret)
                  .then(() =>
                    api.startLinkedInOAuth({
                      clientId: clientId.trim(),
                      clientSecretRef: "vault://nexus/linkedin-client-secret",
                      tokenRef: "vault://nexus/linkedin-token",
                      redirectUri,
                    }),
                  )
                  .then(({ authorizationUrl }) => {
                    window.location.assign(authorizationUrl);
                  })
                  .catch((cause: unknown) => {
                    setBusy(false);
                    setError(
                      cause instanceof Error ? cause.message : "LinkedIn connection failed.",
                    );
                  });
              }}
            >
              {busy ? "Opening LinkedIn…" : "Connect LinkedIn"}
            </button>
          </div>
        </>
      ) : (
        <button
          className="button danger"
          type="button"
          onClick={() =>
            void api
              .disconnectLinkedIn()
              .then(reload)
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "Disconnect failed."),
              )
          }
        >
          Disconnect LinkedIn
        </button>
      )}
      {error === null ? null : <p className="banner error">{error}</p>}
    </section>
  );
}

function BackupRestorePanel({ api, onReloadAll }: { api: DashboardApi; onReloadAll: () => void }) {
  const [busy, setBusy] = useState(false);
  const [restoreJson, setRestoreJson] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleExport = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const [settings, mcp, browser] = await Promise.all([
        api.runtimeSettings(),
        api.mcp(),
        api.browser(),
      ]);
      const backupData = {
        version: "1.0.0",
        exportedAt: new Date().toISOString(),
        settings,
        mcpConfigurations: mcp.configurations,
        browserConfiguration: browser.configuration,
      };
      const blob = new Blob([JSON.stringify(backupData, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `nexus-configuration-backup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage("Configuration backup file downloaded successfully.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Backup export failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async (): Promise<void> => {
    if (restoreJson.trim() === "") return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const parsed: unknown = JSON.parse(restoreJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Invalid backup format: root must be an object.");
      }
      const backup = parsed as Record<string, unknown>;
      if (typeof backup.settings === "object" && backup.settings !== null) {
        await api.updateRuntimeSettings(backup.settings as RuntimeSettings);
      }
      if (Array.isArray(backup.mcpConfigurations)) {
        for (const config of backup.mcpConfigurations) {
          if (typeof config === "object" && config !== null && "name" in config) {
            await api.saveMcp(config as McpConfiguration);
          }
        }
      }
      if (typeof backup.browserConfiguration === "object" && backup.browserConfiguration !== null) {
        await api.configureBrowser(
          backup.browserConfiguration as NonNullable<BrowserSection["configuration"]>,
        );
      }
      setRestoreJson("");
      setMessage("Configuration restored successfully and applied to active services.");
      onReloadAll();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Configuration restore failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-panel">
      <div className="settings-panel-heading">
        <div>
          <h3>Backup &amp; Restore Assistant</h3>
          <p className="muted">
            Export or restore platform configuration. Secrets remain in the vault and are never
            exported.
          </p>
        </div>
      </div>
      <div className="settings-actions">
        <button
          className="button primary"
          type="button"
          disabled={busy}
          onClick={() => void handleExport()}
        >
          {busy ? "Exporting…" : "Export configuration backup"}
        </button>
      </div>
      <div className="settings-grid">
        <label className="settings-wide">
          Restore configuration from JSON
          <textarea
            className="field mono"
            rows={6}
            value={restoreJson}
            onChange={(event) => setRestoreJson(event.target.value)}
            placeholder="Paste an exported NEXUS configuration backup here."
          />
        </label>
      </div>
      <div className="settings-actions">
        <button
          className="button"
          type="button"
          disabled={busy || restoreJson.trim() === ""}
          onClick={() => void handleRestore()}
        >
          Restore and apply
        </button>
      </div>
      <div className="policy-box" style={{ marginTop: "16px" }}>
        <strong>Complete system backups</strong>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: "11px" }}>
          Database archives and encryption keys require the dedicated authenticated backup workflow;
          they are intentionally excluded from browser exports.
        </p>
      </div>
      {message === null ? null : <p className="banner success">{message}</p>}
      {error === null ? null : <p className="banner error">{error}</p>}
    </section>
  );
}

function SecretsForm({
  api,
  names,
  reload,
}: {
  api: DashboardApi;
  names: string[];
  reload: () => void;
}) {
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = (cause: unknown): void =>
    setError(cause instanceof Error ? cause.message : "Action failed.");
  return (
    <section className="settings-panel">
      <h3>Local secret vault</h3>
      <p className="muted">
        Values are written to the Linux keyring and are never read back by the browser. Only secret
        names appear here.
      </p>
      <div className="settings-grid">
        <label>
          Name
          <input
            className="field mono"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="mcp-token"
          />
        </label>
        <label>
          Secret value
          <input
            className="field mono"
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </label>
      </div>
      <div className="settings-actions">
        <button
          className="button primary"
          type="button"
          disabled={name === "" || secret.length < 4}
          onClick={() => {
            setError(null);
            void api
              .saveSecret(name, secret)
              .then(() => {
                setSecret("");
                setMessage(`Secret ${name} saved.`);
                reload();
              })
              .catch(fail);
          }}
        >
          Save
        </button>
      </div>
      {names.length === 0 ? (
        <p className="empty-state">No secrets stored.</p>
      ) : (
        <ul>
          {names.map((item) => (
            <li key={item}>
              <code>vault://nexus/{item}</code>{" "}
              <button
                className="button danger"
                type="button"
                onClick={() => {
                  if (window.confirm(`Delete secret ${item}?`))
                    void api
                      .removeSecret(item)
                      .then(() => {
                        setMessage(`Secret ${item} deleted.`);
                        reload();
                      })
                      .catch(fail);
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {message === null ? null : <p className="banner success">{message}</p>}
      {error === null ? null : <p className="banner error">{error}</p>}
    </section>
  );
}

function SettingsForm({
  api,
  initial,
  reload,
}: {
  api: DashboardApi;
  initial: RuntimeSettings;
  reload: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const number = (
    key: keyof Pick<
      RuntimeSettings,
      "task_timeout_seconds" | "max_attempts" | "retry_delay_seconds" | "context_budget_chars"
    >,
    next: string,
  ): void => {
    setValue((current) => ({ ...current, [key]: Number(next) }));
  };
  const priorities = (
    key: keyof Pick<
      RuntimeSettings,
      "research_priority" | "review_priority" | "synthesis_priority"
    >,
    next: string,
  ): void => {
    setValue((current) => ({
      ...current,
      [key]: next
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    }));
  };

  return (
    <section className="settings-panel" style={{ marginTop: 0 }}>
      <div className="settings-grid">
        <label>
          Max task timeout · seconds
          <input
            className="field"
            type="number"
            min={10}
            max={86400}
            value={value.task_timeout_seconds}
            onChange={(event) => number("task_timeout_seconds", event.target.value)}
          />
        </label>
        <label>
          Max attempts
          <input
            className="field"
            type="number"
            min={1}
            max={10}
            value={value.max_attempts}
            onChange={(event) => number("max_attempts", event.target.value)}
          />
        </label>
        <label>
          Retry delay · seconds
          <input
            className="field"
            type="number"
            min={1}
            max={3600}
            value={value.retry_delay_seconds}
            onChange={(event) => number("retry_delay_seconds", event.target.value)}
          />
        </label>
        <label>
          Context budget · characters
          <input
            className="field"
            type="number"
            min={4000}
            max={400000}
            value={value.context_budget_chars}
            onChange={(event) => number("context_budget_chars", event.target.value)}
          />
        </label>
        <label className="settings-wide check-label">
          <input
            type="checkbox"
            checked={value.quality_review}
            onChange={(event) =>
              setValue((current) => ({ ...current, quality_review: event.target.checked }))
            }
          />
          Add an independent quality review before final synthesis
        </label>
        <label className="settings-wide">
          Research priority · comma-separated profiles
          <input
            className="field mono"
            value={value.research_priority.join(", ")}
            onChange={(event) => priorities("research_priority", event.target.value)}
          />
        </label>
        <label className="settings-wide">
          Critical review priority
          <input
            className="field mono"
            value={value.review_priority.join(", ")}
            onChange={(event) => priorities("review_priority", event.target.value)}
          />
        </label>
        <label className="settings-wide">
          Final synthesis priority
          <input
            className="field mono"
            value={value.synthesis_priority.join(", ")}
            onChange={(event) => priorities("synthesis_priority", event.target.value)}
          />
        </label>
        <div className="settings-wide policy-box">
          <strong>Non-disableable guardrails</strong>
          <span className="muted">
            ACP execution restricted to workspace, pathless deletion rejected, secrets excluded from
            API responses, live trading disabled, and administrator authentication mandatory.
          </span>
        </div>
      </div>
      <div className="settings-actions">
        <button
          className="button primary"
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            setMessage(null);
            void api
              .updateRuntimeSettings(value)
              .then((saved) => {
                setValue(saved);
                setMessage("Settings saved and applied to upcoming missions.");
                reload();
              })
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "Unable to save settings."),
              )
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {message === null ? null : <p className="banner success">{message}</p>}
      {error === null ? null : <p className="banner error">{error}</p>}
    </section>
  );
}
