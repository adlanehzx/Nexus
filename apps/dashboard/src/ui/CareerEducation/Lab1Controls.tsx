import { useState, type ReactNode } from "react";
import { useI18n } from "../i18n/index.js";
import { IconBolt, IconCheck, IconClose, IconNote, IconPlus, IconWarning } from "../icons.js";
import type { AutonomyMode } from "../../lib/lab1-client.js";
import "./lab1.css";

/** Segmented control: manual | approval | autonomous. */
export function ModeSelector({
  value,
  effective,
  onChange,
  disabled = false,
  label,
}: {
  value: AutonomyMode;
  /** Mode actually applied (kill switch / missing consent downgrade it). */
  effective?: AutonomyMode;
  onChange: (mode: AutonomyMode) => void;
  disabled?: boolean;
  label: string;
}) {
  const { tr } = useI18n();
  const options: { mode: AutonomyMode; text: string; icon: ReactNode }[] = [
    { mode: "manual", text: tr("Manual", "Manuel"), icon: <IconNote size={12} /> },
    { mode: "approval", text: tr("Approval", "Validation"), icon: <IconCheck size={12} /> },
    { mode: "autonomous", text: tr("Autonomous", "Autonome"), icon: <IconBolt size={12} /> },
  ];
  return (
    <div className="lab1-row">
      <div className="lab1-mode" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.mode}
            type="button"
            data-mode={option.mode}
            aria-pressed={value === option.mode}
            disabled={disabled}
            onClick={() => onChange(option.mode)}
          >
            {option.icon}
            {option.text}
          </button>
        ))}
      </div>
      {effective !== undefined && effective !== value && (
        <span
          className="lab1-badge warn"
          title={tr("Mode actually applied", "Mode réellement appliqué")}
        >
          <IconWarning size={11} />
          {tr("applied:", "appliqué :")} {effective}
        </span>
      )}
    </div>
  );
}

/** Editable list of short strings (companies, keywords, topics, hashtags). */
export function ChipListEditor({
  values,
  onChange,
  placeholder,
  label,
  disabled = false,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  label: string;
  disabled?: boolean;
}) {
  const { tr } = useI18n();
  const [draft, setDraft] = useState("");
  const add = () => {
    const value = draft.trim();
    if (value === "" || values.some((v) => v.toLowerCase() === value.toLowerCase())) return;
    onChange([...values, value]);
    setDraft("");
  };
  return (
    <div className="lab1-field">
      <span>{label}</span>
      <div className="lab1-row">
        <input
          className="lab1-input"
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="button compact" disabled={disabled} onClick={add}>
          <IconPlus size={12} /> {tr("Add", "Ajouter")}
        </button>
      </div>
      {values.length > 0 && (
        <div className="lab1-chips">
          {values.map((value) => (
            <span className="lab1-chip" key={value}>
              {value}
              <button
                type="button"
                aria-label={`${tr("Remove", "Retirer")} ${value}`}
                disabled={disabled}
                onClick={() => onChange(values.filter((v) => v !== value))}
              >
                <IconClose size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Error banner: a failed call is always shown, never swallowed. */
export function ErrorBanner({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  const { tr } = useI18n();
  if (error === null) return null;
  return (
    <div className="lab1-alert danger" role="alert">
      <IconWarning size={16} color="var(--nx-danger)" />
      <div style={{ flex: 1 }}>
        <strong>{tr("Error", "Erreur")}:</strong> {error}
      </div>
      {onRetry !== undefined && (
        <button type="button" className="button compact" onClick={onRetry}>
          {tr("Retry", "Réessayer")}
        </button>
      )}
    </div>
  );
}

export function actorBadge(actor: string): { className: string; label: string } {
  if (actor === "nexus-autonomous")
    return { className: "lab1-badge warn", label: "nexus-autonomous" };
  if (actor === "nexus-prepare") return { className: "lab1-badge accent", label: "nexus-prepare" };
  return { className: "lab1-badge", label: actor };
}

export function formatDateTime(value: string | null, locale: string): string {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(locale === "fr" ? "fr-FR" : "en-GB", {
        dateStyle: "short",
        timeStyle: "short",
      });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
