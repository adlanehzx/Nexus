import { useState } from "react";
import { type ThemePreference, applyPreference, readPreference } from "../lib/theme.js";

/**
 * Light / system / dark switch.
 *
 * A three-position segmented control rather than a two-state toggle: with a
 * plain toggle there is no way back to "follow the system" once it is touched,
 * and the screen then stays dark through the morning.
 */
export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(() => readPreference());

  const choose = (next: ThemePreference): void => {
    applyPreference(next);
    setPreference(next);
  };

  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          title={option.label}
          aria-label={option.label}
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

const OPTIONS: { id: ThemePreference; label: string; icon: string }[] = [
  {
    id: "light",
    label: "Light theme",
    icon: "M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m11.4 0 1.4 1.4M4.9 4.9l1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  },
  {
    id: "system",
    label: "Follow system theme",
    icon: "M4 5h16v10H4V5Zm4 14h8m-5-4v4",
  },
  {
    id: "dark",
    label: "Dark theme",
    icon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
  },
];
