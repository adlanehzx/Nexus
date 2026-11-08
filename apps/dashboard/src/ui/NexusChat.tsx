import { useEffect, useRef, useState } from "react";
import type { DashboardApi, OrchestratedMission } from "../lib/api.js";
import { useI18n } from "./i18n/index.js";
import { CyberRetypeTitle } from "./CyberRetypeTitle.js";
import {
  IconShield,
  IconTarget,
  IconBolt,
  IconAnthropic,
  IconOpenAI,
  IconGemini,
  IconNvidia,
  IconCpu,
  IconBrain,
  IconCheck,
  IconClose,
  IconCopy,
} from "./icons.js";
import { ChatMessageContent } from "./ChatMessageContent.js";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  mission?: OrchestratedMission;
}

export interface EngineOption {
  id: string;
  label: string;
  category: "auto" | "acp" | "api" | "local" | "freellm";
  profileKey?: string;
  models: { id: string; label: string }[];
}

function modelsForAgent(profileId: string, modelName?: string | null): { id: string; label: string }[] {
  const norm = profileId.toLowerCase();
  const defModel = modelName ? modelName.toLowerCase() : "";

  if (norm.includes("claude")) {
    const isOpusDefault = defModel.includes("opus");
    return [
      {
        id: "auto",
        label: isOpusDefault
          ? `Auto (${modelName || "Claude Opus"} - Par défaut)`
          : `Auto (${modelName || "Claude Sonnet"} - Par défaut)`,
      },
      { id: "opus", label: "Claude Opus (Complexe & approfondi)" },
      { id: "sonnet", label: "Claude Sonnet (Défaut standard)" },
      { id: "opus[1m]", label: "Claude Opus 1M (Contexte 1M)" },
      { id: "haiku", label: "Claude Haiku (Ultra rapide)" },
      { id: "claude-fable-5[1m]", label: "Claude Fable 1M (Tâches extrêmes)" },
    ];
  }
  if (norm.includes("codex") || norm.includes("openai")) {
    const isSolDefault = defModel.includes("sol") || defModel.includes("gpt-5");
    const isGpt6Default = defModel.includes("gpt-6");
    return [
      {
        id: "auto",
        label: isGpt6Default
          ? `Auto (${modelName || "GPT-6-Astra"} - Par défaut)`
          : isSolDefault
          ? `Auto (${modelName || "GPT-5.6-Sol"} - Par défaut)`
          : `Auto (${modelName || "Codex"} - Par défaut)`,
      },
      { id: "gpt-6-astra", label: "GPT-6-Astra (Frontier intelligence)" },
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol (Modèle de travail standard)" },
      { id: "gpt-5.6-terra", label: "GPT-5.6-Terra (Équilibré)" },
      { id: "gpt-5.6-luna", label: "GPT-5.6-Luna (Rapide & efficace)" },
    ];
  }
  if (norm.includes("gemini") || norm.includes("antigravity") || norm.includes("agy")) {
    return [
      { id: "auto", label: `Auto (${modelName || "Gemini 3.8 Flash High"} - Par défaut)` },
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash High (Défaut)" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (Raisonnement profond)" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (Rapide)" },
    ];
  }
  if (norm.includes("grok")) {
    return [
      { id: "auto", label: `Auto (${modelName || "Grok 3"} - Par défaut)` },
      { id: "grok-3", label: "Grok 3 (Deep Thinking)" },
      { id: "grok-2", label: "Grok 2" },
      { id: "grok-beta", label: "Grok Beta" },
    ];
  }
  if (norm.includes("cursor")) {
    return [
      { id: "auto", label: `Auto (${modelName || "Cursor Fast"} - Par défaut)` },
      { id: modelName || "cursor-fast", label: modelName ? `${modelName} (Défini)` : "Cursor Fast" },
    ];
  }
  return [
    { id: "auto", label: `Auto (${modelName || "Défaut agent"})` },
    { id: modelName || "default", label: modelName || "Modèle par défaut" },
  ];
}

function effortsForAgent(profileId: string): { id: "auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"; label: string }[] {
  const norm = profileId.toLowerCase();
  if (norm.includes("codex") || norm.includes("openai")) {
    return [
      { id: "auto", label: "Auto" },
      { id: "low", label: "Bas" },
      { id: "medium", label: "Moy" },
      { id: "high", label: "Haut" },
      { id: "xhigh", label: "X-Haut" },
      { id: "max", label: "Max" },
      { id: "ultra", label: "Ultra" },
    ];
  }
  if (norm.includes("claude")) {
    return [
      { id: "auto", label: "Auto" },
      { id: "low", label: "Bas" },
      { id: "medium", label: "Moy" },
      { id: "high", label: "Haut" },
      { id: "xhigh", label: "X-Haut" },
      { id: "max", label: "Max" },
    ];
  }
  return [
    { id: "auto", label: "Auto" },
    { id: "low", label: "Bas" },
    { id: "medium", label: "Moy" },
    { id: "high", label: "Haut" },
  ];
}

function getEngineIcon(engineId: string, size = 14) {
  if (engineId === "auto") {
    return <IconBolt size={size} color="var(--nx-accent-line, #38bdf8)" />;
  }
  const norm = engineId.toLowerCase();
  if (norm.includes("claude") || norm.includes("anthropic")) {
    return <IconAnthropic size={size} color="#f59e0b" />;
  }
  if (norm.includes("codex") || norm.includes("openai") || norm.includes("gpt")) {
    return <IconOpenAI size={size} color="#10b981" />;
  }
  if (norm.includes("gemini") || norm.includes("antigravity") || norm.includes("agy") || norm.includes("deepmind")) {
    return <IconGemini size={size} color="#38bdf8" />;
  }
  if (norm.includes("freellm") || norm.includes("nvidia")) {
    return <IconNvidia size={size} color="#22c55e" />;
  }
  if (norm.startsWith("local:")) {
    return <IconCpu size={size} color="#a855f7" />;
  }
  return <IconBolt size={size} color="var(--nx-accent-line, #38bdf8)" />;
}

export function NexusChat({ api }: { api: DashboardApi }) {
  const { t, locale, tr } = useI18n();
  const restoredMission = readMissionFromUrl();
  const [messages, setMessages] = useState<ChatMessage[]>(
    restoredMission === null
      ? []
      : [
          {
            id: restoredMission,
            role: "assistant",
            text: "",
            mission: pendingMission(restoredMission),
          },
        ],
  );
  const [draft, setDraft] = useState("");
  const [activeMission, setActiveMission] = useState<string | null>(restoredMission);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Dynamic Engine, Model & Effort selection states
  const [engineOptions, setEngineOptions] = useState<EngineOption[]>([
    {
      id: "auto",
      label: "Auto (NEXUS Orchestrator)",
      category: "auto",
      models: [{ id: "auto", label: "Auto (Intelligent Router)" }],
    },
  ]);
  const [selectedEngine, setSelectedEngine] = useState<string>("auto");
  const [selectedModel, setSelectedModel] = useState<string>("auto");
  const [reasoningEffort, setReasoningEffort] = useState<"auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra">("auto");
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const configPanelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close config panel on click outside or Escape
  useEffect(() => {
    if (!isConfigOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      const target = e.target as Node;
      const inPanel =
        (configPanelRef.current && path.includes(configPanelRef.current)) ||
        configPanelRef.current?.contains(target);
      const inButton =
        (buttonRef.current && path.includes(buttonRef.current)) ||
        buttonRef.current?.contains(target);

      if (!inPanel && !inButton) {
        setIsConfigOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsConfigOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isConfigOpen]);

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      api.agents(),
      api.llmEngines(),
      api.freeLlmStatus(),
      api.connections(),
    ]).then(([agentsRes, enginesRes, freeLlmRes]) => {
      if (!active) return;
      const options: EngineOption[] = [
        {
          id: "auto",
          label: tr("Auto (NEXUS Orchestrator)", "Auto (Orchestrateur NEXUS)"),
          category: "auto",
          models: [{ id: "auto", label: tr("Auto (Intelligent Router)", "Auto (Routeur Intelligent)") }],
        },
      ];

      // 1. ACP Agents & Bridges
      if (agentsRes.status === "fulfilled" && agentsRes.value.available.length > 0) {
        for (const profile of agentsRes.value.available) {
          options.push({
            id: `acp:${profile.id}`,
            label: `${profile.name || profile.id} [${profile.model || "défaut"}]`,
            category: "acp",
            profileKey: profile.id,
            models: modelsForAgent(profile.id, profile.model),
          });
        }
      } else {
        const defaultProfiles = [
          { id: "claude-code", name: "Claude Code", model: "claude-sonnet-4-6" },
          { id: "openai-codex", name: "OpenAI Codex", model: "o3-mini" },
          { id: "antigravity", name: "Antigravity (Gemini)", model: "gemini-3.8-flash-high" },
          { id: "cursor-agent", name: "Cursor Bridge", model: "cursor-fast" },
          { id: "grok-agent", name: "xAI Grok", model: "grok-3" },
          { id: "opencode", name: "OpenCode Local", model: "opencode-local" },
        ];
        for (const p of defaultProfiles) {
          options.push({
            id: `acp:${p.id}`,
            label: `${p.name} [${p.model}]`,
            category: "acp",
            profileKey: p.id,
            models: modelsForAgent(p.id, p.model),
          });
        }
      }

      // 2. Cloud LLM APIs & Local Runtimes
      if (enginesRes.status === "fulfilled") {
        const { engines, localDevices } = enginesRes.value;
        for (const eng of engines) {
          if (eng.kind === "paid-api") {
            options.push({
              id: `api:${eng.id}`,
              label: `${eng.label || eng.provider} (${eng.model})`,
              category: "api",
              models: [{ id: eng.model, label: eng.model }],
            });
          } else if (eng.kind === "device") {
            options.push({
              id: `device:${eng.id}`,
              label: `${eng.label || eng.runtime} (${eng.model})`,
              category: "local",
              models: [{ id: eng.model, label: eng.model }],
            });
          }
        }
        for (const dev of localDevices) {
          options.push({
            id: `device:${dev.id}`,
            label: `${dev.name} (Local Hardware)`,
            category: "local",
            models: [
              { id: "llama3.3", label: "Llama 3.3 (Local)" },
              { id: "qwen2.5", label: "Qwen 2.5 (Local)" },
              { id: "mistral", label: "Mistral (Local)" },
            ],
          });
        }
      }

      // 3. FreeLLM & NVIDIA NIM
      if (freeLlmRes.status === "fulfilled" && freeLlmRes.value) {
        const free = freeLlmRes.value;
        options.push({
          id: "freellm",
          label: `FreeLLM ${free.nvidiaConfigured ? "(NVIDIA NIM)" : "(Keyless)"} [${free.model || "auto"}]`,
          category: "freellm",
          models: [
            { id: free.model || "auto", label: `${free.model || "auto"} (Défaut Free)` },
            { id: "meta/llama-3.1-70b-instruct", label: "meta/llama-3.1-70b-instruct" },
            { id: "mistralai/mistral-large-2-instruct", label: "mistralai/mistral-large-2-instruct" },
            { id: "deepseek-ai/deepseek-r1", label: "deepseek-ai/deepseek-r1" },
          ],
        });
      }

      setEngineOptions(options);
    });

    return () => {
      active = false;
    };
  }, [api, tr]);

  const handleEngineChange = (engineId: string) => {
    setSelectedEngine(engineId);
    const eng = engineOptions.find((e) => e.id === engineId);
    if (eng && eng.models.length > 0) {
      setSelectedModel(eng.models[0]?.id ?? "auto");
    } else {
      setSelectedModel("auto");
    }
  };

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const missionId = activeMission;
    if (missionId === null) return;
    const timer = window.setInterval(() => {
      void api
        .nexusMission(missionId)
        .then((mission) => {
          setMessages((current) =>
            current.map((message) =>
              message.mission?.missionId === missionId ? { ...message, mission } : message,
            ),
          );
          if (
            mission.state === "succeeded" ||
            mission.state === "failed" ||
            mission.error !== null
          ) {
            setActiveMission(null);
          }
        })
        .catch((cause: unknown) => {
          setError(
            cause instanceof Error
              ? cause.message
              : tr("Mission tracking unavailable.", "Suivi de mission impossible."),
          );
          setActiveMission(null);
        });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [activeMission, api, tr]);

  const submit = (): void => {
    const text = draft.trim();
    if (text.length === 0 || activeMission !== null) return;
    setDraft("");
    setError(null);
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text }]);

    const engine = engineOptions.find((e) => e.id === selectedEngine);
    const options: {
      profile?: string;
      model?: string;
      reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    } = {};
    if (engine?.profileKey) options.profile = engine.profileKey;
    if (selectedModel && selectedModel !== "auto") options.model = selectedModel;
    if (reasoningEffort !== "auto") options.reasoningEffort = reasoningEffort;

    void api
      .sendToNexus(text, options)
      .then((mission) => {
        setMessages((current) => [
          ...current,
          { id: crypto.randomUUID(), role: "assistant", text: "", mission },
        ]);
        if (mission.state === "scheduled" || mission.response !== null) return;
        const url = new URL(window.location.href);
        url.searchParams.set("mission", mission.missionId);
        window.history.replaceState(null, "", url);
        setActiveMission(mission.missionId);
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : tr("NEXUS could not start the mission.", "NEXUS n'a pas pu démarrer la mission."),
        );
      });
  };

  const activeEngine = engineOptions.find((e) => e.id === selectedEngine);
  const currentModels = activeEngine?.models ?? [];
  const activeModel = currentModels.find((m) => m.id === selectedModel);

  return (
    <section className="nexus-chat">
      {/* Top Futuristic Cockpit Telemetry Strip */}
      <div
        className="chat-cockpit-strip"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "0.5rem 0.25rem 0.75rem",
          borderBottom: "1px solid rgba(0, 240, 255, 0.15)",
          marginBottom: "0.5rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <span className="radar-pulse-ring" />
          <span
            style={{
              fontFamily: "var(--nx-font-mono, monospace)",
              fontSize: "0.75rem",
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--accent, #00f0ff)",
            }}
          >
            {tr(
              "NEXUS NEURAL LINK // COGNITIVE DISPATCHER",
              "LIAISON NEURALE NEXUS // RÉPARTITEUR COGNITIF",
            )}
          </span>
        </div>
        <div>
          {activeMission !== null ? (
            <span className="hud-telemetry-badge" style={{ borderColor: "var(--accent, #00f0ff)" }}>
              <span className="hud-audio-bars">
                <span className="hud-audio-bar" />
                <span className="hud-audio-bar" />
                <span className="hud-audio-bar" />
                <span className="hud-audio-bar" />
                <span className="hud-audio-bar" />
              </span>
              <strong>{tr("ORCHESTRATING", "ORCHESTRATION EN COURS")}</strong>
            </span>
          ) : (
            <span className="hud-telemetry-badge">
              <span className="system-dot" />
              <span>{tr("ONLINE // STANDBY", "EN LIGNE // EN ATTENTE")}</span>
            </span>
          )}
        </div>
      </div>

      <div className="chat-feed" aria-live="polite">
        {messages.length === 0 ? (
          <div className="chat-welcome">
            <div
              className="nexus-mark"
              style={{
                boxShadow: "0 0 25px rgba(0, 240, 255, 0.4)",
                border: "1px solid #00f0ff",
              }}
            >
              N
            </div>
            <h2>
              <CyberRetypeTitle
                text={
                  locale === "fr"
                    ? "Que souhaitez-vous accomplir ?"
                    : "What would you like to accomplish?"
                }
              />
            </h2>
            <p>
              {locale === "fr"
                ? "Échangez avec NEXUS. Il sélectionne les agents, répartit les tâches, compare leurs résultats et fournit une synthèse unifiée."
                : "Talk to NEXUS. It selects agents, distributes work, compares their answers, and delivers a single outcome."}
            </p>

            {/* Quick Dispatch Prompt Buttons (T3 Code style) */}
            <div className="chat-suggestions">
              <button
                type="button"
                className="chat-suggestion-btn"
                onClick={() =>
                  setDraft(
                    tr(
                      "Run full security and governance audit across all workers",
                      "Lancer un audit complet de sécurité et gouvernance sur tous les agents",
                    ),
                  )
                }
              >
                <IconShield size={14} />
                <span>{tr("Audit security & workers", "Auditer sécurité & agents")}</span>
              </button>
              <button
                type="button"
                className="chat-suggestion-btn"
                onClick={() =>
                  setDraft(
                    tr(
                      "Scan career opportunities and summarize top research positions",
                      "Scanner les opportunités de carrière et résumer les meilleures thèses",
                    ),
                  )
                }
              >
                <IconTarget size={14} />
                <span>{tr("Scan career opportunities", "Scanner les opportunités")}</span>
              </button>
              <button
                type="button"
                className="chat-suggestion-btn"
                onClick={() =>
                  setDraft(
                    tr(
                      "Inspect task work queue and optimize routing affinities",
                      "Inspecter la file de travail et optimiser les affinités de routage",
                    ),
                  )
                }
              >
                <IconBolt size={14} />
                <span>{tr("Optimize routing matrix", "Optimiser le routage")}</span>
              </button>
            </div>
          </div>
        ) : null}
        {messages.map((message) => (
          <article key={message.id} className={`chat-message ${message.role}`}>
            {message.role === "user" ? (
              <>
                <div className="chat-role">
                  {locale === "fr" ? "Vous" : "You"}
                </div>
                <div className="chat-text">
                  <ChatMessageContent content={message.text} />
                </div>
              </>
            ) : (
              <>
                <div className="chat-header-bar">
                  <div className="chat-header-left">
                    <span className="chat-avatar-badge">N</span>
                    <span className="chat-header-name">NEXUS</span>
                    {message.mission?.profiles && message.mission.profiles.length > 0 && (
                      <span className="chat-header-badge">
                        {message.mission.profiles.join(", ")}
                      </span>
                    )}
                  </div>
                  {(message.mission?.response || message.text) && (
                    <CopyButton text={message.mission?.response ?? message.text} />
                  )}
                </div>
                {message.mission === undefined ? (
                  <div className="chat-text">
                    <ChatMessageContent content={message.text} />
                  </div>
                ) : (
                  <MissionReply mission={message.mission} />
                )}
              </>
            )}
          </article>
        ))}
        {error !== null ? <div className="chat-error">{error}</div> : null}
        <div ref={endRef} />
      </div>

      <form
        className="chat-composer"
        action="javascript:void(0);"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          aria-label="Mission for NEXUS"
          value={draft}
          disabled={activeMission !== null}
          placeholder={
            activeMission === null
              ? t("chat.inputPlaceholder")
              : locale === "fr"
                ? "Les agents travaillent…"
                : "Agents are working…"
          }
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />

        <div className="chat-composer-bottom">
          <div className="composer-selectors" style={{ position: "relative" }}>
            {/* Single Unified T3-Code Style Config Button */}
            <button
              ref={buttonRef}
              type="button"
              id="nexus-t3-config-button"
              className={`t3-composer-pill-btn ${isConfigOpen ? "active" : ""}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsConfigOpen((v) => !v);
              }}
              title={tr("Configure Engine, Model and Effort", "Configurer le moteur, le modèle et l'effort")}
              aria-expanded={isConfigOpen}
            >
              <span className="t3-pill-icon">{getEngineIcon(selectedEngine, 13)}</span>
              <span className="t3-pill-label">
                {activeEngine?.label || tr("Auto", "Auto")}
              </span>
              {selectedModel !== "auto" && (
                <>
                  <span className="t3-pill-sep">·</span>
                  <span className="t3-pill-sub">{activeModel?.label || selectedModel}</span>
                </>
              )}
              {reasoningEffort !== "auto" && (
                <>
                  <span className="t3-pill-sep">·</span>
                  <span className="t3-pill-sub">{tr("Effort:", "Effort :")} {reasoningEffort}</span>
                </>
              )}
              <svg className={`t3-pill-arrow ${isConfigOpen ? "open" : ""}`} viewBox="0 0 16 16" width="10" height="10" fill="currentColor">
                <path d="m4 6 4 4 4-4" />
              </svg>
            </button>

            {/* Popover Panel floating above button */}
            {isConfigOpen && (
              <div className="t3-config-popover" ref={configPanelRef}>
                <div className="t3-popover-header">
                  <span className="t3-popover-title">{tr("Configuration de l'IA", "AI Engine & Model")}</span>
                  <button
                    type="button"
                    className="t3-popover-close"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setIsConfigOpen(false);
                    }}
                    title={tr("Fermer", "Close")}
                  >
                    <IconClose size={13} />
                  </button>
                </div>

                <div className="t3-popover-body">
                  {/* Section 1: Engine */}
                  <div>
                    <div className="t3-popover-section-title">
                      <span>▾ {tr("Engine:", "Moteur :")}</span>
                    </div>
                    <div className="t3-options-list">
                      {engineOptions.map((opt) => {
                        const isSelected = opt.id === selectedEngine;
                        const badgeText =
                          opt.category === "auto"
                            ? "NEXUS"
                            : opt.category === "acp"
                              ? "ACP"
                              : opt.category === "api"
                                ? "API"
                                : opt.category === "freellm"
                                  ? "Gratuit"
                                  : "Local";
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            className={`t3-option-item ${isSelected ? "selected" : ""}`}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleEngineChange(opt.id);
                            }}
                          >
                            <div className="t3-option-left">
                              <span className="t3-option-icon">{getEngineIcon(opt.id, 14)}</span>
                              <div className="t3-option-text">
                                <span className="t3-option-name">{opt.label}</span>
                              </div>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                              <span className="t3-option-badge">{badgeText}</span>
                              {isSelected && <IconCheck size={13} color="var(--nx-accent-line, #38bdf8)" />}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Section 2: Model */}
                  {currentModels.length > 0 && (
                    <div>
                      <div className="t3-popover-section-title">
                        <span>▾ {tr("Model:", "Modèle :")}</span>
                      </div>
                      <div className="t3-options-list">
                        {currentModels.map((m) => {
                          const isSelected = m.id === selectedModel;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              className={`t3-option-item ${isSelected ? "selected" : ""}`}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setSelectedModel(m.id);
                              }}
                            >
                              <div className="t3-option-left">
                                <span className="t3-option-icon">
                                  <IconBrain size={13} color={isSelected ? "var(--nx-accent-line, #38bdf8)" : "#94a3b8"} />
                                </span>
                                <div className="t3-option-text">
                                  <span className="t3-option-name">{m.label}</span>
                                </div>
                              </div>
                              {isSelected && <IconCheck size={13} color="var(--nx-accent-line, #38bdf8)" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Section 3: Reasoning Effort */}
                  <div>
                    <div className="t3-popover-section-title">
                      <span>▾ {tr("Effort:", "Effort :")}</span>
                    </div>
                    <div className="t3-effort-group">
                      {effortsForAgent(activeEngine?.profileKey || selectedEngine).map((eff) => {
                        const isEffortActive = reasoningEffort === eff.id;
                        return (
                          <button
                            key={eff.id}
                            type="button"
                            className={`t3-effort-btn ${isEffortActive ? "active" : ""}`}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setReasoningEffort(eff.id);
                            }}
                          >
                            {eff.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="composer-actions">
            <span className="composer-hint">
              {tr("Enter ↵ to send", "Entrée ↵ pour envoyer")}
            </span>
            <button
              type="submit"
              className="composer-send-btn"
              disabled={activeMission !== null || draft.trim().length === 0}
              aria-label={t("chat.send")}
            >
              <span>{t("chat.send")}</span>
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 12V4M4 8l4-4 4 4" />
              </svg>
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}

function readMissionFromUrl(): string | null {
  const url = new URL(window.location.href);
  let value = url.searchParams.get("mission");
  if (!value && url.hash.includes("?")) {
    const hashQuery = url.hash.split("?")[1];
    if (hashQuery) {
      value = new URLSearchParams(hashQuery).get("mission");
    }
  }
  return value !== null && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function pendingMission(missionId: string): OrchestratedMission {
  return {
    missionId,
    title: "NEXUS Mission",
    state: "pending",
    profiles: [],
    completedTasks: 0,
    totalTasks: 1,
    response: null,
    error: null,
  };
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="chat-copy-all-btn"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      title="Copier la réponse"
    >
      {copied ? (
        <>
          <IconCheck size={12} color="#00ff88" />
          <span style={{ color: "#00ff88" }}>Copié</span>
        </>
      ) : (
        <>
          <IconCopy size={12} />
          <span>Copier</span>
        </>
      )}
    </button>
  );
}

function MissionReply({ mission }: { mission: OrchestratedMission }) {
  const { tr } = useI18n();
  if (mission.response !== null) {
    return (
      <div className="chat-text">
        <ChatMessageContent content={mission.response} />
      </div>
    );
  }
  if (mission.error !== null || mission.state === "failed") {
    return (
      <div className="chat-error">
        {mission.error ?? tr("Mission failed.", "Échec de la mission.")}
      </div>
    );
  }
  const percent =
    mission.totalTasks === 0 ? 0 : Math.round((mission.completedTasks / mission.totalTasks) * 100);
  return (
    <div className="mission-progress">
      <div className="agent-line">
        {mission.profiles.map((profile) => (
          <span key={profile}>{profile}</span>
        ))}
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label="Mission progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          style={{
            width: `${String(percent)}%`,
            background: "linear-gradient(90deg, #00f0ff, #00ff88)",
            boxShadow: "0 0 10px rgba(0, 240, 255, 0.6)",
          }}
        />
      </div>
      <div
        className="muted"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          marginTop: "0.4rem",
        }}
      >
        <span className="hud-audio-bars">
          <span className="hud-audio-bar" />
          <span className="hud-audio-bar" />
          <span className="hud-audio-bar" />
          <span className="hud-audio-bar" />
          <span className="hud-audio-bar" />
        </span>
        <span>
          {tr(
            `NEXUS orchestrating mission · ${String(mission.completedTasks)}/${String(mission.totalTasks)} tasks completed (${percent}%)`,
            `NEXUS orchestre la mission · ${String(mission.completedTasks)}/${String(mission.totalTasks)} tâches accomplies (${percent}%)`,
          )}
        </span>
      </div>
    </div>
  );
}
