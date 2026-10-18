import { useState } from "react";
import type { DashboardApi, RuntimeSettings } from "../lib/api.js";
import { Section, useSection } from "./parts.js";

export function Settings({ api }: { api: DashboardApi }) {
  const state = useSection(() => api.runtimeSettings());
  const secrets = useSection(() => api.secrets());

  return (
    <div className="contenu settings-page">
      <div className="agents-heading">
        <div>
          <h2>Configuration</h2>
          <p className="faible">Paramètres persistants du moteur multi-agents NEXUS.</p>
        </div>
        <button className="bouton" type="button" onClick={state.reload}>
          Actualiser
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
    setError(cause instanceof Error ? cause.message : "Action impossible.");
  return (
    <section className="settings-panel">
      <h3>Coffre de secrets local</h3>
      <p className="faible">
        Les valeurs sont écrites dans le trousseau Linux et ne sont jamais relues par le navigateur.
        Seuls les noms apparaissent ici.
      </p>
      <div className="settings-grid">
        <label>
          Nom
          <input
            className="champ mono"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="mcp-token"
          />
        </label>
        <label>
          Valeur secrète
          <input
            className="champ mono"
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </label>
      </div>
      <div className="settings-actions">
        <button
          className="bouton primary"
          type="button"
          disabled={name === "" || secret.length < 4}
          onClick={() => {
            setError(null);
            void api
              .saveSecret(name, secret)
              .then(() => {
                setSecret("");
                setMessage(`Secret ${name} enregistré.`);
                reload();
              })
              .catch(fail);
          }}
        >
          Enregistrer
        </button>
      </div>
      {names.length === 0 ? (
        <p className="vide">Aucun secret enregistré.</p>
      ) : (
        <ul>
          {names.map((item) => (
            <li key={item}>
              <code>vault://nexus/{item}</code>{" "}
              <button
                className="bouton danger"
                type="button"
                onClick={() => {
                  if (window.confirm(`Supprimer le secret ${item} ?`))
                    void api
                      .removeSecret(item)
                      .then(() => {
                        setMessage(`Secret ${item} supprimé.`);
                        reload();
                      })
                      .catch(fail);
                }}
              >
                Supprimer
              </button>
            </li>
          ))}
        </ul>
      )}
      {message === null ? null : <p className="banniere succes">{message}</p>}
      {error === null ? null : <p className="banniere erreur">{error}</p>}
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
          Délai maximal d’une tâche · secondes
          <input
            className="champ"
            type="number"
            min={10}
            max={86400}
            value={value.task_timeout_seconds}
            onChange={(event) => number("task_timeout_seconds", event.target.value)}
          />
        </label>
        <label>
          Nombre maximal de tentatives
          <input
            className="champ"
            type="number"
            min={1}
            max={10}
            value={value.max_attempts}
            onChange={(event) => number("max_attempts", event.target.value)}
          />
        </label>
        <label>
          Délai entre tentatives · secondes
          <input
            className="champ"
            type="number"
            min={1}
            max={3600}
            value={value.retry_delay_seconds}
            onChange={(event) => number("retry_delay_seconds", event.target.value)}
          />
        </label>
        <label>
          Budget de contexte · caractères
          <input
            className="champ"
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
          Ajouter une revue qualité indépendante avant la synthèse finale
        </label>
        <label className="settings-wide">
          Priorité recherche · profils séparés par des virgules
          <input
            className="champ mono"
            value={value.research_priority.join(", ")}
            onChange={(event) => priorities("research_priority", event.target.value)}
          />
        </label>
        <label className="settings-wide">
          Priorité revue critique
          <input
            className="champ mono"
            value={value.review_priority.join(", ")}
            onChange={(event) => priorities("review_priority", event.target.value)}
          />
        </label>
        <label className="settings-wide">
          Priorité synthèse finale
          <input
            className="champ mono"
            value={value.synthesis_priority.join(", ")}
            onChange={(event) => priorities("synthesis_priority", event.target.value)}
          />
        </label>
        <div className="settings-wide policy-box">
          <strong>Garde-fous non désactivables</strong>
          <span className="faible">
            Exécution ACP limitée au workspace, suppression sans chemin refusée, secrets absents des
            réponses API, trading réel désactivé et authentification administrateur obligatoire.
          </span>
        </div>
      </div>
      <div className="settings-actions">
        <button
          className="bouton primary"
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
                setMessage("Configuration enregistrée et appliquée aux prochaines missions.");
                reload();
              })
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "Enregistrement impossible."),
              )
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Enregistrement…" : "Enregistrer"}
        </button>
      </div>
      {message === null ? null : <p className="banniere succes">{message}</p>}
      {error === null ? null : <p className="banniere erreur">{error}</p>}
    </section>
  );
}
