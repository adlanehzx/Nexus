import { useState, useEffect, useCallback } from "react";
import { useI18n } from "./i18n/index.js";
import {
  DEFAULT_KEYBINDINGS,
  loadUserKeybindings,
  saveUserKeybinding,
  resetAllKeybindings,
} from "./spatial/keybindingStore.js";
import { getDigitFromEvent } from "./spatial/keyboardUtils.js";
import { IconRefresh } from "./icons.js";

export function KeybindingsPanel() {
  const { locale, tr } = useI18n();
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [recordedKeys, setRecordedKeys] = useState<string>("");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const refresh = useCallback(() => {
    setBindings(loadUserKeybindings());
  }, []);

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener("nexus:keybindings-updated", handler);
    return () => window.removeEventListener("nexus:keybindings-updated", handler);
  }, [refresh]);

  // Key recording listener
  useEffect(() => {
    if (!editingId) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setEditingId(null);
        setRecordedKeys("");
        return;
      }

      const parts: string[] = [];
      if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");

      let keyName = "";
      const digit = getDigitFromEvent(e);
      if (digit !== null) {
        keyName = String(digit);
      } else if (e.key === "Enter") {
        keyName = "Enter";
      } else if (e.key === "Tab") {
        keyName = "Tab";
      } else if (e.key === "Backspace") {
        keyName = "Backspace";
      } else if (e.key === ",") {
        keyName = ",";
      } else if (e.key === "+" || e.key === "=" || e.code === "Equal") {
        keyName = "=";
      } else if (e.key === "-" || e.code === "Minus") {
        keyName = "-";
      } else if (e.key.length === 1 && !["Control", "Alt", "Shift", "Meta"].includes(e.key)) {
        keyName = e.key.toUpperCase();
      }

      if (keyName) {
        parts.push(keyName);
        const combo = parts.join("+");
        setRecordedKeys(combo);
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [editingId]);

  const handleSave = (id: string) => {
    if (recordedKeys) {
      saveUserKeybinding(id, recordedKeys);
    }
    setEditingId(null);
    setRecordedKeys("");
  };

  const handleResetOne = (id: string) => {
    const custom = loadUserKeybindings();
    delete custom[id];
    window.sessionStorage.setItem("nexus.keybindings.custom", JSON.stringify(custom));
    window.dispatchEvent(new CustomEvent("nexus:keybindings-updated"));
    refresh();
  };

  const handleResetAll = () => {
    resetAllKeybindings();
    refresh();
  };

  const categories = [
    { id: "all", label: tr("All", "Tous") },
    { id: "spaces", label: tr("Spaces", "Espaces") },
    { id: "windows", label: tr("Windows & Tiling", "Fenêtres & Tiling") },
    { id: "system", label: tr("System & View", "Système & Vue") },
    { id: "navigation", label: tr("Navigation", "Navigation") },
  ];

  const filtered = DEFAULT_KEYBINDINGS.filter((item) => {
    if (filterCategory !== "all" && item.category !== filterCategory) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchLabel =
        item.label.toLowerCase().includes(q) || item.labelEn.toLowerCase().includes(q);
      const matchDesc =
        item.description.toLowerCase().includes(q) || item.descriptionEn.toLowerCase().includes(q);
      const matchKeys = (bindings[item.id] ?? item.defaultKeys).toLowerCase().includes(q);
      return matchLabel || matchDesc || matchKeys;
    }
    return true;
  });

  return (
    <div className="preferences-panel cyber-reticle" style={{ maxWidth: "1000px" }}>
      <div className="pref-header">
        <div>
          <h3>{tr("Keyboard Shortcuts & Keybindings", "Raccourcis Clavier & Keybindings")}</h3>
          <p>
            {tr(
              "Customize NEXUS keyboard shortcuts for Spatial OS and Dashboard. Compatible with QWERTY, AZERTY, and Omarchy Desktop.",
              "Personnalisez les raccourcis clavier de NEXUS pour le Spatial OS et le Dashboard. Compatible QWERTY, AZERTY et Desktop Omarchy.",
            )}
          </p>
        </div>
        <button
          type="button"
          className="button secondary"
          onClick={handleResetAll}
          title={tr("Reset all shortcuts to defaults", "Rétablir tous les raccourcis par défaut")}
        >
          {tr("Reset all", "Réinitialiser tout")}
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          marginBottom: "16px",
          paddingBottom: "12px",
          borderBottom: "1px solid var(--nx-line)",
        }}
      >
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`button secondary ${filterCategory === c.id ? "active" : ""}`}
              style={{
                fontSize: "12px",
                padding: "4px 10px",
                borderColor: filterCategory === c.id ? "var(--nx-accent)" : undefined,
                background: filterCategory === c.id ? "var(--nx-accent-muted)" : undefined,
              }}
              onClick={() => setFilterCategory(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>

        <input
          aria-label={tr("Filter by action or key...", "Filtrer par action ou touche...")}
          type="search"
          className="field"
          placeholder={tr("Filter by action or key...", "Filtrer par action ou touche...")}
          style={{ width: "220px", fontSize: "12px", padding: "6px 10px" }}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Shortcuts Table */}
      <div style={{ display: "grid", gap: "8px" }}>
        {filtered.map((item) => {
          const currentKey = bindings[item.id] ?? item.defaultKeys;
          const isCustom = Boolean(bindings[item.id]);
          const isEditing = editingId === item.id;

          return (
            <div
              key={item.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 14px",
                borderRadius: "var(--nx-radius-sm, 6px)",
                background: isEditing ? "var(--nx-accent-muted)" : "var(--nx-surface-raised)",
                border: isEditing ? "1px solid var(--nx-accent)" : "1px solid var(--nx-line)",
                transition: "all 0.15s ease",
              }}
            >
              <div style={{ flex: 1, minWidth: 0, paddingRight: "16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <strong style={{ fontSize: "13px", color: "var(--nx-text)" }}>
                    {locale === "fr" ? item.label : item.labelEn}
                  </strong>
                  {isCustom && (
                    <span
                      style={{
                        fontSize: "10px",
                        padding: "1px 6px",
                        borderRadius: "3px",
                        background: "var(--nx-accent-muted)",
                        color: "var(--nx-accent)",
                        fontFamily: "var(--nx-font-mono)",
                      }}
                    >
                      {tr("custom", "personnalisé")}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: "11px", color: "var(--nx-text-muted)", marginTop: "2px" }}>
                  {locale === "fr" ? item.description : item.descriptionEn}
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                {isEditing ? (
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span
                      style={{
                        padding: "4px 10px",
                        borderRadius: "4px",
                        background: "var(--nx-canvas-sunken, #000)",
                        border: "1px dashed var(--nx-accent)",
                        color: "var(--nx-accent)",
                        fontFamily: "var(--nx-font-mono)",
                        fontSize: "12px",
                        fontWeight: "bold",
                        minWidth: "100px",
                        textAlign: "center",
                      }}
                    >
                      {recordedKeys || tr("Press keys...", "Appuyez sur des touches...")}
                    </span>
                    <button
                      type="button"
                      className="button primary"
                      style={{ fontSize: "11px", padding: "4px 8px" }}
                      disabled={!recordedKeys}
                      onClick={() => handleSave(item.id)}
                    >
                      {tr("Save", "Valider")}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      style={{ fontSize: "11px", padding: "4px 8px" }}
                      onClick={() => {
                        setEditingId(null);
                        setRecordedKeys("");
                      }}
                    >
                      {tr("Cancel", "Annuler")}
                    </button>
                  </div>
                ) : (
                  <>
                    <kbd
                      style={{
                        padding: "3px 8px",
                        borderRadius: "4px",
                        background: "rgba(0, 0, 0, 0.4)",
                        border: "1px solid var(--nx-line)",
                        color: "var(--nx-text)",
                        fontFamily: "var(--nx-font-mono)",
                        fontSize: "11px",
                        letterSpacing: "0.04em",
                      }}
                    >
                      {currentKey}
                    </kbd>
                    <button
                      type="button"
                      className="button secondary"
                      style={{ fontSize: "11px", padding: "3px 8px" }}
                      onClick={() => {
                        setEditingId(item.id);
                        setRecordedKeys("");
                      }}
                    >
                      {tr("Edit", "Modifier")}
                    </button>
                    {isCustom && (
                      <button
                        type="button"
                        className="button secondary"
                        style={{ fontSize: "11px", padding: "3px 6px", opacity: 0.7 }}
                        title={tr("Reset to default", "Rétablir la touche par défaut")}
                        onClick={() => handleResetOne(item.id)}
                      >
                        <IconRefresh size={11} />
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
