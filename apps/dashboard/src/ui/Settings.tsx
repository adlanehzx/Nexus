import { useState } from "react";
import type { DashboardApi, RuntimeSettings } from "../lib/api.js";
import { Section, useSection } from "./parts.js";

export function Settings({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.runtimeSettings());
  const secrets = useSection(() => api.secrets());

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
    </div>
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
