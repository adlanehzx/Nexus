import { useEffect, useMemo, useState } from "react";
import type { AgentRegistry, DashboardApi } from "../lib/api.js";

export function Agents({ api }: { api: DashboardApi }) {
  const [registry, setRegistry] = useState<AgentRegistry | null>(null);
  const [selected, setSelected] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [template, setTemplate] = useState("");
  const [newName, setNewName] = useState("");
  const [newKey, setNewKey] = useState("");
  const [model, setModel] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCommand, setEditCommand] = useState("");
  const [editArgs, setEditArgs] = useState("");
  const [editModel, setEditModel] = useState("");
  const [testWorkspace, setTestWorkspace] = useState(
    "/home/adlane/Documents/Codex/2026-10-11/tu-es-un-ing-nieur-senior/work/nexus-audit",
  );
  const [testPrompt, setTestPrompt] = useState("Réponds uniquement NEXUS_ACP_OK");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => {
    setError(null);
    void api
      .agents()
      .then(setRegistry)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Impossible de charger les agents.");
      });
  };

  useEffect(() => {
    setError(null);
    void api
      .agents()
      .then(setRegistry)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Impossible de charger les agents.");
      });
  }, [api]);

  const candidates = useMemo(
    () => registry?.available.filter((agent) => !agent.registered_as) ?? [],
    [registry],
  );
  const templates = useMemo(
    () => registry?.available.filter((agent) => agent.agent_kind === "acp") ?? [],
    [registry],
  );

  const choose = (profileId: string): void => {
    setSelected(profileId);
    const profile = candidates.find((candidate) => candidate.id === profileId);
    setKey(normalizeKey(profile?.name ?? "agent"));
  };

  const register = (): void => {
    if (selected.length === 0 || key.length === 0) return;
    setBusy(true);
    setError(null);
    void api
      .registerAgent({ key, agent_profile_id: selected })
      .then((next) => {
        setRegistry(next);
        setSelected("");
        setKey("");
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Ajout impossible.");
      })
      .finally(() => setBusy(false));
  };

  const create = (): void => {
    if (template.length === 0 || newName.length === 0 || newKey.length === 0) return;
    setBusy(true);
    setError(null);
    void api
      .createAgent({
        key: newKey,
        name: newName,
        template_profile_id: template,
        ...(model.trim().length === 0 ? {} : { model: model.trim() }),
      })
      .then((next) => {
        setRegistry(next);
        setTemplate("");
        setNewName("");
        setNewKey("");
        setModel("");
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Création impossible.");
      })
      .finally(() => setBusy(false));
  };

  const edit = (profileId: string): void => {
    const profile = registry?.available.find((item) => item.id === profileId);
    if (profile === undefined) return;
    setEditing(profileId);
    setEditName(profile.name);
    setEditCommand(profile.command);
    setEditArgs(profile.args.join("\n"));
    setEditModel(profile.model ?? "");
    setTestResult(null);
  };

  const saveProfile = (): void => {
    if (editing === null || editName.trim().length === 0 || editCommand.trim().length === 0) return;
    setBusy(true);
    setError(null);
    void api
      .updateAgentProfile(editing, {
        name: editName.trim(),
        command: editCommand.trim(),
        args: editArgs.split("\n").filter((value) => value.length > 0),
        model: editModel.trim().length === 0 ? null : editModel.trim(),
      })
      .then((next) => {
        setRegistry(next);
        setTestResult("Configuration enregistrée. Une sauvegarde locale a été créée.");
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Enregistrement impossible.");
      })
      .finally(() => setBusy(false));
  };

  const testProfile = (): void => {
    if (editing === null || testWorkspace.trim().length === 0 || testPrompt.trim().length === 0)
      return;
    setBusy(true);
    setError(null);
    setTestResult("Test ACP en cours…");
    void api
      .testAgentProfile(editing, {
        workspace: testWorkspace.trim(),
        prompt: testPrompt.trim(),
        timeout_seconds: 120,
      })
      .then((result) => setTestResult(result.response))
      .catch((cause: unknown) => {
        setTestResult(null);
        setError(cause instanceof Error ? cause.message : "Test ACP impossible.");
      })
      .finally(() => setBusy(false));
  };

  const disable = (keyToDisable: string): void => {
    if (!window.confirm(`Désactiver ${keyToDisable} pour les nouvelles missions ?`)) return;
    setBusy(true);
    setError(null);
    void api
      .disableAgent(keyToDisable)
      .then((next) => {
        setRegistry(next);
        setEditing(null);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Désactivation impossible.");
      })
      .finally(() => setBusy(false));
  };

  return (
    <section className="agents-page contenu">
      <div className="agents-heading">
        <div>
          <h2>Agents</h2>
          <p className="faible">
            Les profils que l’orchestrateur peut sélectionner pour tes missions.
          </p>
        </div>
        <button className="bouton" type="button" onClick={refresh}>
          Actualiser
        </button>
      </div>

      {error !== null ? <div className="banniere erreur">{error}</div> : null}
      {registry === null ? <div className="vide">Chargement du registre…</div> : null}

      <div className="agent-grid">
        {registry?.configured.map((agent) => {
          const profile = registry.available.find((item) => item.id === agent.agent_profile_id);
          const state =
            agent.running_tasks > 0
              ? "active"
              : ["auth_required", "quota_exhausted", "cooldown", "degraded"].includes(
                    agent.status,
                  ) || agent.last_task_state === "failed"
                ? "attention"
                : "idle";
          return (
            <article className="agent-card" key={agent.key}>
              <div className="agent-card-top">
                <div className={`agent-avatar ${state}`}>{agent.key.slice(0, 1).toUpperCase()}</div>
                <div>
                  <h3>{agent.key}</h3>
                  <div className="faible">
                    {profile?.name ?? "Profil NEXUS"} · {profile?.agent_kind ?? "ACP"}
                  </div>
                </div>
                <span className={`agent-status ${state}`}>
                  {state === "active" ? "En mission" : healthLabel(agent.status)}
                </span>
              </div>
              <div className="agent-stats">
                <span>
                  <strong>{agent.running_tasks}</strong> active
                </span>
                <span>
                  <strong>{agent.queued_tasks}</strong> en attente
                </span>
                <span>
                  <strong>{agent.last_task_state ?? "—"}</strong> dernier état
                </span>
                <span>
                  <strong>{percent(agent.remaining_5h_percent)}</strong> fenêtre 5 h
                </span>
                <span>
                  <strong>{percent(agent.remaining_week_percent)}</strong> semaine
                </span>
              </div>
              <div className="agent-card-actions">
                <button className="bouton" type="button" onClick={() => edit(agent.agent_profile_id)}>
                  Configurer
                </button>
                <button
                  className="bouton danger"
                  type="button"
                  disabled={busy || agent.running_tasks > 0}
                  onClick={() => disable(agent.key)}
                >
                  Désactiver
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {editing === null ? null : (
        <section className="settings-panel">
          <div className="settings-panel-heading">
            <div>
              <h3>Configuration ACP · {editing}</h3>
              <p className="faible">
                Les modifications sont persistantes et sauvegardées. Les identifiants restent dans
                les trousseaux des CLI et ne sont jamais affichés ici.
              </p>
            </div>
            <button className="bouton" type="button" onClick={() => setEditing(null)}>
              Fermer
            </button>
          </div>

          <div className="settings-grid">
            <label>
              Nom visible
              <input className="champ" value={editName} onChange={(event) => setEditName(event.target.value)} />
            </label>
            <label>
              Modèle ACP
              <input
                className="champ"
                value={editModel}
                placeholder="Modèle par défaut de l’adaptateur"
                onChange={(event) => setEditModel(event.target.value.slice(0, 200))}
              />
            </label>
            <label className="settings-wide">
              Commande
              <input
                className="champ mono"
                value={editCommand}
                onChange={(event) => setEditCommand(event.target.value)}
              />
            </label>
            <label className="settings-wide">
              Arguments · un argument par ligne
              <textarea
                className="champ mono settings-textarea"
                value={editArgs}
                onChange={(event) => setEditArgs(event.target.value)}
              />
            </label>
            <div className="settings-wide policy-box">
              <strong>Permissions : espace de travail uniquement</strong>
              <span className="faible">
                Écriture autorisée dans le workspace de la mission. Les suppressions sans chemin et
                les accès extérieurs sont refusés. Cette protection n’est pas désactivable.
              </span>
            </div>
          </div>

          <div className="settings-actions">
            <button className="bouton primary" type="button" disabled={busy} onClick={saveProfile}>
              Enregistrer
            </button>
          </div>

          <h3>Test de connexion réel</h3>
          <div className="settings-grid">
            <label className="settings-wide">
              Workspace du test
              <input
                className="champ mono"
                value={testWorkspace}
                onChange={(event) => setTestWorkspace(event.target.value)}
              />
            </label>
            <label className="settings-wide">
              Message de test
              <input className="champ" value={testPrompt} onChange={(event) => setTestPrompt(event.target.value)} />
            </label>
          </div>
          <div className="settings-actions">
            <button className="bouton" type="button" disabled={busy} onClick={testProfile}>
              Tester l’agent
            </button>
          </div>
          {testResult === null ? null : <pre className="test-result">{testResult}</pre>}
        </section>
      )}

      <div className="agent-add">
        <div>
          <h3>Créer un agent ACP dans NEXUS</h3>
          <p className="faible">
            Pars d’un adaptateur ACP déjà sécurisé. NEXUS crée le profil et l’ajoute directement à
            l’orchestrateur, sans demander tes identifiants fournisseur.
          </p>
        </div>
        <div className="agent-create-form">
          <select
            className="champ"
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
          >
            <option value="">Type d’agent…</option>
            {templates.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <input
            className="champ"
            value={newName}
            placeholder="Nom du profil"
            onChange={(event) => {
              const value = normalizeProfileName(event.target.value);
              setNewName(value);
              setNewKey(normalizeKey(value));
            }}
          />
          <input
            className="champ"
            value={newKey}
            placeholder="nom-nexus"
            onChange={(event) => setNewKey(normalizeKey(event.target.value))}
          />
          <input
            className="champ"
            value={model}
            placeholder="Modèle optionnel"
            onChange={(event) => setModel(event.target.value.slice(0, 200))}
          />
          <button
            className="bouton primary"
            type="button"
            disabled={busy || template.length === 0 || newName.length === 0 || newKey.length === 0}
            onClick={create}
          >
            {busy ? "Création…" : "Créer et ajouter"}
          </button>
        </div>
      </div>

      <div className="agent-add secondary">
        <div>
          <h3>Importer un profil ACP existant</h3>
          <p className="faible">Pour un adaptateur personnalisé déjà configuré dans NEXUS.</p>
        </div>
        {candidates.length === 0 ? (
          <div className="faible">Tous les profils ACP disponibles sont déjà enregistrés.</div>
        ) : (
          <div className="agent-add-form">
            <select
              className="champ"
              value={selected}
              onChange={(event) => choose(event.target.value)}
            >
              <option value="">Choisir un profil ACP…</option>
              {candidates.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {agent.agent_kind}
                </option>
              ))}
            </select>
            <input
              className="champ"
              value={key}
              placeholder="nom-court"
              pattern="[a-z][a-z0-9_-]{0,63}"
              onChange={(event) => setKey(normalizeKey(event.target.value))}
            />
            <button
              className="bouton primary"
              type="button"
              disabled={busy || selected.length === 0 || key.length === 0}
              onClick={register}
            >
              {busy ? "Ajout…" : "Ajouter à NEXUS"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 64);
}

function normalizeProfileName(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
}

function percent(value: number | null): string {
  return value === null ? "inconnu" : `${value} %`;
}

function healthLabel(status: AgentRegistry["configured"][number]["status"]): string {
  switch (status) {
    case "available":
      return "Disponible";
    case "degraded":
      return "Dégradé";
    case "cooldown":
      return "En pause";
    case "quota_exhausted":
      return "Quota atteint";
    case "auth_required":
      return "Connexion requise";
    default:
      return "Non mesuré";
  }
}
