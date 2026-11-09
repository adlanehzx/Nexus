import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n/index.js";

/**
 * Dashboard UI building blocks.
 *
 * Presentation-only components that render decisions determined by `lib/format.ts`.
 */

export function Metric(props: {
  value: string;
  label: string;
  alert?: boolean;
  tone?: "positive" | "negative";
}) {
  const toneClass =
    props.tone === "positive" ? "pnl-positive" : props.tone === "negative" ? "pnl-negative" : "";
  return (
    <div className={`metric ${props.alert === true ? "alert" : ""} ${toneClass}`}>
      <div className="value">{props.value}</div>
      <div className="label">{props.label}</div>
    </div>
  );
}

/** Status badge with tone color and descriptive label. */
export function State({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="state">
      <span className={`badge ${tone}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export function Bar({ percent, label = "Progress" }: { percent: number; label?: string }) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <div
      className="gauge"
      title={`${String(value)} %`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
    >
      <div style={{ width: `${String(value)}%` }} />
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            {head.map((cell) => (
              <th key={cell}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Empty({ children }: { children?: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M5 5h14v14H5zM8 9h8M8 13h5" />
        </svg>
      </span>
      <strong>{t("common.messages.noData")}</strong>
      {children !== undefined ? <span>{children}</span> : null}
    </div>
  );
}

/**
 * Section loader hook with isolated error and reload states.
 *
 * `deps` are the values the request is built from — a task id, a filter, a
 * selected range. The fetch re-runs when one of them changes, exactly like a
 * `useEffect` dependency list.
 *
 * Passing them matters. The hook deliberately does not depend on the identity
 * of `load`, which is an inline arrow at every call site and would therefore
 * refetch on every render; so a section whose request reads a state value and
 * declares no dependency keeps serving the result of the first query forever,
 * no matter what the user types. Calling `reload()` by hand in the same event
 * handler papers over it, but only for the paths someone remembered.
 */
export function useSection<T>(
  load: () => Promise<T>,
  deps: readonly unknown[] = [],
): {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // Always call the newest closure without making its identity a trigger.
  // Declared before the fetching effect so it has already run when that one
  // fires for a dependency change.
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void latest
      .current()
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Failed to load.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tick, ...deps]);

  const reload = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  return { data, error, loading, reload };
}

/** Wraps a section: loading, error, and content rendering. */
export function Section<T>(props: {
  state: ReturnType<typeof useSection<T>>;
  children: (data: T) => React.ReactNode;
}) {
  const { t } = useI18n();
  if (props.state.error !== undefined) {
    return (
      <div className="banner error section-error" role="alert">
        <span>
          <strong>{t("common.states.failed")}</strong>
          <small>{props.state.error}</small>
        </span>
        <button className="button compact" type="button" onClick={props.state.reload}>
          {t("common.actions.refresh")}
        </button>
      </div>
    );
  }
  if (props.state.data === undefined) {
    return props.state.loading ? (
      <div className="loading-state" role="status" aria-label="Loading in progress">
        <span />
        <span />
        <span />
      </div>
    ) : (
      <Empty>{t("common.messages.noData")}</Empty>
    );
  }
  return <>{props.children(props.state.data)}</>;
}

export function Modal(props: {
  title: string;
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!props.isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [props.isOpen, props.onClose]);

  if (!props.isOpen) return null;

  return (
    <div
      className="nexus-modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={props.onClose}
    >
      <div
        className="nexus-modal-content"
        style={props.width ? { width: props.width } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="nexus-modal-header">
          <h3 className="nexus-modal-title">{props.title}</h3>
          <button
            type="button"
            className="nexus-modal-close"
            onClick={props.onClose}
            aria-label="Close"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>
        <div className="nexus-modal-body">{props.children}</div>
      </div>
    </div>
  );
}

export function ConfirmModal(props: {
  title: string;
  message: string;
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}) {
  const { tr } = useI18n();
  return (
    <Modal title={props.title} isOpen={props.isOpen} onClose={props.onCancel}>
      <p style={{ margin: "0 0 1.25rem 0", lineHeight: 1.5 }}>{props.message}</p>
      <div className="nexus-modal-footer">
        <button type="button" className="button secondary compact" onClick={props.onCancel}>
          {props.cancelLabel ?? tr("Cancel", "Annuler")}
        </button>
        <button
          type="button"
          className={`button compact ${props.danger ? "danger" : "primary"}`}
          onClick={props.onConfirm}
        >
          {props.confirmLabel ?? tr("Confirm", "Confirmer")}
        </button>
      </div>
    </Modal>
  );
}

export function PromptModal(props: {
  title: string;
  message: string;
  isOpen: boolean;
  defaultValue?: string;
  placeholder?: string;
  onSubmit: (val: string) => void;
  onCancel: () => void;
  submitLabel?: string;
  cancelLabel?: string;
}) {
  const { tr } = useI18n();
  const [val, setVal] = useState(props.defaultValue ?? "");

  useEffect(() => {
    if (props.isOpen) setVal(props.defaultValue ?? "");
  }, [props.isOpen, props.defaultValue]);

  return (
    <Modal title={props.title} isOpen={props.isOpen} onClose={props.onCancel}>
      <p style={{ margin: "0 0 0.75rem 0", lineHeight: 1.5 }}>{props.message}</p>
      <input
        type="text"
        className="field"
        autoFocus
        value={val}
        placeholder={props.placeholder}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && val.trim().length > 0) {
            props.onSubmit(val.trim());
          }
        }}
        style={{ width: "100%", marginBottom: "1.25rem" }}
      />
      <div className="nexus-modal-footer">
        <button type="button" className="button secondary compact" onClick={props.onCancel}>
          {props.cancelLabel ?? tr("Cancel", "Annuler")}
        </button>
        <button
          type="button"
          className="button primary compact"
          disabled={val.trim().length === 0}
          onClick={() => props.onSubmit(val.trim())}
        >
          {props.submitLabel ?? tr("Submit", "Valider")}
        </button>
      </div>
    </Modal>
  );
}
