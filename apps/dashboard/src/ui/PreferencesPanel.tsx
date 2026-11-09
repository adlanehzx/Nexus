import { useState, useEffect } from "react";
import { useI18n } from "./i18n/index.js";
import {
  type ColorThemeId,
  COLOR_THEMES,
  applyColorTheme,
  readColorTheme,
} from "../lib/color-theme.js";
import { type ThemePreference, applyPreference, readPreference } from "../lib/theme.js";

function IconSpark() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: "middle", marginRight: "8px", flexShrink: 0 }}
    >
      <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z" />
    </svg>
  );
}

function IconMonitor() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: "middle", marginRight: "8px", color: "var(--nx-signal)" }}
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function IconSpatial() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: "middle", marginRight: "8px" }}
    >
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

function IconLayout() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: "middle", marginRight: "8px" }}
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function IconSunMoon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: "middle", marginRight: "8px", color: "var(--nx-signal)" }}
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function IconMoon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ color: "var(--nx-signal)" }}
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function IconSun() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ color: "var(--nx-signal)" }}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function IconLaptop() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ color: "var(--nx-signal)" }}
    >
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <line x1="2" y1="20" x2="22" y2="20" />
    </svg>
  );
}

function IconGlobe() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: "middle", marginRight: "8px", color: "var(--nx-signal)" }}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function IconPalette() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: "middle", marginRight: "8px", color: "var(--nx-signal)" }}
    >
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.563-2.512 5.563-5.563C22 6.5 17.5 2 12 2Z" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function PreferencesPanel() {
  const { locale, setLocale, tr } = useI18n();

  // 1. Default OS ViewMode (Spatial OS vs Classic Dashboard)
  const [defaultOS, setDefaultOS] = useState<"spatial" | "classic">(() => {
    try {
      const saved = window.sessionStorage.getItem("nexus.ui.viewMode");
      return saved === "classic" ? "classic" : "spatial";
    } catch {
      return "spatial";
    }
  });

  // 2. Light / Dark / System Theme
  const [themeMode, setThemeMode] = useState<ThemePreference>(() => readPreference());

  // 3. Color Theme Accent
  const [activeColorTheme, setActiveColorTheme] = useState<ColorThemeId>(() => readColorTheme());

  const [savedBanner, setSavedBanner] = useState<string | null>(null);

  const handleOSChange = (mode: "spatial" | "classic") => {
    setDefaultOS(mode);
    try {
      window.sessionStorage.setItem("nexus.ui.viewMode", mode);
    } catch {
      // Storage unavailable
    }
    window.dispatchEvent(new CustomEvent("nexus-viewmode-change", { detail: mode }));
    showNotice(
      locale === "fr"
        ? `Système par défaut basculé vers : ${mode === "spatial" ? "NEXUS Spatial OS" : "Dashboard Classique"}`
        : `Default system set to: ${mode === "spatial" ? "NEXUS Spatial OS" : "Classic Dashboard"}`,
    );
  };

  const handleThemeModeChange = (mode: ThemePreference) => {
    setThemeMode(mode);
    applyPreference(mode);
    showNotice(
      locale === "fr"
        ? `Mode d'affichage appliqué : ${mode === "dark" ? "Sombre" : mode === "light" ? "Clair" : "Système"}`
        : `Theme applied: ${mode === "dark" ? "Dark" : mode === "light" ? "Light" : "System"}`,
    );
  };

  const handleLocaleChange = (newLocale: "fr" | "en") => {
    setLocale(newLocale);
    showNotice(
      newLocale === "fr"
        ? "Langue de l'interface modifiée en Français."
        : "Interface language switched to English.",
    );
  };

  const handleColorThemeChange = (colorId: ColorThemeId) => {
    setActiveColorTheme(colorId);
    applyColorTheme(colorId);
    const themeName = locale === "fr" ? COLOR_THEMES[colorId].nameFr : COLOR_THEMES[colorId].nameEn;
    showNotice(
      locale === "fr"
        ? `Palette de couleur appliquée : ${themeName}`
        : `Color palette applied: ${themeName}`,
    );
  };

  const showNotice = (msg: string) => {
    setSavedBanner(msg);
    setTimeout(() => {
      setSavedBanner((prev) => (prev === msg ? null : prev));
    }, 4000);
  };

  useEffect(() => {
    const handleColorChange = (e: Event) => {
      const custom = e as CustomEvent<ColorThemeId>;
      if (custom.detail) setActiveColorTheme(custom.detail);
    };
    window.addEventListener("nexus-color-theme-change", handleColorChange);
    return () => window.removeEventListener("nexus-color-theme-change", handleColorChange);
  }, []);

  return (
    <div
      className="preferences-panel"
      style={{ display: "flex", flexDirection: "column", gap: "2rem" }}
    >
      {/* Toast feedback notice */}
      {savedBanner && (
        <div
          role="status"
          style={{
            padding: "0.75rem 1.25rem",
            borderRadius: "8px",
            background: "color-mix(in srgb, var(--nx-signal) 12%, transparent)",
            border: "1px solid var(--nx-signal)",
            color: "var(--nx-text, #ffffff)",
            fontSize: "0.875rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            animation: "fadeIn 0.2s ease-in-out",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center" }}>
            <IconSpark />
            {savedBanner}
          </span>
          <button
            type="button"
            onClick={() => setSavedBanner(null)}
            aria-label={tr("Close", "Fermer")}
            style={{
              background: "transparent",
              border: "none",
              color: "inherit",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "4px",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* Choice 1: Default OS */}
      <div className="preference-group">
        <div style={{ marginBottom: "1rem" }}>
          <h3
            style={{
              fontSize: "1.1rem",
              margin: "0 0 0.25rem 0",
              color: "var(--nx-text, #fff)",
              display: "flex",
              alignItems: "center",
            }}
          >
            <IconMonitor />
            {tr("Default Operating System", "Système d'Exploitation par Défaut")}
          </h3>
          <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            {tr(
              "Choose which interface NEXUS launches into by default upon opening.",
              "Choisissez quelle interface NEXUS affiche par défaut à l'ouverture de l'application.",
            )}
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "1rem",
          }}
        >
          {/* Spatial OS Card */}
          <div
            onClick={() => handleOSChange("spatial")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && handleOSChange("spatial")}
            style={{
              padding: "1.25rem",
              borderRadius: "10px",
              background:
                defaultOS === "spatial"
                  ? "color-mix(in srgb, var(--nx-signal) 8%, transparent)"
                  : "var(--nx-surface, #0e131c)",
              border:
                defaultOS === "spatial"
                  ? "2px solid var(--nx-signal)"
                  : "1px solid var(--nx-line, #212b3b)",
              cursor: "pointer",
              transition: "all 0.2s ease",
              position: "relative",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "0.5rem",
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  fontSize: "1rem",
                  color: "var(--nx-text, #fff)",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <IconSpatial />
                NEXUS Spatial OS
              </div>
              {defaultOS === "spatial" && (
                <span
                  style={{
                    fontSize: "0.75rem",
                    padding: "2px 8px",
                    borderRadius: "999px",
                    background: "var(--nx-signal)",
                    color: "var(--nx-text-on-accent)",
                    fontWeight: 700,
                  }}
                >
                  {tr("ACTIVE", "ACTIF")}
                </span>
              )}
            </div>
            <p
              style={{
                fontSize: "0.85rem",
                color: "var(--nx-text-muted, #95a3ba)",
                margin: 0,
                lineHeight: 1.4,
              }}
            >
              {tr(
                "Continuous 2D workspace with tiling agent windows and spatial canvas navigation.",
                "Espace 2D continu avec fenêtres multi-agents tuilées et navigation spatiale.",
              )}
            </p>
          </div>

          {/* Classic Dashboard Card */}
          <div
            onClick={() => handleOSChange("classic")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && handleOSChange("classic")}
            style={{
              padding: "1.25rem",
              borderRadius: "10px",
              background:
                defaultOS === "classic"
                  ? "color-mix(in srgb, var(--nx-signal) 8%, transparent)"
                  : "var(--nx-surface, #0e131c)",
              border:
                defaultOS === "classic"
                  ? "2px solid var(--nx-signal)"
                  : "1px solid var(--nx-line, #212b3b)",
              cursor: "pointer",
              transition: "all 0.2s ease",
              position: "relative",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "0.5rem",
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  fontSize: "1rem",
                  color: "var(--nx-text, #fff)",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <IconLayout />
                Dashboard Classique
              </div>
              {defaultOS === "classic" && (
                <span
                  style={{
                    fontSize: "0.75rem",
                    padding: "2px 8px",
                    borderRadius: "999px",
                    background: "var(--nx-signal)",
                    color: "var(--nx-text-on-accent)",
                    fontWeight: 700,
                  }}
                >
                  {tr("ACTIVE", "ACTIF")}
                </span>
              )}
            </div>
            <p
              style={{
                fontSize: "0.85rem",
                color: "var(--nx-text-muted, #95a3ba)",
                margin: 0,
                lineHeight: 1.4,
              }}
            >
              {tr(
                "Standard modular web dashboard with sidebar navigation and grouped categories.",
                "Dashboard web modulaire standard avec barre latérale et navigation par catégories.",
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Choice 2: Dark / Light / System Theme */}
      <div className="preference-group">
        <div style={{ marginBottom: "1rem" }}>
          <h3
            style={{
              fontSize: "1.1rem",
              margin: "0 0 0.25rem 0",
              color: "var(--nx-text, #fff)",
              display: "flex",
              alignItems: "center",
            }}
          >
            <IconSunMoon />
            {tr("Lighting & Display Mode", "Mode d'Affichage & Luminosité")}
          </h3>
          <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            {tr(
              "Toggle between Dark mode, Light mode, or follow system OS preferences.",
              "Basculez entre le Mode Sombre (Dark), le Mode Clair (Light) ou suivez le système.",
            )}
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "1rem",
          }}
        >
          {/* Dark Mode */}
          <div
            onClick={() => handleThemeModeChange("dark")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && handleThemeModeChange("dark")}
            style={{
              padding: "1rem",
              borderRadius: "8px",
              background:
                themeMode === "dark"
                  ? "color-mix(in srgb, var(--nx-signal) 8%, transparent)"
                  : "var(--nx-surface, #0e131c)",
              border:
                themeMode === "dark"
                  ? "2px solid var(--nx-signal)"
                  : "1px solid var(--nx-line, #212b3b)",
              cursor: "pointer",
              textAlign: "center",
            }}
          >
            <div style={{ display: "flex", justifyContent: "center", marginBottom: "0.4rem" }}>
              <IconMoon />
            </div>
            <div style={{ fontWeight: 600, color: "var(--nx-text, #fff)", fontSize: "0.95rem" }}>
              {tr("Dark Mode", "Mode Sombre")}
            </div>
            <div
              style={{
                fontSize: "0.75rem",
                color: "var(--nx-text-muted, #95a3ba)",
                marginTop: "0.25rem",
              }}
            >
              {tr("Night & low light environments", "Contraste sombre optimal")}
            </div>
          </div>

          {/* Light Mode */}
          <div
            onClick={() => handleThemeModeChange("light")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && handleThemeModeChange("light")}
            style={{
              padding: "1rem",
              borderRadius: "8px",
              background:
                themeMode === "light"
                  ? "color-mix(in srgb, var(--nx-signal) 8%, transparent)"
                  : "var(--nx-surface, #0e131c)",
              border:
                themeMode === "light"
                  ? "2px solid var(--nx-signal)"
                  : "1px solid var(--nx-line, #212b3b)",
              cursor: "pointer",
              textAlign: "center",
            }}
          >
            <div style={{ display: "flex", justifyContent: "center", marginBottom: "0.4rem" }}>
              <IconSun />
            </div>
            <div style={{ fontWeight: 600, color: "var(--nx-text, #fff)", fontSize: "0.95rem" }}>
              {tr("Light Mode", "Mode Clair (White)")}
            </div>
            <div
              style={{
                fontSize: "0.75rem",
                color: "var(--nx-text-muted, #95a3ba)",
                marginTop: "0.25rem",
              }}
            >
              {tr("Bright day ambient rooms", "Luminosité maximale")}
            </div>
          </div>

          {/* System Mode */}
          <div
            onClick={() => handleThemeModeChange("system")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && handleThemeModeChange("system")}
            style={{
              padding: "1rem",
              borderRadius: "8px",
              background:
                themeMode === "system"
                  ? "color-mix(in srgb, var(--nx-signal) 8%, transparent)"
                  : "var(--nx-surface, #0e131c)",
              border:
                themeMode === "system"
                  ? "2px solid var(--nx-signal)"
                  : "1px solid var(--nx-line, #212b3b)",
              cursor: "pointer",
              textAlign: "center",
            }}
          >
            <div style={{ display: "flex", justifyContent: "center", marginBottom: "0.4rem" }}>
              <IconLaptop />
            </div>
            <div style={{ fontWeight: 600, color: "var(--nx-text, #fff)", fontSize: "0.95rem" }}>
              {tr("Follow System", "Système")}
            </div>
            <div
              style={{
                fontSize: "0.75rem",
                color: "var(--nx-text-muted, #95a3ba)",
                marginTop: "0.25rem",
              }}
            >
              {tr("Auto sync with OS setting", "Synchronisé automatiquement")}
            </div>
          </div>
        </div>
      </div>

      {/* Choice 3: Default Language */}
      <div className="preference-group">
        <div style={{ marginBottom: "1rem" }}>
          <h3
            style={{
              fontSize: "1.1rem",
              margin: "0 0 0.25rem 0",
              color: "var(--nx-text, #fff)",
              display: "flex",
              alignItems: "center",
            }}
          >
            <IconGlobe />
            {tr("Default Language", "Langue de l'Interface")}
          </h3>
          <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            {tr(
              "Select your preferred language for navigation, alerts, and instructions.",
              "Définissez votre langue préférée pour l'ensemble du tableau de bord et des assistants.",
            )}
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "1rem",
          }}
        >
          {/* French */}
          <div
            onClick={() => handleLocaleChange("fr")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && handleLocaleChange("fr")}
            style={{
              padding: "1rem",
              borderRadius: "8px",
              background:
                locale === "fr"
                  ? "color-mix(in srgb, var(--nx-signal) 8%, transparent)"
                  : "var(--nx-surface, #0e131c)",
              border:
                locale === "fr"
                  ? "2px solid var(--nx-signal)"
                  : "1px solid var(--nx-line, #212b3b)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "0.85rem",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "36px",
                height: "36px",
                borderRadius: "6px",
                background: locale === "fr" ? "var(--nx-signal)" : "var(--nx-surface-hover)",
                color: locale === "fr" ? "var(--nx-text-on-accent)" : "var(--nx-text, #fff)",
                fontWeight: 700,
                fontSize: "0.9rem",
                letterSpacing: "0.05em",
              }}
            >
              FR
            </span>
            <div>
              <div style={{ fontWeight: 600, color: "var(--nx-text, #fff)", fontSize: "0.95rem" }}>
                Français
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--nx-text-muted, #95a3ba)" }}>
                Français (France / International)
              </div>
            </div>
          </div>

          {/* English */}
          <div
            onClick={() => handleLocaleChange("en")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && handleLocaleChange("en")}
            style={{
              padding: "1rem",
              borderRadius: "8px",
              background:
                locale === "en"
                  ? "color-mix(in srgb, var(--nx-signal) 8%, transparent)"
                  : "var(--nx-surface, #0e131c)",
              border:
                locale === "en"
                  ? "2px solid var(--nx-signal)"
                  : "1px solid var(--nx-line, #212b3b)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "0.85rem",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "36px",
                height: "36px",
                borderRadius: "6px",
                background: locale === "en" ? "var(--nx-signal)" : "var(--nx-surface-hover)",
                color: locale === "en" ? "var(--nx-text-on-accent)" : "var(--nx-text, #fff)",
                fontWeight: 700,
                fontSize: "0.9rem",
                letterSpacing: "0.05em",
              }}
            >
              EN
            </span>
            <div>
              <div style={{ fontWeight: 600, color: "var(--nx-text, #fff)", fontSize: "0.95rem" }}>
                English
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--nx-text-muted, #95a3ba)" }}>
                English (International)
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Choice 4: Accent Color Themes */}
      <div className="preference-group">
        <div style={{ marginBottom: "1rem" }}>
          <h3
            style={{
              fontSize: "1.1rem",
              margin: "0 0 0.25rem 0",
              color: "var(--nx-text, #fff)",
              display: "flex",
              alignItems: "center",
            }}
          >
            <IconPalette />
            {tr("Accent Color Theme", "Thème de Couleur d'Accentuation")}
          </h3>
          <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            {tr(
              "Choose your visual theme. Changes take effect immediately across all windows, signals, and borders.",
              "Personnalisez la couleur d'accentuation principale de l'interface (actuellement en vert/cyan, personnalisable à volonté).",
            )}
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: "1rem",
          }}
        >
          {(Object.keys(COLOR_THEMES) as ColorThemeId[]).map((id) => {
            const config = COLOR_THEMES[id];
            const isSelected = activeColorTheme === id;
            return (
              <div
                key={id}
                onClick={() => handleColorThemeChange(id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && handleColorThemeChange(id)}
                style={{
                  padding: "1rem",
                  borderRadius: "10px",
                  background: isSelected ? "var(--nx-surface-hover)" : "var(--nx-surface, #0e131c)",
                  border: isSelected
                    ? `2px solid ${config.signal}`
                    : "1px solid var(--nx-line, #212b3b)",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                  boxShadow: isSelected ? `0 0 16px ${config.accentGlow}` : "none",
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                    {/* Swatch */}
                    <div
                      style={{
                        width: "20px",
                        height: "20px",
                        borderRadius: "50%",
                        background: config.previewGradient,
                        boxShadow: `0 0 8px ${config.signal}`,
                      }}
                    />
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: "0.95rem",
                        color: "var(--nx-text, #fff)",
                      }}
                    >
                      {locale === "fr" ? config.nameFr : config.nameEn}
                    </div>
                  </div>
                  {isSelected && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "20px",
                        height: "20px",
                        borderRadius: "4px",
                        background: config.signal,
                        color: "var(--nx-text-on-accent)",
                      }}
                    >
                      <IconCheck />
                    </span>
                  )}
                </div>

                <p
                  style={{
                    fontSize: "0.8rem",
                    color: "var(--nx-text-muted, #95a3ba)",
                    margin: 0,
                    lineHeight: 1.35,
                  }}
                >
                  {locale === "fr" ? config.descriptionFr : config.descriptionEn}
                </p>

                {/* Mini preview bar */}
                <div
                  style={{
                    marginTop: "0.25rem",
                    height: "4px",
                    borderRadius: "2px",
                    background: config.previewGradient,
                    opacity: isSelected ? 1 : 0.4,
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
