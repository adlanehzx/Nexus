import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NexusProvider } from "./lib/nexus.js";
import { App } from "./ui/App.js";
import "./ui/theme.css";

/**
 * Renderer entry point.
 *
 * Mounts the root component. The Tauri shell serves this bundle from disk;
 * no remote resources are loaded, guaranteed by the Content Security Policy.
 */
const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("root element not found");

createRoot(rootElement).render(
  <StrictMode>
    <NexusProvider>
      <App />
    </NexusProvider>
  </StrictMode>,
);
