import { useState } from "react";
import { useNexus } from "../lib/nexus.js";
import { NexusOrb } from "./NexusOrb.js";

/** The password is cleared before the async session exchange starts. */
export function Login() {
  const nexus = useNexus();
  const [email, setEmail] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const soumettre = () => {
    setOccupe(true); setErreur(null);
    const secret = motDePasse; setMotDePasse("");
    void nexus.signIn(email.trim(), secret).catch((cause: unknown) => {
      setErreur(cause instanceof Error ? cause.message : "Connexion impossible.");
    }).finally(() => { setOccupe(false); });
  };
  return (
    <main className="login-shell nexus-background">
      <section className="login-intro" aria-hidden="true">
        <NexusOrb state={occupe ? "planning" : "idle"} />
        <span className="eyebrow">Personal intelligence operating system</span>
        <h1>Votre système<br />vous attend.</h1>
        <p>Une présence unifiée pour vos appareils, vos tâches et vos décisions sensibles.</p>
      </section>
      <section className="login-panel" aria-label="Connexion à NEXUS">
        <span className="eyebrow">Connexion sécurisée</span><h2>Entrer dans NEXUS</h2>
        <p className="faible">Poste Windows — client et exécutant local.</p>
        <form onSubmit={(event) => { event.preventDefault(); soumettre(); }}>
          <label className="field-label" htmlFor="nexus-email">Identité</label>
          <input id="nexus-email" className="champ" type="email" autoComplete="username" placeholder="Adresse e-mail" value={email} onChange={(event) => { setEmail(event.target.value); }} />
          <label className="field-label" htmlFor="nexus-password">Clé d’accès</label>
          <input id="nexus-password" className="champ" type="password" autoComplete="current-password" placeholder="Mot de passe" value={motDePasse} onChange={(event) => { setMotDePasse(event.target.value); }} />
          <button type="submit" className="bouton primaire" disabled={occupe || email.trim().length === 0 || motDePasse.length === 0}>{occupe ? "Établissement de la session…" : "Établir la connexion"}</button>
        </form>
        {erreur === null ? null : <p className="login-error" role="alert">{erreur}</p>}
      </section>
    </main>
  );
}
