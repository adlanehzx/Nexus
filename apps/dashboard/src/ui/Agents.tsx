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
              : agent.last_task_state === "failed"
                ? "attention"
                : "idle";
          return (
            <article className="agent-card" key={agent.key}>
              <div className="agent-card-top">
                <div className={`agent-avatar ${state}`}>{agent.key.slice(0, 1).toUpperCase()}</div>
                <div>
                  <h3>{agent.key}</h3>
                  <div className="faible">
                    {profile?.name ?? "Profil OpenHands"} · {profile?.agent_kind ?? "ACP"}
                  </div>
                </div>
                <span className={`agent-status ${state}`}>
                  {state === "active"
                    ? "En mission"
                    : state === "attention"
                      ? "À vérifier"
                      : "Disponible"}
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
              </div>
            </article>
          );
        })}
      </div>

      <div className="agent-add">
        <div>
          <h3>Créer un agent ACP dans NEXUS</h3>
          <p className="faible">
            Pars d’un adaptateur déjà sécurisé. NEXUS crée le profil OpenHands et l’ajoute
            directement à l’orchestrateur, sans demander ta clé OpenHands.
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
          <h3>Importer un profil OpenHands existant</h3>
          <p className="faible">Pour un adaptateur personnalisé déjà configuré dans OpenHands.</p>
        </div>
        {candidates.length === 0 ? (
          <div className="faible">
            Tous les profils OpenHands disponibles sont déjà enregistrés.
          </div>
        ) : (
          <div className="agent-add-form">
            <select
              className="champ"
              value={selected}
              onChange={(event) => choose(event.target.value)}
            >
              <option value="">Choisir un profil OpenHands…</option>
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
