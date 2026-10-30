import { useEffect, useMemo, useState } from "react";
import type {
  AgentRegistry,
  AgentRoutingEntry,
  DashboardApi,
  ProviderAccountDto,
  RoutingEvaluationDto,
} from "../lib/api.js";
import { useI18n } from "./i18n/index.js";
import { IconStar } from "./icons.js";

export function Agents({ api }: { api: DashboardApi }) {
  const { locale, t, tr } = useI18n();
  const [registry, setRegistry] = useState<AgentRegistry | null>(null);
  const [accounts, setAccounts] = useState<ProviderAccountDto[]>([]);
  const [accountFeedback, setAccountFeedback] = useState<string | null>(null);
  const [accActionLoading, setAccActionLoading] = useState(false);
  const [newAccId, setNewAccId] = useState("");
  const [newAccProvider, setNewAccProvider] = useState("antigravity");
  const [newAccName, setNewAccName] = useState("");
  const [newAccPriority, setNewAccPriority] = useState(2);
  const [routingMatrix, setRoutingMatrix] = useState<AgentRoutingEntry[]>([]);
  const [testRoutingInstruction, setTestRoutingInstruction] = useState("");
  const [routingEvaluation, setRoutingEvaluation] = useState<RoutingEvaluationDto | null>(null);
  const [routingLoading, setRoutingLoading] = useState(false);
  const [routingResetMsg, setRoutingResetMsg] = useState<string | null>(null);
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
  const [testWorkspace, setTestWorkspace] = useState("");
  const [testPrompt, setTestPrompt] = useState("Reply only NEXUS_ACP_OK");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [editingAccId, setEditingAccId] = useState<string | null>(null);
  const [editingAccName, setEditingAccName] = useState("");
  const [editingAccPriority, setEditingAccPriority] = useState(2);

  const refreshRouting = (): void => {
    void api
      .routingMatrix()
      .then((res) => setRoutingMatrix(res.matrix))
      .catch((cause: unknown) => {
        console.warn(
          "Routing matrix fetch skipped:",
          cause instanceof Error ? cause.message : cause,
        );
      });
  };

  const refreshAccounts = (): void => {
    void api
      .providerAccounts()
      .then((res) => setAccounts(res.accounts))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Unable to load provider accounts.");
      });
  };

  const refresh = (): void => {
    setError(null);
    void api
      .agents()
      .then(setRegistry)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Unable to load agents.");
      });
    refreshAccounts();
    refreshRouting();
  };

  useEffect(() => {
    setError(null);
    void api
      .agents()
      .then(setRegistry)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Unable to load agents.");
      });
    refreshAccounts();
    refreshRouting();
  }, [api]);

  const handleEvaluateRouting = async (): Promise<void> => {
    if (!testRoutingInstruction.trim()) return;
    setRoutingLoading(true);
    try {
      const res = await api.evaluateRouting(testRoutingInstruction.trim());
      setRoutingEvaluation(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Routing evaluation error.");
    } finally {
      setRoutingLoading(false);
    }
  };

  const handleResetRouting = async (): Promise<void> => {
    if (
      !window.confirm(
        tr(
          "Reset routing learning history?",
          "Réinitialiser l'historique d'apprentissage du routage ?",
        ),
      )
    )
      return;
    try {
      await api.resetRoutingStats();
      setRoutingResetMsg(tr("History reset.", "Historique réinitialisé."));
      refreshRouting();
      setTimeout(() => setRoutingResetMsg(null), 3000);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : tr("Error during reset.", "Erreur lors de la réinitialisation."),
      );
    }
  };

  const handleTestAccount = async (id: string): Promise<void> => {
    setAccActionLoading(true);
    setAccountFeedback(null);
    try {
      const res = await api.testProviderAccount(id);
      setAccountFeedback(
        tr(
          `Identity "${res.id}" tested: status "${res.authStatus}"`,
          `Identité "${res.id}" testée : statut "${res.authStatus}"`,
        ),
      );
      refreshAccounts();
    } catch (err) {
      setAccountFeedback(
        `${tr("Test failed:", "Échec du test :")} ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setAccActionLoading(false);
    }
  };

  const handleToggleCooldown = async (id: string, currentlyActive: boolean): Promise<void> => {
    setAccActionLoading(true);
    setAccountFeedback(null);
    try {
      await api.toggleProviderAccountCooldown(id, !currentlyActive, 300, "Manual pause");
      setAccountFeedback(
        !currentlyActive
          ? tr(`Cooldown enabled on "${id}" (5 min)`, `Refroidissement activé sur "${id}" (5 min)`)
          : tr(`Cooldown lifted on "${id}"`, `Refroidissement levé sur "${id}"`),
      );
      refreshAccounts();
    } catch (err) {
      setAccountFeedback(`Error: ${err instanceof Error ? err.message : String(err)}`);
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
      setAccountFeedback(`Identity "${newAccId.trim()}" created.`);
      setNewAccId("");
      setNewAccName("");
      refreshAccounts();
    } catch (err) {
      setAccountFeedback(`Creation error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAccActionLoading(false);
    }
  };

  const handleSaveAccount = async (id: string): Promise<void> => {
    if (!editingAccName.trim()) return;
    setAccActionLoading(true);
    setAccountFeedback(null);
    try {
      await api.updateProviderAccount(id, {
        name: editingAccName.trim(),
        priority: editingAccPriority,
      });
      setAccountFeedback(`Identity "${id}" updated.`);
      setEditingAccId(null);
      refreshAccounts();
    } catch (err) {
      setAccountFeedback(`Update error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAccActionLoading(false);
    }
  };

  const handleDeleteAccount = async (id: string): Promise<void> => {
    if (
      !window.confirm(
        `Permanently revoke and delete account "${id}"?\n\nData impact: This identity will be permanently removed from agent routing and cannot be used for subsequent tasks.`,
      )
    ) {
      return;
    }
    setAccActionLoading(true);
    setAccountFeedback(null);
    try {
      await api.deleteProviderAccount(id);
      setAccountFeedback(`Identity "${id}" revoked and deleted.`);
      refreshAccounts();
    } catch (err) {
      setAccountFeedback(`Deletion error: ${err instanceof Error ? err.message : String(err)}`);
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
        setError(cause instanceof Error ? cause.message : "Unable to add agent.");
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
        setError(cause instanceof Error ? cause.message : "Unable to create agent.");
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
      setError("ACP options must be a JSON object.");
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
        setTestResult("Configuration saved. A local backup was created.");
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Unable to save.");
      })
      .finally(() => setBusy(false));
  };

  const testProfile = (): void => {
    if (editing === null || testWorkspace.trim().length === 0 || testPrompt.trim().length === 0)
      return;
    setBusy(true);
    setError(null);
    setTestResult("Testing ACP…");
    void api
      .testAgentProfile(editing, {
        workspace: testWorkspace.trim(),
        prompt: testPrompt.trim(),
        timeout_seconds: 120,
      })
      .then((result) => setTestResult(result.response))
      .catch((cause: unknown) => {
        setTestResult(null);
        setError(cause instanceof Error ? cause.message : "ACP test failed.");
      })
      .finally(() => setBusy(false));
  };

  const disable = (keyToDisable: string): void => {
    if (!window.confirm(`Disable ${keyToDisable} for new missions?`)) return;
    setBusy(true);
    setError(null);
    void api
      .disableAgent(keyToDisable)
      .then((next) => {
        setRegistry(next);
        setEditing(null);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Unable to disable agent.");
      })
      .finally(() => setBusy(false));
  };

  return (
    <section className="agents-page content">
      <div className="agents-heading">
        <div>
          <h2>{locale === "fr" ? "Agents" : "Agents"}</h2>
          <p className="muted">
            {locale === "fr"
              ? "Profils d'agents disponibles que l'orchestrateur sélectionne pour vos missions."
              : "Profiles available for the orchestrator to select for your missions."}
          </p>
        </div>
        <button className="button" type="button" onClick={refresh}>
          {t("common.actions.refresh")}
        </button>
      </div>

      {error !== null ? <div className="banner error">{error}</div> : null}
      {registry === null ? <div className="empty-state">Loading registry…</div> : null}

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
                  <div className="muted">
                    {profile?.name ?? "NEXUS Profile"} · {profile?.agent_kind ?? "ACP"}
                  </div>
                </div>
                <span className={`agent-status ${state}`}>
                  {state === "active"
                    ? tr("On mission", "En mission")
                    : healthLabel(agent.status, tr)}
                </span>
              </div>
              <div className="agent-stats">
                <span>
                  <strong>{agent.running_tasks}</strong> {tr("active", "actives")}
                </span>
                <span>
                  <strong>{agent.queued_tasks}</strong> {tr("queued", "en attente")}
                </span>
                <span>
                  <strong>{agent.last_task_state ?? "—"}</strong> {tr("last state", "dernier état")}
                </span>
                <span>
                  <strong>{percent(agent.remaining_5h_percent)}</strong>{" "}
                  {tr("5h window", "fenêtre 5h")}
                </span>
                <span>
                  <strong>{percent(agent.remaining_week_percent)}</strong> {tr("week", "semaine")}
                </span>
              </div>
              <div className="agent-card-actions">
                <button
                  className="button"
                  type="button"
                  onClick={() => edit(agent.agent_profile_id)}
                >
                  {tr("Configure", "Configurer")}
                </button>
                <button
                  className="button danger"
                  type="button"
                  disabled={busy || agent.running_tasks > 0}
                  onClick={() => disable(agent.key)}
                >
                  {tr("Disable", "Désactiver")}
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
              <h3>{tr("ACP Settings", "Paramètres ACP")} · {editing}</h3>
              <p className="muted">
                {tr(
                  "Modifications are persistent and saved. Credentials remain in CLI keyrings and are never displayed here.",
                  "Les modifications sont persistantes et enregistrées. Les identifiants restent dans les trousseaux CLI et ne sont jamais affichés ici.",
                )}
              </p>
            </div>
            <button className="button" type="button" onClick={() => setEditing(null)}>
              {tr("Close", "Fermer")}
            </button>
          </div>

          <div className="settings-grid">
            <label>
              {tr("Display name", "Nom d'affichage")}
              <input
                className="field"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
              />
            </label>
            <label>
              {tr("ACP model", "Modèle ACP")}
              <input
                className="field"
                value={editModel}
                placeholder={tr("Default adapter model", "Modèle par défaut de l'adaptateur")}
                onChange={(event) => setEditModel(event.target.value.slice(0, 200))}
              />
            </label>
            <label className="settings-wide">
              {tr("Command", "Commande")}
              <input
                className="field mono"
                value={editCommand}
                onChange={(event) => setEditCommand(event.target.value)}
              />
            </label>
            <label className="settings-wide">
              {tr("Arguments · one per line", "Arguments · un par ligne")}
              <textarea
                className="field mono settings-textarea"
                value={editArgs}
                onChange={(event) => setEditArgs(event.target.value)}
              />
            </label>
            <label>
              {tr("Reasoning effort", "Effort de raisonnement")}
              <select
                className="field"
                value={editReasoning}
                onChange={(event) => setEditReasoning(event.target.value)}
              >
                <option value="">{tr("Default value", "Valeur par défaut")}</option>
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
              {tr(
                "System prompt specific to this agent",
                "Invite système spécifique à cet agent",
              )}
              <textarea
                className="field settings-textarea"
                value={editSystemPrompt}
                onChange={(event) => setEditSystemPrompt(event.target.value.slice(0, 32_000))}
              />
            </label>
            <label className="settings-wide">
              {tr(
                "Additional allowed directories · absolute paths, one per line",
                "Répertoires autorisés supplémentaires · chemins absolus, un par ligne",
              )}
              <textarea
                className="field mono"
                rows={3}
                value={editAdditionalDirs}
                onChange={(event) => setEditAdditionalDirs(event.target.value)}
              />
            </label>
            <label className="settings-wide">
              {tr(
                "Advanced ACP options · JSON, applied only if supported by adapter",
                "Options ACP avancées · JSON, appliquées si supportées par l'adaptateur",
              )}
              <textarea
                className="field mono"
                rows={4}
                value={editConfigOptions}
                onChange={(event) => setEditConfigOptions(event.target.value)}
              />
            </label>
            <div className="settings-wide policy-box">
              <strong>
                {tr(
                  "Permissions: workspace + explicitly allowed directories",
                  "Permissions : espace de travail + répertoires explicitement autorisés",
                )}
              </strong>
              <span className="muted">
                {tr(
                  "Write access allowed inside mission workspace. Pathless deletions and outside access are denied. This guardrail cannot be disabled.",
                  "Accès en écriture autorisé dans l'espace de mission. Suppressions sans chemin et accès externe refusés. Ce garde-fou ne peut être désactivé.",
                )}
              </span>
            </div>
          </div>

          <div className="settings-actions">
            <button className="button primary" type="button" disabled={busy} onClick={saveProfile}>
              {tr("Save", "Enregistrer")}
            </button>
          </div>

          <h3>{tr("Live connection test", "Test de connexion en direct")}</h3>
          <div className="settings-grid">
            <label className="settings-wide">
              {tr("Test workspace", "Espace de test")}
              <input
                className="field mono"
                value={testWorkspace}
                onChange={(event) => setTestWorkspace(event.target.value)}
              />
            </label>
            <label className="settings-wide">
              {tr("Test prompt", "Invite de test")}
              <input
                className="field"
                value={testPrompt}
                onChange={(event) => setTestPrompt(event.target.value)}
              />
            </label>
          </div>
          <div className="settings-actions">
            <button className="button" type="button" disabled={busy} onClick={testProfile}>
              {tr("Test agent", "Tester l'agent")}
            </button>
          </div>
          {testResult === null ? null : <pre className="test-result">{testResult}</pre>}
        </section>
      )}

      <div className="agent-add">
        <div>
          <h3>{tr("Create an ACP agent in NEXUS", "Créer un agent ACP dans NEXUS")}</h3>
          <p className="muted">
            {tr(
              "Start from a secured ACP adapter. NEXUS creates the profile and registers it directly with the orchestrator, without requesting your provider credentials.",
              "Démarrez depuis un adaptateur ACP sécurisé. NEXUS crée le profil et l'enregistre auprès de l'orchestrateur sans demander vos identifiants.",
            )}
          </p>
        </div>
        <div className="agent-create-form">
          <select
            className="field"
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
          >
            <option value="">{tr("Agent type…", "Type d'agent…")}</option>
            {templates.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <input
            className="field"
            value={newName}
            placeholder={tr("Profile name", "Nom du profil")}
            onChange={(event) => {
              const value = normalizeProfileName(event.target.value);
              setNewName(value);
              setNewKey(normalizeKey(value));
            }}
          />
          <input
            className="field"
            value={newKey}
            placeholder={tr("nexus-name", "nom-nexus")}
            onChange={(event) => setNewKey(normalizeKey(event.target.value))}
          />
          <input
            className="field"
            value={model}
            placeholder={tr("Optional model", "Modèle optionnel")}
            onChange={(event) => setModel(event.target.value.slice(0, 200))}
          />
          <button
            className="button primary"
            type="button"
            disabled={busy || template.length === 0 || newName.length === 0 || newKey.length === 0}
            onClick={create}
          >
            {busy ? tr("Creating…", "Création…") : tr("Create and register", "Créer et enregistrer")}
          </button>
        </div>
      </div>

      <div className="agent-add secondary">
        <div>
          <h3>{tr("Import existing ACP profile", "Importer un profil ACP existant")}</h3>
          <p className="muted">
            {tr(
              "For a custom adapter already configured in NEXUS.",
              "Pour un adaptateur personnalisé déjà configuré dans NEXUS.",
            )}
          </p>
        </div>
        {candidates.length === 0 ? (
          <div className="muted">
            {tr(
              "All available ACP profiles are already registered.",
              "Tous les profils ACP disponibles sont déjà enregistrés.",
            )}
          </div>
        ) : (
          <div className="agent-add-form">
            <select
              className="field"
              value={selected}
              onChange={(event) => choose(event.target.value)}
            >
              <option value="">
                {tr("Select an ACP profile…", "Sélectionner un profil ACP…")}
              </option>
              {candidates.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {agent.agent_kind}
                </option>
              ))}
            </select>
            <input
              className="field"
              value={key}
              placeholder={tr("short-name", "nom-court")}
              pattern="[a-z][a-z0-9_-]{0,63}"
              onChange={(event) => setKey(normalizeKey(event.target.value))}
            />
            <button
              className="button primary"
              type="button"
              disabled={busy || selected.length === 0 || key.length === 0}
              onClick={register}
            >
              {busy ? tr("Adding…", "Ajout…") : tr("Add to NEXUS", "Ajouter à NEXUS")}
            </button>
          </div>
        )}
      </div>

      {/* ── Multi-account provider management ── */}
      <div className="settings-panel" style={{ marginTop: "28px" }}>
        <div
          className="settings-panel-heading"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div>
            <h3>
              {tr(
                "Provider Accounts & Isolated Identities",
                "Comptes Fournisseurs & Identités Isolées",
              )}
            </h3>
            <p className="muted">
              {tr(
                "Multi-account management (Antigravity, Claude, Codex) with isolated local CLI sessions, authentication tracking, quotas, cooldowns, and reliability.",
                "Gestion multi-comptes (Antigravity, Claude, Codex) avec sessions CLI locales isolées, suivi de l'authentification, quotas, refroidissements et fiabilité.",
              )}
            </p>
          </div>
          <div>
            <select
              className="field"
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value)}
              style={{ width: "auto" }}
            >
              <option value="all">
                {tr("All Providers", "Tous les fournisseurs")} ({accounts.length})
              </option>
              <option value="antigravity">Antigravity</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="openhands">OpenHands</option>
            </select>
          </div>
        </div>

        {accountFeedback !== null ? (
          <div className="banner success" style={{ marginBottom: "16px" }}>
            {accountFeedback}
          </div>
        ) : null}

        <div className="agent-grid" style={{ marginBottom: "20px" }}>
          {accounts
            .filter((acc) => (providerFilter === "all" ? true : acc.provider === providerFilter))
            .map((acc) => {
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
                ? tr("Cooling down", "En refroidissement")
                : isExhausted
                  ? tr("Quota exhausted", "Quota épuisé")
                  : isAuthOk
                    ? tr("Authenticated", "Authentifié")
                    : acc.authStatus === "expired"
                      ? tr("Expired", "Expiré")
                      : tr("Unverified", "Non vérifié");

              return (
                <article className="agent-card" key={acc.id}>
                  {editingAccId === acc.id ? (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "10px",
                        width: "100%",
                      }}
                    >
                      <h4 style={{ margin: "0 0 4px 0" }}>
                        {tr("Edit", "Modifier")} {acc.id}
                      </h4>
                      <label style={{ fontSize: "12px" }}>
                        {tr("Account Name / Label", "Nom du compte / Libellé")}
                        <input
                          className="field"
                          value={editingAccName}
                          onChange={(e) => setEditingAccName(e.target.value)}
                        />
                      </label>
                      <label style={{ fontSize: "12px" }}>
                        {tr(
                          "Routing Priority (1 = highest)",
                          "Priorité de routage (1 = plus haute)",
                        )}
                        <input
                          className="field"
                          type="number"
                          min={1}
                          max={100}
                          value={editingAccPriority}
                          onChange={(e) => setEditingAccPriority(Number(e.target.value))}
                        />
                      </label>
                      <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                        <button
                          className="button primary compact"
                          type="button"
                          disabled={accActionLoading || !editingAccName.trim()}
                          onClick={() => void handleSaveAccount(acc.id)}
                        >
                          {accActionLoading
                            ? tr("Saving…", "Enregistrement…")
                            : tr("Save", "Enregistrer")}
                        </button>
                        <button
                          className="button compact"
                          type="button"
                          disabled={accActionLoading}
                          onClick={() => setEditingAccId(null)}
                        >
                          {tr("Cancel", "Annuler")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="agent-card-top">
                        <div className={`agent-avatar ${statusClass}`}>
                          {acc.provider.slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <h3>{acc.name}</h3>
                            {acc.priority === 1 ? (
                              <span
                                className="state-pill good"
                                style={{
                                  fontSize: "10px",
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "3px",
                                }}
                              >
                                <IconStar size={10} filled color="currentColor" />
                                {tr("Primary", "Principal")}
                              </span>
                            ) : null}
                          </div>
                          <div className="muted">
                            {acc.id} · {acc.provider} · {tr("Priority", "Priorité")} P{acc.priority}
                          </div>
                        </div>
                        <span className={`agent-status ${statusClass}`}>{statusLabel}</span>
                      </div>

                      <div className="agent-stats">
                        <span>
                          <strong>{Math.round(acc.reliability.score * 100)} %</strong>{" "}
                          {tr("reliability", "fiabilité")} ({acc.reliability.successCount}/
                          {acc.reliability.totalRuns})
                        </span>
                        <span>
                          <strong>{acc.reliability.consecutiveFailures}</strong>{" "}
                          {tr("consec. errors", "erreurs conséc.")}
                        </span>
                        <span>
                          <strong>
                            {acc.cooldown.active ? tr("Active", "Actif") : tr("No", "Aucun")}
                          </strong>{" "}
                          {tr("cooldown", "refroidissement")}
                        </span>
                      </div>

                      {acc.cooldown.reason ? (
                        <div
                          className="muted"
                          style={{ marginTop: "8px", fontSize: "11px", color: "var(--gradient)" }}
                        >
                          {tr("Cooldown reason:", "Motif de refroidissement :")}{" "}
                          {acc.cooldown.reason}
                        </div>
                      ) : null}

                      <div className="agent-card-actions">
                        <button
                          className="button"
                          type="button"
                          disabled={accActionLoading}
                          onClick={() => {
                            setEditingAccId(acc.id);
                            setEditingAccName(acc.name);
                            setEditingAccPriority(acc.priority);
                          }}
                        >
                          {tr("Edit", "Modifier")}
                        </button>
                        <button
                          className="button"
                          type="button"
                          disabled={accActionLoading}
                          onClick={() => void handleTestAccount(acc.id)}
                        >
                          {tr("Test", "Tester")}
                        </button>
                        <button
                          className="button"
                          type="button"
                          disabled={accActionLoading}
                          onClick={() => void handleToggleCooldown(acc.id, acc.cooldown.active)}
                        >
                          {acc.cooldown.active
                            ? tr("Resume", "Reprendre")
                            : tr("Pause", "Mettre en pause")}
                        </button>
                        <button
                          className="button danger"
                          type="button"
                          disabled={accActionLoading}
                          onClick={() => void handleDeleteAccount(acc.id)}
                        >
                          {tr("Revoke", "Révoquer")}
                        </button>
                      </div>
                    </>
                  )}
                </article>
              );
            })}
        </div>

        <div className="agent-add" style={{ marginTop: "16px" }}>
          <div>
            <h3>{tr("Add provider identity", "Ajouter une identité de fournisseur")}</h3>
            <p className="muted">
              {tr(
                "e.g. antigravity-secondary, claude-backup, codex-dev.",
                "ex. antigravity-secondaire, claude-backup, codex-dev.",
              )}
            </p>
          </div>
          <div className="agent-add-form">
            <select
              className="field"
              value={newAccProvider}
              onChange={(e) => {
                setNewAccProvider(e.target.value);
                if (!newAccId) setNewAccId(`${e.target.value}-secondary`);
              }}
            >
              <option value="antigravity">Antigravity (Google AI Pro)</option>
              <option value="claude">Claude (Claude Pro subscription)</option>
              <option value="codex">Codex (ChatGPT Plus subscription)</option>
            </select>
            <input
              className="field"
              value={newAccId}
              placeholder={tr("unique-identifier", "identifiant-unique")}
              onChange={(e) => setNewAccId(normalizeKey(e.target.value))}
            />
            <input
              className="field"
              value={newAccName}
              placeholder={tr("Full name (e.g. Claude Backup)", "Nom complet (ex. Claude Backup)")}
              onChange={(e) => setNewAccName(e.target.value)}
            />
            <input
              className="field"
              type="number"
              min={1}
              max={10}
              value={newAccPriority}
              style={{ width: "80px" }}
              title={tr("Priority (1 = high priority)", "Priorité (1 = haute priorité)")}
              onChange={(e) => setNewAccPriority(Number(e.target.value) || 1)}
            />
            <button
              className="button primary"
              type="button"
              disabled={accActionLoading || !newAccId.trim() || !newAccName.trim()}
              onClick={() => void handleCreateAccount()}
            >
              {accActionLoading
                ? tr("Creating…", "Création…")
                : tr("Create identity", "Créer l'identité")}
            </button>
          </div>
        </div>

        {/* Section 4: Smart Routing & Affinity Matrix */}
        <div
          style={{
            marginTop: "40px",
            borderTop: "1px solid var(--nx-line)",
            paddingTop: "24px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "16px",
            }}
          >
            <div>
              <h3>
                {tr(
                  "Smart Routing & Feedback Learning",
                  "Routage Intelligent & Apprentissage par Feedback",
                )}
              </h3>
              <p className="muted">
                {tr(
                  "Dynamic multi-criteria scoring (affinities, auth, 5h/weekly quotas, cooldowns, latency, history) replacing static priorities.",
                  "Scoring multicritère dynamique (affinités, authentification, quotas 5h/hebdo, refroidissements, latence, historique) remplaçant les priorités statiques.",
                )}
              </p>
            </div>
            <button
              className="button"
              type="button"
              onClick={() => void handleResetRouting()}
              title={tr(
                "Resets success metrics and learned scores",
                "Réinitialise les métriques de succès et scores appris",
              )}
            >
              {tr("Reset learning", "Réinitialiser l'apprentissage")}
            </button>
          </div>

          {routingResetMsg ? (
            <div className="banner success" style={{ marginBottom: "16px" }}>
              {routingResetMsg}
            </div>
          ) : null}

          {/* Affinity matrix */}
          <div className="scroll-x" style={{ marginBottom: "24px" }}>
            <table
              className="nexus-table"
              style={{ width: "100%", textAlign: "left", fontSize: "0.9rem" }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid var(--nx-line)" }}>
                  <th style={{ padding: "8px" }}>{tr("Profile", "Profil")}</th>
                  <th style={{ padding: "8px" }}>{tr("Auth", "Auth")}</th>
                  <th style={{ padding: "8px" }}>{tr("Code", "Code")}</th>
                  <th style={{ padding: "8px" }}>{tr("Research", "Recherche")}</th>
                  <th style={{ padding: "8px" }}>{tr("Review", "Revue")}</th>
                  <th style={{ padding: "8px" }}>{tr("Browser", "Navigateur")}</th>
                  <th style={{ padding: "8px" }}>{tr("Synthesis", "Synthèse")}</th>
                  <th style={{ padding: "8px" }}>{tr("Runs / Success", "Exécutions / Succès")}</th>
                </tr>
              </thead>
              <tbody>
                {routingMatrix.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      style={{
                        padding: "12px",
                        textAlign: "center",
                        color: "var(--nx-text-muted)",
                      }}
                    >
                      {tr("No routing data available.", "Aucune donnée de routage disponible.")}
                    </td>
                  </tr>
                ) : (
                  routingMatrix.map((r) => (
                    <tr key={r.key} style={{ borderBottom: "1px solid var(--nx-line-strong)" }}>
                      <td style={{ padding: "8px", fontWeight: "bold" }}>
                        {r.key}
                        {r.cooldownActive ? (
                          <span style={{ color: "var(--nx-warn)", marginLeft: "6px" }}>
                            ({tr("Cooldown", "Refroidissement")})
                          </span>
                        ) : null}
                      </td>
                      <td style={{ padding: "8px" }}>
                        <span
                          className={`badge ${r.authStatus === "authenticated" ? "success" : "attention"}`}
                        >
                          {r.authStatus === "authenticated"
                            ? tr("authenticated", "authentifié")
                            : r.authStatus}
                        </span>
                      </td>
                      <td style={{ padding: "8px" }}>{Math.round(r.categoryScores.code ?? 0)}</td>
                      <td style={{ padding: "8px" }}>
                        {Math.round(r.categoryScores.research ?? 0)}
                      </td>
                      <td style={{ padding: "8px" }}>{Math.round(r.categoryScores.review ?? 0)}</td>
                      <td style={{ padding: "8px" }}>
                        {Math.round(r.categoryScores.browser ?? 0)}
                      </td>
                      <td style={{ padding: "8px" }}>
                        {Math.round(r.categoryScores.synthesis ?? 0)}
                      </td>
                      <td style={{ padding: "8px" }}>
                        {r.totalRuns} {tr("runs", "exécutions")} (
                        {Math.round(r.overallSuccessRate * 100)} %)
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Simulateur de routage */}
          <div
            className="card"
            style={{ padding: "16px", background: "var(--nx-surface)", borderRadius: "8px" }}
          >
            <h4 style={{ margin: "0 0 10px 0" }}>
              {tr("Routing Evaluation Simulator", "Simulateur d'Évaluation de Routage")}
            </h4>
            <p className="muted" style={{ marginBottom: "12px" }}>
              {tr(
                "Test which route and agent the orchestrator selects for a given instruction.",
                "Testez quelle route et quel agent l'orchestrateur sélectionne pour une instruction donnée.",
              )}
            </p>
            <div style={{ display: "flex", gap: "10px", marginBottom: "14px" }}>
              <input
                className="field"
                type="text"
                placeholder={tr(
                  "e.g. Fix the bug in services/api/src/auth.ts and add a vitest test",
                  "ex. Corriger le bug dans services/api/src/auth.ts et ajouter un test vitest",
                )}
                value={testRoutingInstruction}
                onChange={(e) => setTestRoutingInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleEvaluateRouting();
                }}
                style={{ flex: 1 }}
              />
              <button
                className="button primary"
                type="button"
                disabled={routingLoading || !testRoutingInstruction.trim()}
                onClick={() => void handleEvaluateRouting()}
              >
                {routingLoading ? tr("Evaluating…", "Évaluation…") : tr("Evaluate", "Évaluer")}
              </button>
            </div>

            {routingEvaluation ? (
              <div
                style={{
                  marginTop: "12px",
                  borderTop: "1px solid var(--nx-line)",
                  paddingTop: "12px",
                }}
              >
                <div
                  style={{ display: "flex", gap: "16px", marginBottom: "12px", flexWrap: "wrap" }}
                >
                  <div>
                    <strong>{tr("Category:", "Catégorie :")}</strong>{" "}
                    <span className="badge">
                      {routingEvaluation.classification.primaryCategory}
                    </span>
                  </div>
                  <div>
                    <strong>{tr("Complexity:", "Complexité :")}</strong>{" "}
                    {routingEvaluation.classification.estimatedComplexity}
                  </div>
                  <div>
                    <strong>{tr("Browser required:", "Navigateur requis :")}</strong>{" "}
                    {routingEvaluation.classification.requiresBrowser
                      ? tr("Yes", "Oui")
                      : tr("No", "Non")}
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {routingEvaluation.ranked.map((agent, idx) => (
                    <div
                      key={agent.key}
                      style={{
                        padding: "10px",
                        borderRadius: "6px",
                        background:
                          idx === 0 && agent.isAvailable
                            ? "rgba(40, 167, 69, 0.15)"
                            : "var(--nx-surface)",
                        border:
                          idx === 0 && agent.isAvailable
                            ? "1px solid #28a745"
                            : "1px solid var(--nx-line)",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <strong>
                          #{idx + 1} {agent.key}
                        </strong>{" "}
                        {idx === 0 && agent.isAvailable ? (
                          <span
                            style={{
                              color: "var(--nx-ok)",
                              fontWeight: "bold",
                              marginLeft: "6px",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                            }}
                          >
                            <IconStar size={12} filled color="var(--nx-ok)" />
                            {tr("Recommended", "Recommandé")}
                          </span>
                        ) : null}
                        {!agent.isAvailable ? (
                          <span style={{ color: "var(--nx-danger)", marginLeft: "6px" }}>
                            ({agent.unavailabilityReason})
                          </span>
                        ) : null}
                        <div className="muted" style={{ fontSize: "0.8rem", marginTop: "4px" }}>
                          Compat: {agent.breakdown.compatibility} · Auth:{" "}
                          {agent.breakdown.authentication} · Quota: {agent.breakdown.quota} ·{" "}
                          {tr("Reliability:", "Fiabilité :")} {agent.breakdown.health} · Perf:{" "}
                          {agent.breakdown.performance}
                        </div>
                      </div>
                      <div style={{ fontSize: "1.2rem", fontWeight: "bold" }}>
                        {Math.round(agent.totalScore)} / 100
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
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
  return value === null ? "unknown" : `${value} %`;
}

function healthLabel(
  status: AgentRegistry["configured"][number]["status"],
  tr: (en: string, fr: string) => string,
): string {
  switch (status) {
    case "available":
      return tr("Available", "Disponible");
    case "degraded":
      return tr("Degraded", "Dégradé");
    case "cooldown":
      return tr("Cooling down", "En refroidissement");
    case "quota_exhausted":
      return tr("Quota exhausted", "Quota épuisé");
    case "auth_required":
      return tr("Authentication required", "Authentification requise");
    default:
      return tr("Unmeasured", "Non mesuré");
  }
}
