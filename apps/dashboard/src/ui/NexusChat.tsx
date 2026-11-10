import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DashboardApi, OrchestratedMission, SendToNexusOptions } from "../lib/api.js";
import { ConversationHistory, readChatLocation, writeChatLocation } from "../lib/conversations.js";
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
  IconRefresh,
  IconStop,
  IconChevronDown,
  IconCornerDownLeft,
} from "./icons.js";
import { ChatMessageContent } from "./ChatMessageContent.js";
import { ConversationSidebar } from "./ConversationSidebar.js";

/** Below this width the history floats over the chat instead of sitting beside it. */
const HISTORY_OVERLAY_BELOW = 760;
const HISTORY_COLLAPSED_KEY = "nexus.chat.historyCollapsed";

export interface EngineOption {
  id: string;
  label: string;
  category: "auto" | "acp" | "api" | "local" | "freellm";
  profileKey?: string;
  models: { id: string; label: string }[];
}

type Translate = (enText: string, frText: string) => string;

function modelsForAgent(
  profileId: string,
  modelName: string | null | undefined,
  tr: Translate,
): { id: string; label: string }[] {
  const norm = profileId.toLowerCase();
  const defModel = modelName ? modelName.toLowerCase() : "";

  if (norm.includes("claude")) {
    const isSonnetDefault = defModel.includes("sonnet");
    const isOpusDefault = defModel.includes("opus");
    const base = modelName ?? "Claude 3.7 Sonnet";
    return [
      {
        id: "auto",
        label: isSonnetDefault
          ? `Auto (${base} - ${tr("Standard", "Standard")})`
          : isOpusDefault
            ? `Auto (${modelName ?? "Claude 3 Opus"} - ${tr("In-depth", "Approfondi")})`
            : `Auto (${base} - ${tr("Default", "Par défaut")})`,
      },
      {
        id: "claude-3-7-sonnet",
        label: `Claude 3.7 Sonnet (${tr("Hybrid & reasoning", "Hybride & raisonnement")})`,
      },
      {
        id: "claude-3-5-sonnet",
        label: `Claude 3.5 Sonnet (${tr("Fast production", "Production rapide")})`,
      },
      {
        id: "claude-3-5-haiku",
        label: `Claude 3.5 Haiku (${tr("Ultra fast", "Ultra rapide")})`,
      },
      {
        id: "claude-3-opus",
        label: `Claude 3 Opus (${tr("Complex analysis", "Analyses complexes")})`,
      },
    ];
  }
  if (norm.includes("codex") || norm.includes("openai")) {
    const isO1Default = defModel.includes("o1");
    return [
      {
        id: "auto",
        label: isO1Default
          ? `Auto (${modelName ?? "OpenAI o1"} - ${tr("Reasoning", "Raisonnement")})`
          : `Auto (${modelName ?? "GPT-4o"} - ${tr("Default", "Par défaut")})`,
      },
      { id: "gpt-4o", label: `GPT-4o (${tr("Versatile & fast", "Polyvalent & rapide")})` },
      {
        id: "gpt-4o-mini",
        label: `GPT-4o mini (${tr("Light & economical", "Léger & économique")})`,
      },
      { id: "o1", label: `OpenAI o1 (${tr("Advanced reasoning", "Raisonnement avancé")})` },
      {
        id: "o3-mini",
        label: `OpenAI o3-mini (${tr("Technical reasoning", "Raisonnement technique")})`,
      },
    ];
  }
  if (norm.includes("gemini") || norm.includes("antigravity") || norm.includes("agy")) {
    return [
      {
        id: "auto",
        label: `Auto (${modelName ?? "Gemini 2.0 Flash"} - ${tr("Default", "Par défaut")})`,
      },
      {
        id: "gemini-2.0-flash",
        label: `Gemini 2.0 Flash (${tr("High speed & multimodal", "Haute vitesse & multimodal")})`,
      },
      {
        id: "gemini-2.0-pro-exp",
        label: `Gemini 2.0 Pro (${tr("Reasoning & code", "Raisonnement et code")})`,
      },
      { id: "gemini-1.5-pro", label: `Gemini 1.5 Pro (${tr("Large context", "Grand contexte")})` },
      {
        id: "gemini-1.5-flash",
        label: `Gemini 1.5 Flash (${tr("Ultra economical", "Ultra économique")})`,
      },
    ];
  }
  if (norm.includes("grok")) {
    return [
      { id: "auto", label: `Auto (${modelName ?? "Grok 3"} - ${tr("Default", "Par défaut")})` },
      { id: "grok-3", label: "Grok 3 (Deep Thinking)" },
      { id: "grok-2", label: "Grok 2" },
      { id: "grok-beta", label: "Grok Beta" },
    ];
  }
  if (norm.includes("cursor")) {
    return [
      {
        id: "auto",
        label: `Auto (${modelName ?? "Cursor Fast"} - ${tr("Default", "Par défaut")})`,
      },
      {
        id: modelName ?? "cursor-fast",
        label: modelName ? `${modelName} (${tr("Set", "Défini")})` : "Cursor Fast",
      },
    ];
  }
  return [
    { id: "auto", label: `Auto (${modelName ?? tr("Agent default", "Défaut agent")})` },
    { id: modelName ?? "default", label: modelName ?? tr("Default model", "Modèle par défaut") },
  ];
}

function effortsForAgent(
  profileId: string,
  tr: Translate,
): {
  id: "auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  label: string;
}[] {
  const norm = profileId.toLowerCase();
  const low = { id: "low" as const, label: tr("Low", "Bas") };
  const medium = { id: "medium" as const, label: tr("Med", "Moy") };
  const high = { id: "high" as const, label: tr("High", "Haut") };
  const xhigh = { id: "xhigh" as const, label: tr("X-High", "X-Haut") };
  const auto = { id: "auto" as const, label: "Auto" };
  if (norm.includes("codex") || norm.includes("openai")) {
    return [
      auto,
      low,
      medium,
      high,
      xhigh,
      { id: "max", label: "Max" },
      { id: "ultra", label: "Ultra" },
    ];
  }
  if (norm.includes("claude")) {
    return [auto, low, medium, high, xhigh, { id: "max", label: "Max" }];
  }
  return [auto, low, medium, high];
}

function getEngineIcon(engineId: string, size = 14) {
  if (engineId === "auto") {
    return <IconBolt size={size} color="var(--nx-accent)" />;
  }
  const norm = engineId.toLowerCase();
  if (norm.includes("claude") || norm.includes("anthropic")) {
    return <IconAnthropic size={size} color="#f59e0b" />;
  }
  if (norm.includes("codex") || norm.includes("openai") || norm.includes("gpt")) {
    return <IconOpenAI size={size} color="#10b981" />;
  }
  if (
    norm.includes("gemini") ||
    norm.includes("antigravity") ||
    norm.includes("agy") ||
    norm.includes("deepmind")
  ) {
    return <IconGemini size={size} color="#38bdf8" />;
  }
  if (norm.includes("freellm") || norm.includes("nvidia")) {
    return <IconNvidia size={size} color="#22c55e" />;
  }
  if (norm.startsWith("local:")) {
    return <IconCpu size={size} color="var(--nx-signal)" />;
  }
  return <IconBolt size={size} color="var(--nx-accent)" />;
}

export interface NexusChatProps {
  api: DashboardApi;
  /** Store shared with a host that shows the conversation list itself. */
  history?: ConversationHistory;
  /** False when the host renders the conversation list (main navigation sidebar). */
  showHistory?: boolean;
}

export function NexusChat({ api, history: sharedHistory, showHistory = true }: NexusChatProps) {
  const { t, locale, tr } = useI18n();
  // The page link names the conversation and the mission in flight, so a
  // reload lands back where it was. Reading it here is free of side effects.
  const history = useMemo(
    () => sharedHistory ?? new ConversationHistory(api, readChatLocation(window.location.href)),
    [api, sharedHistory],
  );
  // Same snapshot for a static render: the store holds no browser-only state.
  const chat = useSyncExternalStore(history.subscribe, history.getSnapshot, history.getSnapshot);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [historyOverlay, setHistoryOverlay] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [dockedCollapsed, setDockedCollapsed] = useState(readHistoryCollapsed);
  const historyCollapsed = historyOverlay ? !overlayOpen : dockedCollapsed;
  const missionInFlight = chat.tracked !== null;
  const activeConversation = chat.conversations.find(
    (conversation) => conversation.id === chat.activeId,
  );
  // Empty while a conversation opened from a link is still loading.
  const activeTitle =
    chat.activeId === null
      ? tr("New conversation", "Nouvelle conversation")
      : activeConversation === undefined
        ? ""
        : activeConversation.title.trim().length > 0
          ? activeConversation.title
          : tr("Untitled conversation", "Conversation sans titre");

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
  const [reasoningEffort, setReasoningEffort] = useState<
    "auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
  >("auto");
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
        (configPanelRef.current && path.includes(configPanelRef.current)) ??
        configPanelRef.current?.contains(target);
      const inButton =
        (buttonRef.current && path.includes(buttonRef.current)) ??
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
    void Promise.allSettled([
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
          models: [
            { id: "auto", label: tr("Auto (Intelligent Router)", "Auto (Routeur Intelligent)") },
          ],
        },
      ];

      // 1. ACP Agents & Bridges
      if (agentsRes.status === "fulfilled" && agentsRes.value.available.length > 0) {
        for (const profile of agentsRes.value.available) {
          options.push({
            id: `acp:${profile.id}`,
            label: `${profile.name ?? profile.id} [${profile.model ?? tr("default", "défaut")}]`,
            category: "acp",
            profileKey: profile.id,
            models: modelsForAgent(profile.id, profile.model, tr),
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
            models: modelsForAgent(p.id, p.model, tr),
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
            {
              id: "mistralai/mistral-large-2-instruct",
              label: "mistralai/mistral-large-2-instruct",
            },
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
    void history.start();
  }, [history]);

  // The link follows the chat: conversation open, mission in flight.
  const trackedMissionId = chat.tracked?.missionId ?? null;
  useEffect(() => {
    const next = writeChatLocation(window.location.href, {
      conversationId: chat.activeId,
      missionId: trackedMissionId,
    });
    if (next !== window.location.href) window.history.replaceState(window.history.state, "", next);
  }, [chat.activeId, trackedMissionId]);

  // Polling also runs while another conversation is open: the reply is recorded
  // in its own conversation whichever one is on screen.
  useEffect(() => {
    if (trackedMissionId === null) return;
    const timer = window.setInterval(() => void history.pollTracked(), 2_000);
    return () => window.clearInterval(timer);
  }, [history, trackedMissionId]);

  // The panel docks or floats with the room the chat actually has: a spatial
  // window can be narrow on a wide screen, so the viewport alone would lie.
  // Measured once before the first paint, so a phone never flashes the docked panel.
  useLayoutEffect(() => {
    const element = shellRef.current;
    if (element === null) return;
    setHistoryOverlay(element.getBoundingClientRect().width < HISTORY_OVERLAY_BELOW);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.clientWidth;
      setHistoryOverlay(width < HISTORY_OVERLAY_BELOW);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!historyOverlay || !overlayOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOverlayOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [historyOverlay, overlayOpen]);

  // Follows the newest turn and its progress; loading earlier turns above
  // must not yank the reader to the bottom.
  const lastEntry = chat.entries.at(-1);
  const scrollKey = [
    chat.activeId ?? "new",
    lastEntry?.id ?? "",
    lastEntry?.mission?.state ?? "",
    String(lastEntry?.mission?.completedTasks ?? ""),
    lastEntry?.mission?.response === null ? "" : "answered",
  ].join(":");
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [scrollKey]);

  const toggleHistory = () => {
    if (historyOverlay) {
      setOverlayOpen((open) => !open);
      return;
    }
    const next = !dockedCollapsed;
    setDockedCollapsed(next);
    writeHistoryCollapsed(next);
  };

  const openConversation = (conversationId: string | null) => {
    if (historyOverlay) setOverlayOpen(false);
    void history.open(conversationId);
  };

  const submit = (): void => {
    const text = draft.trim();
    if (text.length === 0 || missionInFlight || chat.sending) return;
    setDraft("");

    const engine = engineOptions.find((e) => e.id === selectedEngine);
    const options: Omit<SendToNexusOptions, "conversationId"> = {};
    if (engine?.profileKey) options.profile = engine.profileKey;
    if (selectedModel && selectedModel !== "auto") options.model = selectedModel;
    if (reasoningEffort !== "auto") options.reasoningEffort = reasoningEffort;

    void history.send(text, options);
  };

  const activeEngine = engineOptions.find((e) => e.id === selectedEngine);
  const currentModels = activeEngine?.models ?? [];
  const activeModel = currentModels.find((m) => m.id === selectedModel);

  const conversation = (
    <section className="nexus-chat">
      {/* Top Futuristic Cockpit Telemetry Strip */}
      <div
        className="chat-cockpit-strip"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.35rem 0.75rem",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "0.5rem 0.25rem 0.75rem",
          borderBottom: "1px solid color-mix(in srgb, var(--nx-signal) 15%, transparent)",
          marginBottom: "0.5rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <span className="radar-pulse-ring" />
          <span
            className="chat-cockpit-label"
            style={{
              fontFamily: "var(--nx-font-mono, monospace)",
              fontSize: "0.75rem",
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--nx-signal)",
            }}
          >
            {tr(
              "NEXUS NEURAL LINK // COGNITIVE DISPATCHER",
              "LIAISON NEURALE NEXUS // RÉPARTITEUR COGNITIF",
            )}
          </span>
        </div>
        <span className="chat-active-title" title={activeTitle}>
          {activeTitle}
        </span>
        <div>
          {missionInFlight ? (
            <span className="hud-telemetry-badge" style={{ borderColor: "var(--nx-signal)" }}>
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

      <div className="chat-feed" aria-live="polite" aria-busy={chat.transcriptStatus === "loading"}>
        {chat.earlierCursor === null ? null : (
          <div className="chat-earlier">
            <button
              type="button"
              className="chat-earlier-btn"
              onClick={() => void history.loadEarlier()}
              disabled={chat.loadingEarlier}
            >
              {chat.loadingEarlier
                ? tr("Loading…", "Chargement…")
                : tr("Load earlier messages", "Charger les messages précédents")}
            </button>
          </div>
        )}
        {chat.transcriptStatus === "loading" ? (
          <div
            className="loading-state chat-transcript-loading"
            role="status"
            aria-label={tr("Loading conversation", "Chargement de la conversation")}
          >
            <span />
            <span />
            <span />
          </div>
        ) : null}
        {chat.transcriptStatus === "error" ? (
          <div className="chat-error chat-transcript-error" role="alert">
            <span>{chat.transcriptError}</span>
            <button
              type="button"
              className="chat-earlier-btn"
              onClick={() => void history.open(chat.activeId)}
            >
              <IconRefresh size={12} />
              <span>{tr("Retry", "Réessayer")}</span>
            </button>
          </div>
        ) : null}
        {chat.entries.length === 0 && chat.transcriptStatus === "ready" ? (
          <div className="chat-welcome">
            <div className="nexus-mark">N</div>
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
                      "Analyze project architecture and identify critical modules",
                      "Analyser l'architecture du projet et identifier les modules critiques",
                    ),
                  )
                }
              >
                <IconTarget size={14} />
                <span>{tr("Analyze architecture", "Analyser l'architecture")}</span>
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
        {chat.entries.map((message) => (
          <article key={message.id} className={`chat-message ${message.role}`}>
            {message.role === "user" ? (
              <>
                <div className="chat-role">{locale === "fr" ? "Vous" : "You"}</div>
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
                  {(message.mission?.response ?? message.text) && (
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
        {chat.error !== null ? (
          <div className="chat-error" role="alert">
            {chat.error}
          </div>
        ) : null}
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
          aria-label={tr("Mission for NEXUS", "Mission pour NEXUS")}
          value={draft}
          disabled={missionInFlight}
          placeholder={
            !missionInFlight
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
              title={tr(
                "Configure Engine, Model and Effort",
                "Configurer le moteur, le modèle et l'effort",
              )}
              aria-expanded={isConfigOpen}
            >
              <span className="t3-pill-icon">{getEngineIcon(selectedEngine, 13)}</span>
              <span className="t3-pill-label">{activeEngine?.label ?? tr("Auto", "Auto")}</span>
              {selectedModel !== "auto" && (
                <>
                  <span className="t3-pill-sep">·</span>
                  <span className="t3-pill-sub">{activeModel?.label ?? selectedModel}</span>
                </>
              )}
              {reasoningEffort !== "auto" && (
                <>
                  <span className="t3-pill-sep">·</span>
                  <span className="t3-pill-sub">
                    {tr("Effort:", "Effort :")} {reasoningEffort}
                  </span>
                </>
              )}
              <svg
                className={`t3-pill-arrow ${isConfigOpen ? "open" : ""}`}
                viewBox="0 0 16 16"
                width="10"
                height="10"
                fill="currentColor"
              >
                <path d="m4 6 4 4 4-4" />
              </svg>
            </button>

            {/* Popover Panel floating above button */}
            {isConfigOpen && (
              <div className="t3-config-popover" ref={configPanelRef}>
                <div className="t3-popover-header">
                  <span className="t3-popover-title">
                    {tr("AI Engine & Model", "Configuration de l'IA")}
                  </span>
                  <button
                    type="button"
                    className="t3-popover-close"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setIsConfigOpen(false);
                    }}
                    title={tr("Close", "Fermer")}
                    aria-label={tr("Close", "Fermer")}
                  >
                    <IconClose size={13} />
                  </button>
                </div>

                <div className="t3-popover-body">
                  {/* Section 1: Engine */}
                  <div>
                    <div className="t3-popover-section-title">
                      <IconChevronDown size={12} />
                      <span>{tr("Engine:", "Moteur :")}</span>
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
                                  ? tr("Free", "Gratuit")
                                  : "Local";
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            className={`t3-option-item ${isSelected ? "selected" : ""}`}
                            aria-pressed={isSelected}
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
                              {isSelected && <IconCheck size={13} color="var(--nx-accent)" />}
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
                        <IconChevronDown size={12} />
                        <span>{tr("Model:", "Modèle :")}</span>
                      </div>
                      <div className="t3-options-list">
                        {currentModels.map((m) => {
                          const isSelected = m.id === selectedModel;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              className={`t3-option-item ${isSelected ? "selected" : ""}`}
                              aria-pressed={isSelected}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setSelectedModel(m.id);
                              }}
                            >
                              <div className="t3-option-left">
                                <span className="t3-option-icon">
                                  <IconBrain
                                    size={13}
                                    color={isSelected ? "var(--nx-accent)" : "var(--nx-text-muted)"}
                                  />
                                </span>
                                <div className="t3-option-text">
                                  <span className="t3-option-name">{m.label}</span>
                                </div>
                              </div>
                              {isSelected && <IconCheck size={13} color="var(--nx-accent)" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Section 3: Reasoning Effort */}
                  <div>
                    <div className="t3-popover-section-title">
                      <IconChevronDown size={12} />
                      <span>{tr("Effort:", "Effort :")}</span>
                    </div>
                    <div className="t3-effort-group">
                      {effortsForAgent(activeEngine?.profileKey ?? selectedEngine, tr).map(
                        (eff) => {
                          const isEffortActive = reasoningEffort === eff.id;
                          return (
                            <button
                              key={eff.id}
                              type="button"
                              className={`t3-effort-btn ${isEffortActive ? "active" : ""}`}
                              aria-pressed={isEffortActive}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setReasoningEffort(eff.id);
                              }}
                            >
                              {eff.label}
                            </button>
                          );
                        },
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="composer-actions">
            <span className="composer-hint">
              {missionInFlight ? (
                tr("Mission in flight", "Mission en cours d'exécution")
              ) : (
                <>
                  <kbd>{tr("Enter", "Entrée")}</kbd>
                  <IconCornerDownLeft size={11} />
                  <span>{tr("to send", "pour envoyer")}</span>
                </>
              )}
            </span>
            {missionInFlight ? (
              <button
                type="button"
                className="composer-stop-btn"
                onClick={() => history.stopTracked()}
                aria-label={tr("Stop orchestration", "Arrêter l'orchestration")}
                title={tr(
                  "Interrupt in-flight mission tracking",
                  "Interrompre le suivi de la mission",
                )}
              >
                <IconStop size={12} color="var(--nx-danger)" />
                <span>{tr("Stop", "Arrêter")}</span>
              </button>
            ) : (
              <button
                type="submit"
                className="composer-send-btn"
                disabled={chat.sending || draft.trim().length === 0}
                aria-label={t("chat.send")}
              >
                <span>{t("chat.send")}</span>
                <svg
                  viewBox="0 0 16 16"
                  width="12"
                  height="12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M8 12V4M4 8l4-4 4 4" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </form>
    </section>
  );

  if (!showHistory) {
    return (
      <div ref={shellRef} className="nexus-chat-shell history-external">
        <div className="chat-main">{conversation}</div>
      </div>
    );
  }

  return (
    <div
      ref={shellRef}
      className={`nexus-chat-shell${historyOverlay ? " history-overlay" : ""}${historyCollapsed ? " history-collapsed" : ""}`}
    >
      <ConversationSidebar
        conversations={chat.conversations}
        activeId={chat.activeId}
        busyId={chat.tracked?.conversationId ?? null}
        status={chat.listStatus}
        error={chat.listError}
        hasMore={chat.listCursor !== null}
        collapsed={historyCollapsed}
        overlay={historyOverlay}
        onToggle={toggleHistory}
        onNew={() => openConversation(null)}
        onSelect={openConversation}
        onRename={(conversationId, title) => history.rename(conversationId, title)}
        onDelete={(conversationId) => history.remove(conversationId)}
        onLoadMore={() => void history.loadMore()}
        onRetry={() => void history.refresh()}
      />
      {historyOverlay && overlayOpen ? (
        <button
          type="button"
          className="chat-history-scrim"
          aria-label={tr("Close conversation history", "Fermer l'historique des conversations")}
          onClick={() => setOverlayOpen(false)}
        />
      ) : null}
      <div className="chat-main">{conversation}</div>
    </div>
  );
}

/** Per tab, like the session itself: nothing here writes to permanent browser storage. */
function readHistoryCollapsed(): boolean {
  try {
    return window.sessionStorage.getItem(HISTORY_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeHistoryCollapsed(collapsed: boolean): void {
  try {
    window.sessionStorage.setItem(HISTORY_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Storage unavailable: the choice lasts until the next reload.
  }
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
            background: "linear-gradient(90deg, var(--nx-signal), var(--nx-accent))",
            boxShadow: "0 0 10px color-mix(in srgb, var(--nx-signal) 60%, transparent)",
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
