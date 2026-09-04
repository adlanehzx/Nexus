import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NexusProvider } from "./lib/nexus.js";
import { App } from "./ui/App.js";
import "./ui/theme.css";

/**
 * Point d'entrée du moteur de rendu.
 *
 * Rien d'autre que du montage. La coquille Tauri sert ce paquet depuis le
 * disque ; aucune ressource n'est chargée depuis Internet, et la politique de
 * sécurité du contenu déclarée dans `index.html` le garantit à l'exécution.
 */
const racine = document.getElementById("root");
if (racine === null) throw new Error("élément racine introuvable");

createRoot(racine).render(
  <StrictMode>
    <NexusProvider>
      <App />
    </NexusProvider>
  </StrictMode>,
);
