import { useCallback, useEffect, useState } from "react";

/**
 * Dashboard UI building blocks.
 *
 * Presentation-only components that render decisions determined by `lib/format.ts`.
 */

export function Metric(props: { value: string; label: string; alert?: boolean }) {
  return (
    <div className={`mesure ${props.alert === true ? "alerte" : ""}`}>
      <div className="valeur">{props.value}</div>
      <div className="libelle">{props.label}</div>
    </div>
  );
}

/** Status badge with tone color and descriptive label. */
export function State({ tone, label }: { tone: string; label: string }) {
  return (
    <span className="etat">
      <span className={`puce ${tone}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export function Bar({ percent }: { percent: number }) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <div
      className="jauge"
      title={`${String(value)} %`}
      role="progressbar"
      aria-label="Usage"
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

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="vide">
      <strong>No data</strong>
      <span>{children}</span>
    </div>
  );
}

/**
 * Section loader hook with isolated error and reload states.
 */
export function useSection<T>(load: () => Promise<T>): {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void load()
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
  }, [tick]);

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
  if (props.state.error !== undefined) {
    return (
      <div className="banner error section-error" role="alert">
        <span>{props.state.error}</span>
        <button className="bouton compact" type="button" onClick={props.state.reload}>
          Retry
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
      <Empty>No data available for this section.</Empty>
    );
  }
  return <>{props.children(props.state.data)}</>;
}
