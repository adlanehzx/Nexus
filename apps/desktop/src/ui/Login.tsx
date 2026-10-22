import { useState } from "react";
import { useNexus } from "../lib/nexus.js";
import { NexusOrb } from "./NexusOrb.js";

/** The password is cleared before the async session exchange starts. */
export function Login() {
  const nexus = useNexus();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    setBusy(true);
    setError(null);
    const secret = password;
    setPassword("");
    void nexus
      .signIn(email.trim(), secret)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Unable to sign in.");
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <main className="login-shell nexus-background">
      <section className="login-intro" aria-hidden="true">
        <NexusOrb state={busy ? "planning" : "idle"} />
        <span className="eyebrow">Personal intelligence operating system</span>
        <h1>
          Your personal system
          <br />
          awaits.
        </h1>
        <p>A unified presence for your devices, tasks, and sensitive decisions.</p>
      </section>
      <section className="login-panel" aria-label="Sign in to NEXUS">
        <span className="eyebrow">Secure connection</span>
        <h2>Sign in to NEXUS</h2>
        <p className="muted">Windows desktop — client and local worker.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="field-label" htmlFor="nexus-email">
            Identity
          </label>
          <input
            id="nexus-email"
            className="field"
            type="email"
            autoComplete="username"
            placeholder="Email address"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <label className="field-label" htmlFor="nexus-password">
            Password
          </label>
          <input
            id="nexus-password"
            className="field"
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
          <button
            type="submit"
            className="button primary"
            disabled={busy || email.trim().length === 0 || password.length === 0}
          >
            {busy ? "Establishing session…" : "Sign In"}
          </button>
        </form>
        {error === null ? null : (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
