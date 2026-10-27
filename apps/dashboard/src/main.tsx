import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initTheme } from "./lib/theme.js";
import { App } from "./ui/App.js";
import "./ui/theme.css";

// Before the first paint: an explicit theme choice must not flash the other one.
initTheme();

const root = document.getElementById("root");
if (root === null) throw new Error("root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
