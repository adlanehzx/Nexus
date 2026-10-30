import { useEffect, useRef, useState } from "react";
import type { DashboardApi, OrchestratedMission } from "../lib/api.js";
import { useI18n } from "./i18n/index.js";
import { CyberRetypeTitle } from "./CyberRetypeTitle.js";
import { IconShield, IconTarget, IconBolt } from "./icons.js";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  mission?: OrchestratedMission;
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
    void api
      .sendToNexus(text)
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

            {/* Quick Dispatch Prompt Buttons */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "0.6rem",
                justifyContent: "center",
                marginTop: "1.75rem",
              }}
            >
              <button
                type="button"
                className="button compact"
                style={{
                  background: "rgba(13, 21, 39, 0.8)",
                  borderColor: "rgba(0, 240, 255, 0.25)",
                  fontSize: "0.82rem",
                  padding: "0.45rem 0.85rem",
                }}
                onClick={() =>
                  setDraft(
                    tr(
                      "Run full security and governance audit across all workers",
                      "Lancer un audit complet de sécurité et gouvernance sur tous les agents",
                    ),
                  )
                }
              >
                <IconShield size={15} color="#00f0ff" style={{ marginRight: 6 }} />
                {tr("Audit security & workers", "Auditer sécurité & agents")}
              </button>
              <button
                type="button"
                className="button compact"
                style={{
                  background: "rgba(13, 21, 39, 0.8)",
                  borderColor: "rgba(0, 240, 255, 0.25)",
                  fontSize: "0.82rem",
                  padding: "0.45rem 0.85rem",
                  display: "inline-flex",
                  alignItems: "center",
                }}
                onClick={() =>
                  setDraft(
                    tr(
                      "Scan career opportunities and summarize top research positions",
                      "Scanner les opportunités de carrière et résumer les meilleures thèses",
                    ),
                  )
                }
              >
                <IconTarget size={15} color="#00f0ff" style={{ marginRight: 6 }} />
                {tr("Scan career opportunities", "Scanner les opportunités")}
              </button>
              <button
                type="button"
                className="button compact"
                style={{
                  background: "rgba(13, 21, 39, 0.8)",
                  borderColor: "rgba(0, 240, 255, 0.25)",
                  fontSize: "0.82rem",
                  padding: "0.45rem 0.85rem",
                  display: "inline-flex",
                  alignItems: "center",
                }}
                onClick={() =>
                  setDraft(
                    tr(
                      "Inspect task work queue and optimize routing affinities",
                      "Inspecter la file de travail et optimiser les affinités de routage",
                    ),
                  )
                }
              >
                <IconBolt size={15} color="#00f0ff" style={{ marginRight: 6 }} />
                {tr("Optimize routing matrix", "Optimiser le routage")}
              </button>
            </div>
          </div>
        ) : null}
        {messages.map((message) => (
          <article key={message.id} className={`chat-message ${message.role}`}>
            <div className="chat-role">
              {message.role === "user" ? (locale === "fr" ? "Vous" : "You") : "NEXUS"}
            </div>
            {message.mission === undefined ? <div className="chat-text">{message.text}</div> : null}
            {message.mission !== undefined ? <MissionReply mission={message.mission} /> : null}
          </article>
        ))}
        {error !== null ? <div className="chat-error">{error}</div> : null}
        <div ref={endRef} />
      </div>

      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.35rem" }}>
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
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "0.72rem",
              color: "var(--muted-text, #8b949e)",
              padding: "0 0.25rem",
            }}
          >
            <span>
              {tr(
                "Shift+Enter for newline · Enter to send",
                "Maj+Entrée pour nouvelle ligne · Entrée pour envoyer",
              )}
            </span>
          </div>
        </div>
        <button
          type="submit"
          className="button primary"
          disabled={activeMission !== null || draft.trim().length === 0}
        >
          {t("chat.send")}
        </button>
      </form>
    </section>
  );
}

function readMissionFromUrl(): string | null {
  const value = new URL(window.location.href).searchParams.get("mission");
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

function MissionReply({ mission }: { mission: OrchestratedMission }) {
  const { tr } = useI18n();
  if (mission.response !== null) return <div className="chat-text">{mission.response}</div>;
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
