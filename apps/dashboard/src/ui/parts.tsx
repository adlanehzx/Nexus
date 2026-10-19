import { useCallback, useEffect, useState } from "react";

/**
 * Les briques du tableau de bord.
 *
 * Elles ne décident de rien : `lib/format.ts` tranche, elles dessinent. C'est ce
 * qui permet d'éprouver les décisions sans monter un DOM.
 */

export function Metric(props: { value: string; label: string; alert?: boolean }) {
  return (
    <div className={`mesure ${props.alert === true ? "alerte" : ""}`}>
      <div className="valeur">{props.value}</div>
      <div className="libelle">{props.label}</div>
    </div>
  );
}

/** Pastille d'état. La classe porte la couleur, le texte porte le sens. */
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
      aria-label="Utilisation"
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
    // Un tableau large défile dans son propre conteneur : la page, elle, ne doit
    // jamais défiler horizontalement.
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
  return <div className="vide"><strong>Aucune donnée</strong><span>{children}</span></div>;
}

/**
 * Chargement d'une section.
 *
 * Une section qui échoue n'emporte pas les autres : chacune porte son état, et
 * un serveur MCP injoignable ne doit pas vider l'écran des exécutants.
 *
 * `reload` est exposé pour le rafraîchissement manuel — et il n'y a **pas** de
 * rafraîchissement automatique par défaut : un tableau qui se réordonne pendant
 * qu'on le lit fait perdre la ligne qu'on suivait.
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
        setError(cause instanceof Error ? cause.message : "Chargement impossible.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `load` est recréée à chaque rendu par les appelants ; l'inclure
    // relancerait la requête en boucle. `tick` est le déclencheur explicite.
  }, [tick]);

  const reload = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  return { data, error, loading, reload };
}

/** Enveloppe une section : chargement, erreur, contenu. */
export function Section<T>(props: {
  state: ReturnType<typeof useSection<T>>;
  children: (data: T) => React.ReactNode;
}) {
  if (props.state.error !== undefined) {
    return (
      <div className="banniere erreur section-error" role="alert">
        <span>{props.state.error}</span>
        <button className="bouton compact" type="button" onClick={props.state.reload}>Réessayer</button>
      </div>
    );
  }
  if (props.state.data === undefined) {
    return props.state.loading ? (
      <div className="loading-state" role="status" aria-label="Chargement en cours">
        <span /><span /><span />
      </div>
    ) : <Empty>Aucune donnée disponible pour cette section.</Empty>;
  }
  return <>{props.children(props.state.data)}</>;
}
