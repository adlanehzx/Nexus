/**
 * NEXUS Spatial OS — Command Palette (Ctrl+K)
 */

import React, { useState, useEffect, useRef, useMemo } from "react";
import type { CommandPaletteItem } from "./types.js";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  items: CommandPaletteItem[];
}

export function CommandPalette({ isOpen, onClose, items }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const filteredItems = useMemo(() => {
    if (!query.trim()) return items;
    const lower = query.toLowerCase();
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(lower) ||
        item.category.toLowerCase().includes(lower) ||
        (item.subtitle?.toLowerCase().includes(lower) ?? false),
    );
  }, [items, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredItems]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        filteredItems.length === 0 ? 0 : (prev + 1) % filteredItems.length,
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        filteredItems.length === 0 ? 0 : (prev - 1 + filteredItems.length) % filteredItems.length,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredItems[selectedIndex]) {
        filteredItems[selectedIndex].action();
        onClose();
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div className="spatial-palette-overlay" onClick={onClose}>
      <div
        className="spatial-palette-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="spatial-palette-header">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ color: "var(--sp-accent)" }}
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="spatial-palette-search"
            placeholder="Tapez une commande, un espace ou un agent (ex: 'Code', 'Claude', 'Worktree', 'DAG')..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="spatial-shortcut-badge">ESC pour fermer</span>
        </div>

        <div className="spatial-palette-results">
          {filteredItems.length === 0 ? (
            <div style={{ padding: "20px", textAlign: "center", color: "var(--sp-text-dim)" }}>
              Aucun résultat pour "{query}"
            </div>
          ) : (
            filteredItems.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={item.id}
                  className={`spatial-palette-row ${isSelected ? "selected" : ""}`}
                  onClick={() => {
                    item.action();
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <div>
                    <div className="spatial-palette-row-title">{item.title}</div>
                    {item.subtitle && (
                      <div className="spatial-palette-row-subtitle">{item.subtitle}</div>
                    )}
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span
                      style={{
                        fontSize: "10px",
                        color: "var(--sp-text-dim)",
                        textTransform: "uppercase",
                      }}
                    >
                      {item.category}
                    </span>
                    {item.shortcut && (
                      <span className="spatial-palette-row-shortcut">{item.shortcut}</span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
