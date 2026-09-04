import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App.js";
import "./ui/theme.css";

const racine = document.getElementById("root");
if (racine === null) throw new Error("élément racine introuvable");

createRoot(racine).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
