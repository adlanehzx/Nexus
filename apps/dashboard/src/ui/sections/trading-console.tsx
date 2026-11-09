import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DashboardApi } from "../../lib/api.js";
import {
  defaultTradingVenue,
  type TradingConfig,
  type TradingStatus,
  type TradingVenueConfig,
} from "../../lib/trading.js";
import { IconShield, IconWarning } from "../icons.js";

export function TradingConsole({
  api,
  chart,
}: {
  api: DashboardApi;
  chart: (
    history: { at: string; equity: number; cash?: number; exposure?: number }[],
    currency: string,
  ) => ReactNode;
}) {
  const [status, setStatus] = useState<TradingStatus | null>(null);
  const [config, setConfig] = useState<TradingConfig>({
    mode: "virtual",
    enabled: false,
    venues: [],
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [production, setProduction] = useState(false);
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [selected, setSelected] = useState(0);
  const [symbol, setSymbol] = useState("");
  const [quantity, setQuantity] = useState("0.001");
  const [price, setPrice] = useState("");
  const [probability, setProbability] = useState("0.6");
  const [payoff, setPayoff] = useState("1");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .tradingStatus()
      .then((s) => {
        if (active) {
          setStatus(s);
          setConfig(s.config);
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [api]);
  async function act(fn: () => Promise<unknown>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      const s = await api.tradingStatus();
      setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const venue = config.venues[selected];
  const update = (patch: Partial<TradingVenueConfig>) =>
    setConfig((c) => ({
      ...c,
      venues: c.venues.map((v, i) => (i === selected ? { ...v, ...patch } : v)),
    }));
  const real = status?.config.mode === "live";
  const numeric: [
    keyof Pick<
      TradingVenueConfig,
      | "allocatedCapital"
      | "maxOrderSize"
      | "maxPositionSize"
      | "maxDailyLoss"
      | "maxDrawdown"
      | "kellyFraction"
    >,
    string,
  ][] = [
    ["allocatedCapital", "Capital alloué"],
    ["maxOrderSize", "Ordre maximum"],
    ["maxPositionSize", "Position maximum"],
    ["maxDailyLoss", "Perte journalière maximum"],
    ["maxDrawdown", "Drawdown maximum (0–1)"],
    ["kellyFraction", "Fraction Kelly (0–1)"],
  ];
  return (
    <div
      style={{
        padding: "var(--nx-space-4)",
        border: `2px solid ${real ? "var(--nx-danger)" : "var(--nx-signal)"}`,
        borderRadius: "var(--nx-radius-md)",
        marginBottom: "var(--nx-space-6)",
      }}
    >
      <h3>
        <IconShield size={18} /> Exécution crypto / actions
      </h3>
      <div
        role="status"
        style={{ color: real ? "var(--nx-danger)" : "var(--nx-signal)", fontWeight: 700 }}
      >
        {real
          ? "RÉEL — capital exposé aux marchés. Les environnements production utilisent de l’argent réel."
          : "VIRTUEL — ordres simulés"}{" "}
        {status?.killed ? "ARRÊT GLOBAL ACTIVÉ" : ""}
      </div>
      {status?.killErrors?.length ? (
        <p role="alert" style={{ color: "var(--nx-danger)" }}>
          {status.killErrors.join(" ; ")}
        </p>
      ) : null}
      <p>
        Le laboratoire de prédiction ci-dessous reste une simulation. Polymarket et Kalshi sont
        exclus de l’exécution réelle.
      </p>
      {error ? (
        <p role="alert" style={{ color: "var(--nx-danger)" }}>
          <IconWarning size={16} /> {error}
        </p>
      ) : null}
      <fieldset disabled={busy}>
        <legend>Configuration persistante</legend>
        <label>
          Mode{" "}
          <select
            value={config.mode}
            onChange={(e) =>
              setConfig({ ...config, mode: e.target.value as TradingConfig["mode"] })
            }
          >
            <option value="virtual">Virtuel</option>
            <option value="live">Réel</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
          />{" "}
          Activer les ordres
        </label>
        <label>
          Venue{" "}
          <select value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
            {config.venues.map((v, i) => (
              <option key={i} value={i}>
                {v.id} · {v.environment}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button"
          onClick={() => {
            setConfig({ ...config, venues: [...config.venues, defaultTradingVenue()] });
            setSelected(config.venues.length);
          }}
        >
          Ajouter une venue
        </button>
        {venue ? (
          <div
            style={{ display: "grid", gap: "var(--nx-space-3)", marginTop: "var(--nx-space-4)" }}
          >
            <label>
              Plateforme{" "}
              <select
                value={venue.id}
                onChange={(e) => update({ id: e.target.value as TradingVenueConfig["id"] })}
              >
                <option>binance</option>
                <option>kraken</option>
                <option>ibkr</option>
              </select>
            </label>
            <label>
              Environnement{" "}
              <select
                value={venue.environment}
                onChange={(e) =>
                  update({ environment: e.target.value as TradingVenueConfig["environment"] })
                }
              >
                <option value="testnet">Testnet / paper IBKR</option>
                <option value="production">Production</option>
              </select>
            </label>
            {venue.id === "kraken" ? (
              <p>
                Kraken Spot : aucun sandbox public. Testnet bloqué explicitement. Aucun basculement
                automatique.
              </p>
            ) : null}
            <label>
              Devise de cotation (code exact de la venue){" "}
              <input
                value={venue.quoteCurrency}
                onChange={(e) => update({ quoteCurrency: e.target.value })}
              />
            </label>
            <label>
              Marchés autorisés (SYMBOL:BASE_ASSET, séparés par virgule ; IBKR conid:conid)
              <input
                value={venue.symbols.map((s) => `${s.symbol}:${s.baseAsset}`).join(",")}
                onChange={(e) =>
                  update({
                    symbols: e.target.value.split(",").map((x) => {
                      const [symbol = "", baseAsset = ""] = x.split(":");
                      return { symbol: symbol.trim(), baseAsset: baseAsset.trim() };
                    }),
                  })
                }
              />
            </label>
            {venue.id === "ibkr" ? (
              <>
                <label>
                  Compte IBKR{" "}
                  <input
                    value={venue.accountId}
                    onChange={(e) => update({ accountId: e.target.value })}
                  />
                </label>
                <label>
                  Client Portal Gateway HTTPS local{" "}
                  <input
                    value={venue.gatewayUrl}
                    onChange={(e) => update({ gatewayUrl: e.target.value })}
                  />
                </label>
                <p>
                  Session SSO authentifiée requise ; certificat TLS approuvé. Compte DU obligatoire
                  en environnement testnet.
                </p>
              </>
            ) : null}
            {numeric.map(([name, label]) => (
              <label key={name}>
                {label}
                <input
                  type="number"
                  step="any"
                  value={venue[name]}
                  onChange={(e) => update({ [name]: Number(e.target.value) })}
                />
              </label>
            ))}
            <p>Ordres autorisés : limite uniquement. Vente à découvert désactivée.</p>
            <label>
              <input
                type="checkbox"
                checked={venue.manualConfirmation}
                onChange={(e) => update({ manualConfirmation: e.target.checked })}
              />{" "}
              Confirmation manuelle de chaque ordre
            </label>
            <details>
              <summary>Identifiants — coffre de secrets</summary>
              <p>
                Utilisez des clés de trading uniquement, retraits désactivés. Les clés enregistrées
                ne sont jamais renvoyées au navigateur.
              </p>
              <label>
                Clé API
                <input
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
              </label>
              <label>
                Secret API
                <input
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="button"
                onClick={() =>
                  void act(async () => {
                    await api.tradingSetCredentials({
                      venue: venue.id,
                      environment: venue.environment,
                      apiKey: key,
                      apiSecret: secret,
                    });
                    setKey("");
                    setSecret("");
                  })
                }
              >
                Enregistrer les secrets
              </button>
            </details>
          </div>
        ) : null}
        <label>
          <input
            type="checkbox"
            checked={production}
            onChange={(e) => setProduction(e.target.checked)}
          />{" "}
          Je confirme explicitement l’activation de la production et le risque de perte d’argent
          réel.
        </label>
        <button
          type="button"
          className="button"
          onClick={() =>
            void act(async () => {
              await api.tradingConfigure({ config, confirmProduction: production });
              setProduction(false);
            })
          }
        >
          Enregistrer la configuration
        </button>
      </fieldset>
      <button
        type="button"
        disabled={busy}
        className="button"
        onClick={() => void act(() => api.tradingRefresh())}
      >
        Actualiser et vérifier le risque
      </button>
      <button
        type="button"
        disabled={busy}
        className="button"
        style={{ color: "var(--nx-danger)" }}
        onClick={() => void act(() => api.tradingKill())}
      >
        ARRÊT GLOBAL — annuler les ordres
      </button>
      <p>
        Kill switch verrouillé après activation. Une annulation échouée reste à résoudre auprès de
        la venue.
      </p>
      {status?.config.venues.map((c) => {
        const v = status.venues[c.id];
        return (
          <div key={c.id}>
            <h4>
              {c.id} · {c.environment} · {c.quoteCurrency}
            </h4>
            {v?.error ? (
              <p role="alert" style={{ color: "var(--nx-danger)" }}>
                {v.error}
              </p>
            ) : null}
            <p>
              Solde : {v?.cash.toFixed(2) ?? "Indisponible"} · Équité :{" "}
              {v?.equity.toFixed(2) ?? "Indisponible"}
            </p>
            {v?.history.length ? chart(v.history, c.quoteCurrency) : null}
            <table>
              <caption>Positions</caption>
              <thead>
                <tr>
                  <th>Symbole</th>
                  <th>Quantité</th>
                </tr>
              </thead>
              <tbody>
                {v?.positions.map((p) => (
                  <tr key={p.symbol}>
                    <td>{p.symbol}</td>
                    <td>{p.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table>
              <caption>Ordres</caption>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Marché</th>
                  <th>Quantité</th>
                  <th>Prix</th>
                  <th>État</th>
                </tr>
              </thead>
              <tbody>
                {v?.orders.map((o) => (
                  <tr key={o.id}>
                    <td>{o.id}</td>
                    <td>{o.symbol}</td>
                    <td>{o.quantity}</td>
                    <td>{o.price}</td>
                    <td>{o.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      <fieldset disabled={busy || !status?.config.enabled || status.killed}>
        <legend>Ordre via la stratégie Kelly commune</legend>
        <p>
          L’ordre utilise la configuration enregistrée. Tous les montants sont exprimés dans la
          devise de cotation de la venue.
        </p>
        <label>
          Symbole
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} />
        </label>
        <label>
          Sens
          <select value={side} onChange={(e) => setSide(e.target.value as "buy" | "sell")}>
            <option value="buy">Acheter</option>
            <option value="sell">Vendre</option>
          </select>
        </label>
        <label>
          Quantité
          <input
            type="number"
            step="any"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>
        <label>
          Prix limite
          <input
            type="number"
            step="any"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        <label>
          Probabilité de gain
          <input
            type="number"
            step="any"
            value={probability}
            onChange={(e) => setProbability(e.target.value)}
          />
        </label>
        <label>
          Ratio gain / perte
          <input
            type="number"
            step="any"
            value={payoff}
            onChange={(e) => setPayoff(e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />{" "}
          Je confirme cet ordre, sa venue, son mode et son montant.
        </label>
        <button
          type="button"
          className="button"
          onClick={() =>
            void act(async () => {
              if (!venue) throw new Error("Sélectionnez une venue");
              await api.tradingSubmitOrder({
                venue: venue.id,
                symbol,
                side,
                type: "limit",
                quantity: Number(quantity),
                price: Number(price),
                winProbability: Number(probability),
                payoffRatio: Number(payoff),
                confirmed,
                intentId: crypto.randomUUID(),
              });
              setConfirmed(false);
            })
          }
        >
          Envoyer l’ordre {status?.config.mode === "live" ? "réel" : "virtuel"}
        </button>
      </fieldset>
      <p>
        Audit : {status?.audit.entries ?? 0} événements · {status?.audit.head ?? "Aucun"}
      </p>
    </div>
  );
}
