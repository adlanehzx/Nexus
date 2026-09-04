import { useState } from "react";
import { useNexus } from "../lib/nexus.js";

/**
 * Écran de connexion.
 *
 * Le mot de passe n'est jamais conservé : `SessionManager` l'échange contre des
 * jetons, qui vont dans le coffre de la coquille. Le champ est vidé dès l'envoi,
 * réussite ou échec — un mot de passe qui reste affiché dans une fenêtre ouverte
 * sur un bureau partagé est un mot de passe compromis.
 */
export function Login() {
  const nexus = useNexus();
  const [email, setEmail] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const soumettre = () => {
    setOccupe(true);
    setErreur(null);

    const secret = motDePasse;
    setMotDePasse("");

    void nexus
      .signIn(email.trim(), secret)
      .catch((cause: unknown) => {
        setErreur(cause instanceof Error ? cause.message : "Connexion impossible.");
      })
      .finally(() => {
        setOccupe(false);
      });
  };

  return (
    <div className="vide" style={{ maxWidth: 380, margin: "12vh auto", textAlign: "left" }}>
      <h1 style={{ marginBottom: 4 }}>NEXUS</h1>
      <p className="faible" style={{ marginTop: 0 }}>
        Poste Windows — client et exécutant.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          soumettre();
        }}
      >
        <input
          className="champ"
          style={{ marginBottom: 8 }}
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
          style={{ marginBottom: 12 }}
          type="password"
          autoComplete="current-password"
          placeholder="Mot de passe"
          value={motDePasse}
          onChange={(event) => {
            setMotDePasse(event.target.value);
          }}
        />

        <button
          type="submit"
          className="bouton primaire"
          style={{ width: "100%" }}
          disabled={occupe || email.trim().length === 0 || motDePasse.length === 0}
        >
          {occupe ? "Connexion…" : "Se connecter"}
        </button>
      </form>

      {erreur === null ? null : (
        <p className="faible" style={{ color: "var(--erreur)" }}>
          {erreur}
        </p>
      )}
    </div>
  );
}
