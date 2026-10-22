import { useState } from "react";
import { activeTasks, pendingConfirmations, unreadNotifications } from "@nexus/client-core";
import { useNexus, type Screen } from "../lib/nexus.js";
import { Chat } from "./Chat.js";
import { Devices, Memory, Notifications, Settings, Tasks, Worker } from "./Screens.js";
import { ConnectionBanner, ErrorBanner } from "./cards.js";
import { Login } from "./Login.js";
import { NexusOrb } from "./NexusOrb.js";
import { nexusVisualState } from "./visual-state.js";

const TITRES: Record<Screen, string> = {
  chat: "Conversation",
  tasks: "Tasks",
  devices: "Devices",
  notifications: "Notifications",
  memory: "Memory",
  worker: "Local Worker",
  settings: "Settings",
};
const NAVIGATION: { screen: Screen; icon: string }[] = [
  { screen: "chat", icon: "◌" },
  { screen: "tasks", icon: "↗" },
  { screen: "devices", icon: "◇" },
  { screen: "notifications", icon: "◉" },
  { screen: "memory", icon: "◫" },
  { screen: "worker", icon: "⌁" },
  { screen: "settings", icon: "⚙" },
];

export function App() {
  const nexus = useNexus();
  const [ecran, setEcran] = useState<Screen>("chat");
  if (!nexus.ready) return <p className="empty-state">Opening NEXUS…</p>;
  if (!nexus.authenticated) return <Login />;

  const attente = pendingConfirmations(nexus.state).length;
  const nonLues = unreadNotifications(nexus.state).length;
  const visualState = nexusVisualState({
    online: nexus.state.online,
    connection: nexus.state.connection,
    activeTasks: activeTasks(nexus.state).length,
    waitingConfirmations: attente,
    voiceState: nexus.voiceState,
    lastError: nexus.state.lastError?.message ?? null,
  });
  return (
    <div className="app nexus-background">
      <nav className="sidebar" aria-label="NEXUS Navigation">
        <div className="brand-lockup">
          <NexusOrb state={visualState} compact />
          <div>
            <h1>NEXUS</h1>
            <span>Personal intelligence OS</span>
          </div>
        </div>
        <div className="nav-section-label">System</div>
        {NAVIGATION.map(({ screen, icon }) => (
          <NavItem
            key={screen}
            screen={screen}
            icon={icon}
            current={ecran}
            onSelect={setEcran}
            badge={screen === "chat" ? attente : screen === "notifications" ? nonLues : undefined}
          />
        ))}
        <div className="sidebar-presence">
          <div className="presence-line">
            <span
              className={`presence-dot ${nexus.worker.state === "online" ? "is-online" : ""}`}
            />
            <span>Local worker</span>
          </div>
          <div className="muted">{nexus.worker.state}</div>
        </div>
      </nav>
      <main className="main">
        <header className="header">
          <div>
            <span className="eyebrow">NEXUS / {ecran}</span>
            <h2>{TITRES[ecran]}</h2>
          </div>
          <div className="system-state" aria-live="polite">
            <span className={`presence-dot ${nexus.state.online ? "is-online" : ""}`} />
            {nexus.boundDeviceId === null ? "Device not bound" : nexus.state.connection}
          </div>
        </header>
        <ConnectionBanner connection={nexus.state.connection} online={nexus.state.online} />
        <ErrorBanner
          error={nexus.state.lastError}
          onDismiss={nexus.dismissError}
          onRetry={() => {
            void nexus.realtime.start();
          }}
        />
        {ecran === "chat" ? <Chat /> : null}
        {ecran === "tasks" ? <Tasks /> : null}
        {ecran === "devices" ? <Devices /> : null}
        {ecran === "notifications" ? <Notifications /> : null}
        {ecran === "memory" ? <Memory /> : null}
        {ecran === "worker" ? <Worker /> : null}
        {ecran === "settings" ? <Settings /> : null}
      </main>
    </div>
  );
}
function NavItem(props: {
  screen: Screen;
  icon: string;
  current: Screen;
  onSelect: (screen: Screen) => void;
  badge?: number | undefined;
}) {
  return (
    <button
      type="button"
      className="nav-item"
      aria-current={props.current === props.screen ? "page" : undefined}
      onClick={() => {
        props.onSelect(props.screen);
      }}
    >
      <span className="nav-icon" aria-hidden="true">
        {props.icon}
      </span>
      <span>{TITRES[props.screen]}</span>
      {props.badge === undefined || props.badge === 0 ? null : (
        <span className="badge">{props.badge}</span>
      )}
    </button>
  );
}
