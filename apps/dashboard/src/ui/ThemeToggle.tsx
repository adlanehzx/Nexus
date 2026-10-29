import { useState } from "react";
import { type ThemePreference, applyPreference, readPreference } from "../lib/theme.js";
import { useI18n } from "./i18n/index.js";

/**
 * Light / system / dark switch.
 *
 * A three-position segmented control rather than a two-state toggle: with a
 * plain toggle there is no way back to "follow the system" once it is touched,
 * and the screen then stays dark through the morning.
 */
export function ThemeToggle() {
  const { tr } = useI18n();
  const [preference, setPreference] = useState<ThemePreference>(() => readPreference());

  const choose = (next: ThemePreference): void => {
    applyPreference(next);
    setPreference(next);
  };

  const getLabel = (id: ThemePreference): string => {
    switch (id) {
      case "light":
        return tr("Light theme", "Thème clair");
      case "system":
        return tr("Follow system theme", "Thème du système");
      case "dark":
        return tr("Dark theme", "Thème sombre");
    }
  };

  return (
    <div className="theme-toggle" role="group" aria-label={tr("Colour theme", "Thème de couleur")}>
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          title={getLabel(option.id)}
          aria-label={getLabel(option.id)}
          aria-pressed={preference === option.id}
          onClick={() => {
            choose(option.id);
          }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d={option.icon} />
          </svg>
        </button>
      ))}
    </div>
  );
}

const OPTIONS: { id: ThemePreference; icon: string }[] = [
  {
    id: "light",
    icon: "M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m11.4 0 1.4 1.4M4.9 4.9l1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  },
  {
    id: "system",
    icon: "M4 5h16v10H4V5Zm4 14h8m-5-4v4",
  },
  {
    id: "dark",
    icon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
  },
];
