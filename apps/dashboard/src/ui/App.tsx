import { useMemo, useState } from "react";
import { DashboardApi, createSession } from "../lib/api.js";
import {
  Browser,
  Devices,
  Logs,
  Mcp,
  MissionControl,
  Memory,
  Notifications,
  Overview,
  Runs,
  Security,
  Tasks,
  Tools,
  Workers,
} from "./Sections.js";
import { NexusChat } from "./NexusChat.js";

/**
 * L'ossature du tableau de bord.
 *
 * Douze sections dans une barre latérale permanente. Pas d'onglets qui masquent :
 * sur un écran de supervision, changer de section doit coûter un clic et laisser
 * la liste visible.
 *
 * L'adresse du cœur est injectée à la compilation. **Aucun secret n'est
 * embarqué** — le tableau de bord se connecte comme n'importe quel client, et
 * c'est le rôle du compte qui lui ouvre les portes.
 */

function backendUrl(): string {
  const injected = (import.meta as { env?: { VITE_NEXUS_URL?: string } }).env;
  return injected?.VITE_NEXUS_URL ?? "http://localhost:3000";
}

const SECTIONS = [
  ["overview", "Vue d'ensemble"],
  ["devices", "Appareils"],
  ["workers", "Exécutants"],
  ["tasks", "Tâches"],
  ["runs", "Runs agent"],
  ["tools", "Outils"],
  ["mcp", "MCP"],
  ["browser", "Browser Use"],
  ["mission-control", "Missions ACP"],
  ["memory", "Mémoire"],
  ["notifications", "Notifications"],
  ["security", "Sécurité"],
  ["logs", "Journaux"],
] as const;

type SectionId = (typeof SECTIONS)[number][0] | "chat";

export function App() {
  const session = useMemo(() => createSession(backendUrl()), []);
  const api = useMemo(() => new DashboardApi(session), [session]);

  const [authenticated, setAuthenticated] = useState(false);
  const [section, setSection] = useState<SectionId>("chat");

  if (!authenticated) {
    return (
      <Login
        onSignIn={async (email, password) => {
          await session.login(email, password);
          setAuthenticated(true);
        }}
      />
    );
  }

  const title = section === "chat" ? "NEXUS" : (SECTIONS.find(([id]) => id === section)?.[1] ?? "");

  if (section === "chat") {
    return (
      <div className="chat-shell">
        <header className="chat-header">
          <strong>NEXUS</strong>
          <div>
            <button className="header-link" type="button" onClick={() => setSection("overview")}>
              Supervision
            </button>
            <button
              className="header-link"
              type="button"
              onClick={() => void session.logout().finally(() => setAuthenticated(false))}
            >
              Déconnexion
            </button>
          </div>
        </header>
        <NexusChat api={api} />
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="laterale">
        <button className="nexus-home" type="button" onClick={() => setSection("chat")}>
          NEXUS
        </button>
        <h1>Supervision</h1>
        {SECTIONS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="nav-item"
            aria-current={section === id ? "page" : undefined}
            onClick={() => {
              setSection(id);
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="principal">
        <header className="entete">
          <h2>{title}</h2>
          <button
            type="button"
            className="bouton"
            onClick={() => {
              void session.logout().finally(() => {
                setAuthenticated(false);
              });
            }}
          >
            Se déconnecter
          </button>
        </header>

        {section === "overview" ? <Overview api={api} /> : null}
        {section === "devices" ? <Devices api={api} /> : null}
        {section === "workers" ? <Workers api={api} /> : null}
        {section === "tasks" ? <Tasks api={api} /> : null}
        {section === "runs" ? <Runs api={api} /> : null}
        {section === "tools" ? <Tools api={api} /> : null}
        {section === "mcp" ? <Mcp api={api} /> : null}
        {section === "browser" ? <Browser api={api} /> : null}
        {section === "mission-control" ? <MissionControl api={api} /> : null}
        {section === "memory" ? <Memory api={api} /> : null}
        {section === "notifications" ? <Notifications api={api} /> : null}
        {section === "security" ? <Security api={api} /> : null}
        {section === "logs" ? <Logs api={api} /> : null}
      </main>
    </div>
  );
}

/**
 * Connexion.
 *
 * Le mot de passe est vidé dès l'envoi, réussite ou échec : un tableau de bord
 * reste ouvert sur un second écran, souvent dans un bureau partagé.
 */
function Login({ onSignIn }: { onSignIn: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="connexion"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);

        const secret = password;
        setPassword("");

        void onSignIn(email.trim(), secret)
          .catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : "Connexion impossible.");
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <h1 style={{ margin: 0 }}>NEXUS · supervision</h1>
      <p className="faible" style={{ marginTop: 0 }}>
        Réservé aux comptes administrateurs.
      </p>

      <input
        className="champ"
        type="email"
        autoComplete="username"
        placeholder="Adresse e-mail"
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
        }}
      />
      <input
        className="champ"
        type="password"
        autoComplete="current-password"
        placeholder="Mot de passe"
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
        }}
      />

      <button
        type="submit"
        className="bouton"
        disabled={busy || email.trim().length === 0 || password.length === 0}
      >
        {busy ? "Connexion…" : "Se connecter"}
      </button>

      {error === null ? null : <p style={{ color: "var(--hs)" }}>{error}</p>}
    </form>
  );
}
