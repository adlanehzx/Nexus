import { useEffect, useRef, useState } from "react";
import type { DashboardApi, OrchestratedMission } from "../lib/api.js";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  mission?: OrchestratedMission;
}

export function NexusChat({ api }: { api: DashboardApi }) {
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
          if (mission.state === "succeeded" || mission.state === "failed" || mission.error !== null) {
            setActiveMission(null);
          }
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : "Suivi de mission impossible.");
          setActiveMission(null);
        });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [activeMission, api]);

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
        const url = new URL(window.location.href);
        url.searchParams.set("mission", mission.missionId);
        window.history.replaceState(null, "", url);
        setActiveMission(mission.missionId);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "NEXUS n'a pas pu démarrer la mission.");
      });
  };

  return (
    <section className="nexus-chat">
      <div className="chat-feed" aria-live="polite">
        {messages.length === 0 ? (
          <div className="chat-welcome">
            <div className="nexus-mark">N</div>
            <h2>Que veux-tu accomplir&nbsp;?</h2>
            <p>
              Parle à NEXUS. Il choisit les agents, répartit le travail, confronte leurs réponses
              et te livre un seul résultat.
            </p>
          </div>
        ) : null}
        {messages.map((message) => (
          <article key={message.id} className={`chat-message ${message.role}`}>
            <div className="chat-role">{message.role === "user" ? "Toi" : "NEXUS"}</div>
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
        <textarea
          value={draft}
          disabled={activeMission !== null}
          placeholder={activeMission === null ? "Donne une mission à NEXUS…" : "Les agents travaillent…"}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button type="submit" disabled={activeMission !== null || draft.trim().length === 0}>
          Envoyer
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
    title: "Mission NEXUS",
    state: "pending",
    profiles: [],
    completedTasks: 0,
    totalTasks: 1,
    response: null,
    error: null,
  };
}

function MissionReply({ mission }: { mission: OrchestratedMission }) {
  if (mission.response !== null) return <div className="chat-text">{mission.response}</div>;
  if (mission.error !== null || mission.state === "failed") {
    return <div className="chat-error">{mission.error ?? "La mission a échoué."}</div>;
  }
  const percent = Math.round((mission.completedTasks / mission.totalTasks) * 100);
  return (
    <div className="mission-progress">
      <div className="agent-line">
        {mission.profiles.map((profile) => (
          <span key={profile}>{profile}</span>
        ))}
      </div>
      <div className="progress-track"><div style={{ width: `${String(percent)}%` }} /></div>
      <div className="faible">
        NEXUS orchestre la mission · {mission.completedTasks}/{mission.totalTasks} tâches terminées
      </div>
    </div>
  );
}
