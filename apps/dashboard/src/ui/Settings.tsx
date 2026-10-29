import { useEffect, useState } from "react";
import type {
  BrowserSection,
  DashboardApi,
  FreeLlmStatus,
  LlmEngineConfig,
  LlmEnginesSection,
  PaidLlmProvider,
  McpConfiguration,
  RuntimeSettings,
} from "../lib/api.js";
import { Section, useSection } from "./parts.js";
import { useI18n } from "./i18n/index.js";

export function Settings({ api }: { api: DashboardApi }) {
  const { locale, t } = useI18n();
  const state = useSection(() => api.runtimeSettings());
  const secrets = useSection(() => api.secrets());
  const linkedin = useSection(() => api.linkedInStatus());
  const freeLlm = useSection(() => api.freeLlmStatus());
  const llmEngines = useSection(() => api.llmEngines());

  return (
    <div className="content settings-page">
      <div className="agents-heading">
        <div>
          <h2>{locale === "fr" ? "Paramètres" : "Settings"}</h2>
          <p className="muted">
            {locale === "fr"
              ? "Paramètres persistants du moteur multi-agents NEXUS."
              : "Persistent settings for the NEXUS multi-agent engine."}
          </p>
        </div>
        <button className="button" type="button" onClick={state.reload}>
          {t("common.actions.refresh")}
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
      <Section state={llmEngines}>
        {(data) => <LlmEnginesForm api={api} section={data} reload={llmEngines.reload} />}
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

const PAID_PROVIDERS: { value: PaidLlmProvider; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google-gemini", label: "Google Gemini API" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "mistral", label: "Mistral" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "openai-compatible", label: "Custom OpenAI-compatible" },
];

function LlmEnginesForm({
  api,
  section,
  reload,
}: {
  api: DashboardApi;
  section: LlmEnginesSection;
  reload: () => void;
}) {
  const { tr } = useI18n();
  const [enabled, setEnabled] = useState(section.enabled);
  const [preferLocal, setPreferLocal] = useState(section.preferLocal);
  const [engines, setEngines] = useState(section.engines);
  const [kind, setKind] = useState<"paid-api" | "device">("paid-api");
  const [provider, setProvider] = useState<PaidLlmProvider>("openai");
  const [label, setLabel] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [priority, setPriority] = useState(500);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(section.enabled);
    setPreferLocal(section.preferLocal);
    setEngines(section.engines);
  }, [section.enabled, section.engines, section.preferLocal]);

  const persist = async (next: LlmEngineConfig[] = engines): Promise<void> => {
    await api.configureLlmEngines({ enabled, preferLocal, engines: next });
    reload();
  };

  const updateEngines = (next: LlmEngineConfig[], success: string): void => {
    setBusy(true);
    setError(null);
    void persist(next)
      .then(() => {
        setEngines(next);
        setMessage(success);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Model routing could not be saved."),
      )
      .finally(() => setBusy(false));
  };

  const add = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const id = uniqueEngineId(label || (kind === "device" ? "local-device" : provider), engines);
      let engine: LlmEngineConfig;
      if (kind === "paid-api") {
        if (apiKey.trim().length === 0) throw new Error("Enter the provider API key.");
        if (model.trim().length === 0) throw new Error("Enter an exact provider model ID.");
        if (provider === "openai-compatible" && baseUrl.trim().length === 0) {
          throw new Error("Enter the HTTPS base URL of the compatible API.");
        }
        const secretName = `llm-${id}`;
        await api.saveSecret(secretName, apiKey.trim());
        engine = {
          id,
          label: label.trim() || providerLabel(provider),
          kind: "paid-api",
          enabled: true,
          priority,
          model: model.trim(),
          maxContextTokens: 128_000,
          provider,
          apiKeyRef: `vault://nexus/${secretName}`,
          baseUrl: provider === "openai-compatible" ? baseUrl.trim() : null,
          inputCostPerMillion: null,
          outputCostPerMillion: null,
        };
      } else {
        if (deviceId.length === 0) throw new Error("Select an online model worker.");
        const device = section.localDevices.find((candidate) => candidate.id === deviceId);
        if (device === undefined)
          throw new Error("The selected model worker is no longer available.");
        const selectedModel = model.trim() || device.model;
        if (selectedModel === null || selectedModel.length === 0) {
          throw new Error("Enter the model loaded by the worker.");
        }
        engine = {
          id,
          label: label.trim() || `Local · ${device.name}`,
          kind: "device",
          enabled: true,
          priority,
          model: selectedModel,
          maxContextTokens: 128_000,
          runtime: device.runtime === "openai-compatible" ? "openai-compatible" : "ollama",
          preferredDeviceId: device.id,
          minimumGpuVramMb: 0,
        };
      }
      const next = [...engines, engine];
      await persist(next);
      setEngines(next);
      setApiKey("");
      setLabel("");
      setModel("");
      setMessage(`${engine.label} added to the NEXUS router.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine could not be added.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-panel">
      <div className="settings-panel-heading">
        <div>
          <h3>Model engines · paid APIs and private devices</h3>
          <p className="muted">
            Keys stay in the encrypted NEXUS vault. Device models execute through an authenticated
            worker; the model server never needs to be exposed to the internet.
          </p>
        </div>
        <span className="status-pill">{engines.length} configured</span>
      </div>

      <div className="settings-grid">
        <label className="check-label">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enable configured engines
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={preferLocal}
            onChange={(event) => setPreferLocal(event.target.checked)}
          />
          Prefer private device models before cloud APIs
        </label>
      </div>
      <div className="settings-actions">
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void persist()
              .then(() => setMessage("Model routing preferences saved."))
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "Routing could not be saved."),
              )
              .finally(() => setBusy(false));
          }}
        >
          {busy ? tr("Saving…", "Enregistrement…") : tr("Save routing", "Enregistrer le routage")}
        </button>
      </div>

      <div className="engine-list">
        {engines.map((engine) => {
          const runtime = section.status?.engines.find((item) => item.id === engine.id);
          return (
            <article className="engine-card" key={engine.id}>
              <div>
                <strong>{engine.label}</strong>
                <p className="muted mono">
                  {engine.kind === "device" ? `device · ${engine.runtime}` : engine.provider} ·{" "}
                  {engine.model}
                </p>
              </div>
              <span className={engine.enabled ? "status-pill success" : "status-pill"}>
                {engine.enabled
                  ? engine.kind === "paid-api" && runtime?.credentialConfigured !== true
                    ? tr("key missing", "clé manquante")
                    : tr("enabled", "activé")
                  : tr("disabled", "désactivé")}
              </span>
              <div className="settings-actions">
                <button
                  className="button"
                  type="button"
                  disabled={busy || !engine.enabled}
                  onClick={() => {
                    setBusy(true);
                    setError(null);
                    void api
                      .testLlmEngine(engine.id)
                      .then((result) => setMessage(`Ready · ${result.model} · ${result.text}`))
                      .catch((cause: unknown) =>
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : tr("Engine test failed.", "Échec du test du moteur."),
                        ),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  {tr("Test", "Tester")}
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const next = engines.map((candidate) =>
                      candidate.id === engine.id
                        ? { ...candidate, enabled: !candidate.enabled }
                        : candidate,
                    );
                    updateEngines(
                      next,
                      `${engine.label} ${engine.enabled ? tr("disabled", "désactivé") : tr("enabled", "activé")}.`,
                    );
                  }}
                >
                  {engine.enabled ? tr("Disable", "Désactiver") : tr("Enable", "Activer")}
                </button>
                <button
                  className="button danger"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const next = engines.filter((candidate) => candidate.id !== engine.id);
                    updateEngines(
                      next,
                      `${engine.label} ${tr("removed from model routing.", "retiré du routage des modèles.")}`,
                    );
                  }}
                >
                  {tr("Remove", "Supprimer")}
                </button>
              </div>
            </article>
          );
        })}
        {engines.length === 0 ? (
          <p className="empty-state">
            {tr(
              "No paid or device engine configured yet.",
              "Aucun moteur payant ou local configuré pour le moment.",
            )}
          </p>
        ) : null}
      </div>

      <h4>{tr("Add a model engine", "Ajouter un moteur de modèle")}</h4>
      <div className="settings-grid">
        <label>
          {tr("Engine location", "Emplacement du moteur")}
          <select
            className="field"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="paid-api">{tr("Paid cloud API", "API cloud payante")}</option>
            <option value="device">
              {tr("Private model on a NEXUS device", "Modèle privé sur appareil NEXUS")}
            </option>
          </select>
        </label>
        <label>
          {tr("Display name", "Nom affiché")}
          <input
            className="field"
            value={label}
            placeholder={tr("My primary model", "Mon modèle principal")}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        {kind === "paid-api" ? (
          <>
            <label>
              {tr("Provider", "Fournisseur")}
              <select
                className="field"
                value={provider}
                onChange={(event) => setProvider(event.target.value as PaidLlmProvider)}
              >
                {PAID_PROVIDERS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tr("Exact model ID", "ID exact du modèle")}
              <input
                className="field mono"
                value={model}
                placeholder={tr("Provider model identifier", "Identifiant du modèle fournisseur")}
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
            <label className="settings-wide">
              {tr("API key", "Clé API")}
              <input
                className="field mono"
                type="password"
                autoComplete="new-password"
                value={apiKey}
                placeholder={tr(
                  "Stored once in the encrypted vault",
                  "Stockée dans le coffre chiffré",
                )}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
            {provider === "openai-compatible" ? (
              <label className="settings-wide">
                {tr("HTTPS API base URL", "URL de base de l'API HTTPS")}
                <input
                  className="field mono"
                  value={baseUrl}
                  placeholder="https://provider.example/api"
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </label>
            ) : null}
          </>
        ) : (
          <>
            <label>
              {tr("Model worker", "Agent de modèle")}
              <select
                className="field"
                value={deviceId}
                onChange={(event) => {
                  const value = event.target.value;
                  setDeviceId(value);
                  const device = section.localDevices.find((candidate) => candidate.id === value);
                  if (device?.model !== null && device?.model !== undefined) setModel(device.model);
                }}
              >
                <option value="">
                  {tr("Select an eligible device…", "Sélectionner un appareil éligible…")}
                </option>
                {section.localDevices.map((device) => (
                  <option key={device.id} value={device.id} disabled={!device.eligible}>
                    {device.name} ·{" "}
                    {device.model ?? tr("model not reported", "modèle non rapporté")}
                    {device.eligible
                      ? ""
                      : ` · ${tr("approve, connect and grant llm.inference", "approuver, connecter et accorder llm.inference")}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tr("Model", "Modèle")}
              <input
                className="field mono"
                value={model}
                placeholder="llama3.3:70b"
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
          </>
        )}
        <label>
          {tr("Priority", "Priorité")}
          <input
            className="field"
            type="number"
            min={1}
            max={1000}
            value={priority}
            onChange={(event) => setPriority(Number(event.target.value))}
          />
          <span className="field-help">
            {tr(
              "Lower values run first. Device models run first when local preference is enabled.",
              "Les valeurs plus faibles s'exécutent en premier. Les modèles locaux sont prioritaires quand la préférence locale est active.",
            )}
          </span>
        </label>
      </div>
      <div className="settings-actions">
        <button className="button primary" type="button" disabled={busy} onClick={() => void add()}>
          {busy ? tr("Saving…", "Enregistrement…") : tr("Add engine", "Ajouter le moteur")}
        </button>
      </div>
      {kind === "device" && section.localDevices.length === 0 ? (
        <p className="banner">
          No connected worker advertises <code>llm.inference</code>. Configure Ollama or an
          OpenAI-compatible server on the worker, then restart it.
        </p>
      ) : null}
      {message === null ? null : <p className="banner success">{message}</p>}
      {error === null ? null : <p className="banner error">{error}</p>}
    </section>
  );
}

function providerLabel(provider: PaidLlmProvider): string {
  return PAID_PROVIDERS.find((item) => item.value === provider)?.label ?? provider;
}

function uniqueEngineId(label: string, engines: readonly LlmEngineConfig[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "engine";
  const used = new Set(engines.map((engine) => engine.id));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${String(Date.now())}`;
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
  const { tr } = useI18n();
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
      setMessage(
        tr(
          "FreeLLM routing saved. Changes apply to the next model request.",
          "Routage FreeLLM enregistré. Les modifications s'appliquent à la prochaine requête.",
        ),
      );
      reload();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : tr("FreeLLM configuration failed.", "Échec de configuration FreeLLM."),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-panel">
      <h3>
        {tr("Free models · FreeLLM and NVIDIA NIM", "Modèles gratuits · FreeLLM et NVIDIA NIM")}
      </h3>
      <p className="muted">
        {tr(
          "Adds a free-tier fallback after your subscription-backed agents and local models. NVIDIA NIM access is intended for development, research, and evaluation—not production use.",
          "Ajoute un repli gratuit après vos agents sur abonnement et modèles locaux. L'accès NVIDIA NIM est dédié au développement, à la recherche et à l'évaluation.",
        )}
      </p>
      <p className={status.enabled ? "banner success" : "banner"}>
        {status.enabled
          ? `${tr("Enabled", "Activé")} · ${status.activeProviders.join(", ") || tr("provider required", "fournisseur requis")}`
          : tr("Disabled", "Désactivé")}
      </p>
      <div className="settings-grid">
        <label>
          {tr("Routing model", "Modèle de routage")}
          <select
            className="field"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="auto">
              {tr("Auto · best available", "Auto · meilleur disponible")}
            </option>
            <option value="chat:fast">{tr("Fast chat", "Chat rapide")}</option>
            <option value="chat:large">{tr("Large model", "Grand modèle")}</option>
            <option value="chat:tools">{tr("Tool calling", "Appel d'outils")}</option>
            <option value="reasoning">{tr("Reasoning", "Raisonnement")}</option>
          </select>
        </label>
        <label>
          {tr("Routing strategy", "Stratégie de routage")}
          <select
            className="field"
            value={strategy}
            onChange={(event) => setStrategy(event.target.value as FreeLlmStatus["strategy"])}
          >
            <option value="quota_aware">{tr("Quota aware", "Prise en compte des quotas")}</option>
            <option value="smart">{tr("Smart latency", "Latence intelligente")}</option>
            <option value="priority">{tr("Fixed priority", "Priorité fixe")}</option>
            <option value="round_robin">{tr("Round robin", "Tour de rôle (Round Robin)")}</option>
            <option value="latency">{tr("Lowest latency", "Latence minimale")}</option>
          </select>
        </label>
        <label className="settings-wide">
          {tr("NVIDIA API key", "Clé API NVIDIA")}{" "}
          {status.nvidiaConfigured ? `· ${tr("stored", "enregistrée")}` : ""}
          <input
            className="field mono"
            type="password"
            autoComplete="new-password"
            value={nvidiaKey}
            placeholder={
              status.nvidiaConfigured
                ? tr(
                    "Leave blank to keep the stored key",
                    "Laisser vide pour conserver la clé stockée",
                  )
                : "nvapi-…"
            }
            onChange={(event) => setNvidiaKey(event.target.value)}
          />
        </label>
        <label className="check-label settings-wide">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          {tr("Enable FreeLLM fallback", "Activer le secours FreeLLM")}
        </label>
        <label className="check-label settings-wide">
          <input
            type="checkbox"
            checked={allowKeyless}
            onChange={(event) => setAllowKeyless(event.target.checked)}
          />
          {tr(
            "Allow anonymous Kilo and OVH fallbacks (prompts may be retained by those providers)",
            "Autoriser les replis anonymes Kilo et OVH (les requêtes peuvent être conservées par ces fournisseurs)",
          )}
        </label>
      </div>
      <div className="settings-actions">
        <button
          className="button primary"
          type="button"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy
            ? tr("Saving…", "Enregistrement…")
            : tr("Save free-model routing", "Enregistrer le routage gratuit")}
        </button>
        <button
          className="button"
          type="button"
          disabled={busy || !status.enabled}
          title={tr(
            "Consumes one small request from the configured free quota",
            "Consomme une petite requête sur le quota gratuit configuré",
          )}
          onClick={() => {
            setBusy(true);
            setMessage(null);
            setError(null);
            void api
              .testFreeLlm()
              .then((result) => setMessage(`Ready · ${result.model} · ${result.text}`))
              .catch((cause: unknown) =>
                setError(
                  cause instanceof Error
                    ? cause.message
                    : tr("FreeLLM test failed.", "Échec du test FreeLLM."),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          {tr("Test with one request", "Tester avec une requête")}
        </button>
        <a
          className="button secondaire"
          href="https://build.nvidia.com/"
          target="_blank"
          rel="noreferrer"
        >
          {tr("Get an NVIDIA development key", "Obtenir une clé NVIDIA")}
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
  const { tr } = useI18n();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const redirectUri = `${window.location.origin}/api/v1/linkedin/oauth/callback`;

  return (
    <section className="settings-panel">
      <h3>{tr("LinkedIn · Official API", "LinkedIn · API officielle")}</h3>
      <p className="muted">
        {tr(
          "Connect through LinkedIn OAuth. NEXUS can publish and comment only after your explicit confirmation. It never scrapes or automates the LinkedIn interface.",
          "Connexion via OAuth LinkedIn. NEXUS publie et commente uniquement après confirmation explicite. Aucun scraping ni automatisation d'interface.",
        )}
      </p>
      <p className={status.connected ? "banner success" : "banner"}>
        {status.connected
          ? `${tr("Connected", "Connecté")} · ${status.tools.length} ${tr("official tools active", "outils officiels actifs")}`
          : status.configured
            ? tr("Configured, authorization required", "Configuré, autorisation requise")
            : tr("Not configured", "Non configuré")}
      </p>
      {!status.connected ? (
        <>
          <div className="settings-grid">
            <label>
              {tr("LinkedIn application Client ID", "ID client de l'application LinkedIn")}
              <input
                className="field mono"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
              />
            </label>
            <label>
              {tr("LinkedIn application Client Secret", "Secret client de l'application LinkedIn")}
              <input
                className="field mono"
                type="password"
                autoComplete="new-password"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
              />
            </label>
            <label className="settings-wide">
              {tr("Authorized redirect URL", "URL de redirection autorisée")}
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
                      cause instanceof Error
                        ? cause.message
                        : tr("LinkedIn connection failed.", "Échec de la connexion LinkedIn."),
                    );
                  });
              }}
            >
              {busy
                ? tr("Opening LinkedIn…", "Ouverture de LinkedIn…")
                : tr("Connect LinkedIn", "Connecter LinkedIn")}
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
                setError(
                  cause instanceof Error
                    ? cause.message
                    : tr("Disconnect failed.", "Échec de la déconnexion."),
                ),
              )
          }
        >
          {tr("Disconnect LinkedIn", "Déconnecter LinkedIn")}
        </button>
      )}
      {error === null ? null : <p className="banner error">{error}</p>}
    </section>
  );
}

function BackupRestorePanel({ api, onReloadAll }: { api: DashboardApi; onReloadAll: () => void }) {
  const { tr } = useI18n();
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
      setMessage(
        tr(
          "Configuration backup file downloaded successfully.",
          "Fichier de sauvegarde de configuration téléchargé avec succès.",
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : tr("Backup export failed.", "Échec de l'export de sauvegarde."),
      );
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
        throw new Error(
          tr(
            "Invalid backup format: root must be an object.",
            "Format de sauvegarde invalide : la racine doit être un objet.",
          ),
        );
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
      setMessage(
        tr(
          "Configuration restored successfully and applied to active services.",
          "Configuration restaurée avec succès et appliquée aux services actifs.",
        ),
      );
      onReloadAll();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : tr("Configuration restore failed.", "Échec de restauration de la configuration."),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-panel">
      <div className="settings-panel-heading">
        <div>
          <h3>{tr("Backup & Restore Assistant", "Assistant Sauvegarde & Restauration")}</h3>
          <p className="muted">
            {tr(
              "Export or restore platform configuration. Secrets remain in the vault and are never exported.",
              "Exportez ou restaurez la configuration de la plateforme. Les secrets restent chiffrés et ne sont jamais exportés.",
            )}
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
          {busy
            ? tr("Exporting…", "Exportation…")
            : tr("Export configuration backup", "Exporter la sauvegarde de configuration")}
        </button>
      </div>
      <div className="settings-grid">
        <label className="settings-wide">
          {tr("Restore configuration from JSON", "Restaurer la configuration depuis un JSON")}
          <textarea
            className="field mono"
            rows={6}
            value={restoreJson}
            onChange={(event) => setRestoreJson(event.target.value)}
            placeholder={tr(
              "Paste an exported NEXUS configuration backup here.",
              "Collez une sauvegarde de configuration NEXUS exportée ici.",
            )}
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
          {tr("Restore and apply", "Restaurer et appliquer")}
        </button>
      </div>
      <div className="policy-box" style={{ marginTop: "16px" }}>
        <strong>{tr("Complete system backups", "Sauvegardes système complètes")}</strong>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: "11px" }}>
          {tr(
            "Database archives and encryption keys require the dedicated authenticated backup workflow; they are intentionally excluded from browser exports.",
            "Les archives de base de données et clés de chiffrement requièrent le flux dédié et authentifié ; elles sont volontairement exclues des exports navigateur.",
          )}
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
  const { tr } = useI18n();
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fail = (cause: unknown): void =>
    setError(cause instanceof Error ? cause.message : tr("Action failed.", "Échec de l'action."));
  return (
    <section className="settings-panel">
      <h3>{tr("Local secret vault", "Coffre-fort de secrets local")}</h3>
      <p className="muted">
        {tr(
          "Values are written to the Linux keyring and are never read back by the browser. Only secret names appear here.",
          "Les valeurs sont écrites dans le trousseau Linux et ne sont jamais renvoyées au navigateur. Seuls les noms des secrets apparaissent ici.",
        )}
      </p>
      <div className="settings-grid">
        <label>
          {tr("Name", "Nom")}
          <input
            className="field mono"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="mcp-token"
          />
        </label>
        <label>
          {tr("Secret value", "Valeur du secret")}
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
                setMessage(tr(`Secret ${name} saved.`, `Secret ${name} enregistré avec succès.`));
                reload();
              })
              .catch(fail);
          }}
        >
          {tr("Save", "Enregistrer")}
        </button>
      </div>
      {names.length === 0 ? (
        <p className="empty-state">{tr("No secrets stored.", "Aucun secret stocké.")}</p>
      ) : (
        <ul>
          {names.map((item) => (
            <li key={item}>
              <code>vault://nexus/{item}</code>{" "}
              <button
                className="button danger"
                type="button"
                onClick={() => {
                  if (window.confirm(tr(`Delete secret ${item}?`, `Supprimer le secret ${item} ?`)))
                    void api
                      .removeSecret(item)
                      .then(() => {
                        setMessage(tr(`Secret ${item} deleted.`, `Secret ${item} supprimé.`));
                        reload();
                      })
                      .catch(fail);
                }}
              >
                {tr("Delete", "Supprimer")}
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
  const { tr } = useI18n();
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
          {tr("Max task timeout · seconds", "Délai max d'une tâche · secondes")}
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
          {tr("Max attempts", "Nombre max de tentatives")}
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
          {tr("Retry delay · seconds", "Délai de réessai · secondes")}
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
          {tr("Context budget · characters", "Budget de contexte · caractères")}
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
          {tr(
            "Add an independent quality review before final synthesis",
            "Ajouter une revue qualité indépendante avant la synthèse finale",
          )}
        </label>
        <label className="settings-wide">
          {tr(
            "Research priority · comma-separated profiles",
            "Priorité de recherche · profils séparés par virgules",
          )}
          <input
            className="field mono"
            value={value.research_priority.join(", ")}
            onChange={(event) => priorities("research_priority", event.target.value)}
          />
        </label>
        <label className="settings-wide">
          {tr("Critical review priority", "Priorité de revue critique")}
          <input
            className="field mono"
            value={value.review_priority.join(", ")}
            onChange={(event) => priorities("review_priority", event.target.value)}
          />
        </label>
        <label className="settings-wide">
          {tr("Final synthesis priority", "Priorité de synthèse finale")}
          <input
            className="field mono"
            value={value.synthesis_priority.join(", ")}
            onChange={(event) => priorities("synthesis_priority", event.target.value)}
          />
        </label>
        <div className="settings-wide policy-box">
          <strong>{tr("Non-disableable guardrails", "Garde-fous non désactivables")}</strong>
          <span className="muted">
            {tr(
              "ACP execution restricted to workspace, pathless deletion rejected, secrets excluded from API responses, live trading disabled, and administrator authentication mandatory.",
              "Exécution ACP restreinte à l'espace de travail, suppressions relatives rejetées, secrets exclus des réponses API, trading réel désactivé et authentification administrateur obligatoire.",
            )}
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
                setMessage(
                  tr(
                    "Settings saved and applied to upcoming missions.",
                    "Paramètres enregistrés et appliqués aux prochaines missions.",
                  ),
                );
                reload();
              })
              .catch((cause: unknown) =>
                setError(
                  cause instanceof Error
                    ? cause.message
                    : tr("Unable to save settings.", "Impossible d'enregistrer les paramètres."),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          {busy ? tr("Saving…", "Enregistrement…") : tr("Save", "Enregistrer")}
        </button>
      </div>
      {message === null ? null : <p className="banner success">{message}</p>}
      {error === null ? null : <p className="banner error">{error}</p>}
    </section>
  );
}
