import { useEffect, useMemo, useState } from "react";
import type { AgentRegistry, DashboardApi, ProviderAccountDto } from "../lib/api.js";

export function Agents({ api }: { api: DashboardApi }) {
  const [registry, setRegistry] = useState<AgentRegistry | null>(null);
  const [accounts, setAccounts] = useState<ProviderAccountDto[]>([]);
  const [accountFeedback, setAccountFeedback] = useState<string | null>(null);
  const [accActionLoading, setAccActionLoading] = useState(false);
  const [newAccId, setNewAccId] = useState("");
  const [newAccProvider, setNewAccProvider] = useState("antigravity");
  const [newAccName, setNewAccName] = useState("");
  const [newAccPriority, setNewAccPriority] = useState(2);
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
  const [editSystemPrompt, setEditSystemPrompt] = useState("");
  const [editReasoning, setEditReasoning] = useState("");
  const [editAdditionalDirs, setEditAdditionalDirs] = useState("");
  const [editConfigOptions, setEditConfigOptions] = useState("{}");
  const [testWorkspace, setTestWorkspace] = useState(
    "/home/adlane/Documents/Codex/2026-10-11/tu-es-un-ing-nieur-senior/work/nexus-audit",
  );
  const [testPrompt, setTestPrompt] = useState("Réponds uniquement NEXUS_ACP_OK");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshAccounts = (): void => {
    void api
      .providerAccounts()
      .then((res) => setAccounts(res.accounts))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Impossible de charger les comptes.");
      });
  };

  const refresh = (): void => {
    setError(null);
    void api
      .agents()
      .then(setRegistry)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Impossible de charger les agents.");
      });
    refreshAccounts();
  };

  useEffect(() => {
    setError(null);
    void api
      .agents()
      .then(setRegistry)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Impossible de charger les agents.");
      });
    refreshAccounts();
  }, [api]);

  const handleTestAccount = async (id: string): Promise<void> => {
    setAccActionLoading(true);
    setAccountFeedback(null);
    try {
      const res = await api.testProviderAccount(id);
      setAccountFeedback(`Identité "${res.id}" testée : statut "${res.authStatus}"`);
      refreshAccounts();
    } catch (err) {
      setAccountFeedback(`Échec du test : ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAccActionLoading(false);
    }
  };

  const handleToggleCooldown = async (id: string, currentlyActive: boolean): Promise<void> => {
    setAccActionLoading(true);
    setAccountFeedback(null);
    try {
      await api.toggleProviderAccountCooldown(id, !currentlyActive, 300, "Pause manuelle");
      setAccountFeedback(
        !currentlyActive ? `Pause activée sur "${id}" (5 min)` : `Pause levée sur "${id}"`,
      );
      refreshAccounts();
    } catch (err) {
      setAccountFeedback(`Erreur : ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAccActionLoading(false);
    }
  };

  const handleCreateAccount = async (): Promise<void> => {
    if (!newAccId.trim() || !newAccName.trim()) return;
    setAccActionLoading(true);
    setAccountFeedback(null);
    try {
      await api.createProviderAccount({
        id: newAccId.trim(),
        provider: newAccProvider,
        name: newAccName.trim(),
        profileKey: newAccProvider,
        priority: newAccPriority,
      });
      setAccountFeedback(`Identité "${newAccId.trim()}" créée.`);
      setNewAccId("");
      setNewAccName("");
      refreshAccounts();
    } catch (err) {
      setAccountFeedback(`Erreur création : ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAccActionLoading(false);
    }
  };

  const handleDeleteAccount = async (id: string): Promise<void> => {
    setAccActionLoading(true);
    setAccountFeedback(null);
    try {
      await api.deleteProviderAccount(id);
      setAccountFeedback(`Identité "${id}" supprimée.`);
      refreshAccounts();
    } catch (err) {
      setAccountFeedback(
        `Erreur suppression : ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setAccActionLoading(false);
    }
  };

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
    setEditSystemPrompt(profile.system_prompt);
    setEditReasoning(profile.reasoning_effort ?? "");
    setEditAdditionalDirs(profile.additional_dirs.join("\n"));
    setEditConfigOptions(JSON.stringify(profile.config_options, null, 2));
    setTestResult(null);
  };

  const saveProfile = (): void => {
    if (editing === null || editName.trim().length === 0 || editCommand.trim().length === 0) return;
    let configOptions: Record<string, string>;
    try {
      configOptions = JSON.parse(editConfigOptions) as Record<string, string>;
    } catch {
      setError("Les options ACP doivent être un objet JSON.");
      return;
    }
    setBusy(true);
    setError(null);
    void api
      .updateAgentProfile(editing, {
        name: editName.trim(),
        command: editCommand.trim(),
        args: editArgs.split("\n").filter((value) => value.length > 0),
        model: editModel.trim().length === 0 ? null : editModel.trim(),
        system_prompt: editSystemPrompt,
        reasoning_effort:
          editReasoning === ""
            ? null
            : (editReasoning as "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"),
        additional_dirs: editAdditionalDirs
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean),
        config_options: configOptions,
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
                <button
                  className="bouton"
                  type="button"
                  onClick={() => edit(agent.agent_profile_id)}
                >
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
              <input
                className="champ"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
              />
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
            <label>
              Effort de raisonnement
              <select
                className="champ"
                value={editReasoning}
                onChange={(event) => setEditReasoning(event.target.value)}
              >
                <option value="">Valeur par défaut</option>
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
                <option value="max">max</option>
                <option value="ultra">ultra</option>
              </select>
            </label>
            <label className="settings-wide">
              Prompt système propre à cet agent
              <textarea
                className="champ settings-textarea"
                value={editSystemPrompt}
                onChange={(event) => setEditSystemPrompt(event.target.value.slice(0, 32_000))}
              />
            </label>
            <label className="settings-wide">
              Dossiers supplémentaires autorisés · chemins absolus, un par ligne
              <textarea
                className="champ mono"
                rows={3}
                value={editAdditionalDirs}
                onChange={(event) => setEditAdditionalDirs(event.target.value)}
              />
            </label>
            <label className="settings-wide">
              Options ACP avancées · JSON, appliquées seulement si l’adaptateur les annonce
              <textarea
                className="champ mono"
                rows={4}
                value={editConfigOptions}
                onChange={(event) => setEditConfigOptions(event.target.value)}
              />
            </label>
            <div className="settings-wide policy-box">
              <strong>Permissions : workspace + dossiers explicitement autorisés</strong>
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
              <input
                className="champ"
                value={testPrompt}
                onChange={(event) => setTestPrompt(event.target.value)}
              />
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

      {/* ── Gestion multi-comptes fournisseurs (Chantier 12) ── */}
      <div className="settings-panel" style={{ marginTop: "28px" }}>
        <div className="settings-panel-heading">
          <div>
            <h3>Comptes Fournisseurs & Identités Isolées</h3>
            <p className="faible">
              Gestion multi-comptes (Antigravity, Claude, Codex) avec sessions CLI locales étanches,
              suivi d'authentification, quotas, cooldowns et fiabilité.
            </p>
          </div>
        </div>

        {accountFeedback !== null ? (
          <div className="banniere succes" style={{ marginBottom: "16px" }}>
            {accountFeedback}
          </div>
        ) : null}

        <div className="agent-grid" style={{ marginBottom: "20px" }}>
          {accounts.map((acc) => {
            const isCooldown = acc.cooldown.active;
            const isExhausted = acc.quotas.exhausted;
            const isAuthOk = acc.authStatus === "authenticated";
            const statusClass = isCooldown
              ? "attention"
              : isExhausted
                ? "attention"
                : isAuthOk
                  ? "active"
                  : "idle";
            const statusLabel = isCooldown
              ? "En pause"
              : isExhausted
                ? "Quota atteint"
                : isAuthOk
                  ? "Authentifié"
                  : acc.authStatus === "expired"
                    ? "Expiré"
                    : "Non vérifié";

            return (
              <article className="agent-card" key={acc.id}>
                <div className="agent-card-top">
                  <div className={`agent-avatar ${statusClass}`}>
                    {acc.provider.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <h3>{acc.name}</h3>
                    <div className="faible">
                      {acc.id} · Priorité P{acc.priority}
                    </div>
                  </div>
                  <span className={`agent-status ${statusClass}`}>{statusLabel}</span>
                </div>

                <div className="agent-stats">
                  <span>
                    <strong>{Math.round(acc.reliability.score * 100)} %</strong> fiabilité (
                    {acc.reliability.successCount}/{acc.reliability.totalRuns})
                  </span>
                  <span>
                    <strong>{acc.reliability.consecutiveFailures}</strong> erreurs conséc.
                  </span>
                  <span>
                    <strong>{acc.cooldown.active ? "Actif" : "Non"}</strong> cooldown
                  </span>
                </div>

                {acc.cooldown.reason ? (
                  <div
                    className="faible"
                    style={{ marginTop: "8px", fontSize: "11px", color: "var(--degrade)" }}
                  >
                    Raison cooldown : {acc.cooldown.reason}
                  </div>
                ) : null}

                <div className="agent-card-actions">
                  <button
                    className="bouton"
                    type="button"
                    disabled={accActionLoading}
                    onClick={() => void handleTestAccount(acc.id)}
                  >
                    Tester connexion
                  </button>
                  <button
                    className="bouton"
                    type="button"
                    disabled={accActionLoading}
                    onClick={() => void handleToggleCooldown(acc.id, acc.cooldown.active)}
                  >
                    {acc.cooldown.active ? "Lever pause" : "Mettre en pause"}
                  </button>
                  {!["antigravity-personnel", "claude-principal", "codex-principal"].includes(
                    acc.id,
                  ) ? (
                    <button
                      className="bouton danger"
                      type="button"
                      disabled={accActionLoading}
                      onClick={() => void handleDeleteAccount(acc.id)}
                    >
                      Supprimer
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>

        <div className="agent-add" style={{ marginTop: "16px" }}>
          <div>
            <h3>Ajouter une identité fournisseur</h3>
            <p className="faible">Ex: antigravity-secondaire, claude-backup, codex-dev.</p>
          </div>
          <div className="agent-add-form">
            <select
              className="champ"
              value={newAccProvider}
              onChange={(e) => {
                setNewAccProvider(e.target.value);
                if (!newAccId) setNewAccId(`${e.target.value}-secondaire`);
              }}
            >
              <option value="antigravity">Antigravity (Google AI Pro)</option>
              <option value="claude">Claude (Abonnement Claude Pro)</option>
              <option value="codex">Codex (Abonnement ChatGPT Plus)</option>
            </select>
            <input
              className="champ"
              value={newAccId}
              placeholder="identifiant-unique"
              onChange={(e) => setNewAccId(normalizeKey(e.target.value))}
            />
            <input
              className="champ"
              value={newAccName}
              placeholder="Nom complet (ex: Claude Backup)"
              onChange={(e) => setNewAccName(e.target.value)}
            />
            <input
              className="champ"
              type="number"
              min={1}
              max={10}
              value={newAccPriority}
              style={{ width: "80px" }}
              title="Priorité (1 = haute priorité)"
              onChange={(e) => setNewAccPriority(Number(e.target.value) || 1)}
            />
            <button
              className="bouton primary"
              type="button"
              disabled={accActionLoading || !newAccId.trim() || !newAccName.trim()}
              onClick={() => void handleCreateAccount()}
            >
              {accActionLoading ? "Création…" : "Créer l'identité"}
            </button>
          </div>
        </div>
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
