import { useState } from "react";
import { pendingConfirmations, unreadNotifications } from "@nexus/client-core";
import { useNexus, type Screen } from "../lib/nexus.js";
import { Chat } from "./Chat.js";
import { Devices, Memory, Notifications, Settings, Tasks, Worker } from "./Screens.js";
import { ConnectionBanner, ErrorBanner } from "./cards.js";
import { Login } from "./Login.js";

/**
 * L'ossature de la fenêtre.
 *
 * Barre latérale permanente à gauche, écran à droite. Pas d'onglets qui
 * masquent : sur un écran de bureau, ce qui compte reste visible — le nombre de
 * confirmations en attente et de notifications non lues figure dans la barre,
 * en permanence, parce qu'une confirmation oubliée bloque une tâche.
 */

const TITRES: Record<Screen, string> = {
  chat: "Conversation",
  tasks: "Tâches",
  devices: "Appareils",
  notifications: "Notifications",
  memory: "Mémoire",
  worker: "Exécutant de ce poste",
  settings: "Réglages",
};

export function App() {
  const nexus = useNexus();
  const [ecran, setEcran] = useState<Screen>("chat");

  if (!nexus.ready) {
    return <p className="vide">Ouverture de NEXUS…</p>;
  }

  if (!nexus.authenticated) {
    return <Login />;
  }

  const attente = pendingConfirmations(nexus.state).length;
  const nonLues = unreadNotifications(nexus.state).length;

  return (
    <div className="app">
      <nav className="laterale">
        <h1>NEXUS</h1>

        <NavItem screen="chat" current={ecran} onSelect={setEcran} badge={attente} />
        <NavItem screen="tasks" current={ecran} onSelect={setEcran} />
        <NavItem screen="devices" current={ecran} onSelect={setEcran} />
        <NavItem screen="notifications" current={ecran} onSelect={setEcran} badge={nonLues} />
        <NavItem screen="memory" current={ecran} onSelect={setEcran} />
        <NavItem screen="worker" current={ecran} onSelect={setEcran} />
        <NavItem screen="settings" current={ecran} onSelect={setEcran} />

        <div style={{ marginTop: "auto", padding: "10px 8px" }}>
          <div className="faible">Exécutant local</div>
          <div className={`etiquette ${nexus.worker.state === "online" ? "ok" : "attention"}`}>
            {nexus.worker.state}
          </div>
        </div>
      </nav>

      <main className="principal">
        <header className="entete">
          <h2>{TITRES[ecran]}</h2>
          <span className="faible">
            {nexus.boundDeviceId === null
              ? "aucun appareil rattaché — voir les Réglages"
              : nexus.state.connection}
          </span>
        </header>

        <ConnectionBanner connection={nexus.state.connection} online={nexus.state.online} />
        <ErrorBanner
          error={nexus.state.lastError}
          onDismiss={() => {
            nexus.dismissError();
          }}
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
  current: Screen;
  onSelect: (screen: Screen) => void;
  badge?: number;
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
      <span>{TITRES[props.screen]}</span>
      {props.badge === undefined || props.badge === 0 ? null : (
        <span className="pastille">{props.badge}</span>
      )}
    </button>
  );
}
