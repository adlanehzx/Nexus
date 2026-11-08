import { useEffect, useRef, useState } from "react";
import type { DashboardApi } from "../../lib/api.js";
import { paperOrderInput, paperOrderPnl } from "../../lib/paper-trading.js";
import { IconBarChart } from "../icons.js";
import { Empty, Table, useSection } from "../parts.js";
import { useI18n } from "../i18n/index.js";

export function PaperTrading({
  api,
  accountIds,
  marketIds,
  onChanged,
}: {
  api: DashboardApi;
  accountIds: string[];
  marketIds: string[];
  onChanged: () => void;
}) {
  const { tr } = useI18n();
  const [accountId, setAccountId] = useState("");
  const [marketId, setMarketId] = useState("");
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [probability, setProbability] = useState("0.7");
  const [confidence, setConfidence] = useState("0.9");
  const [price, setPrice] = useState("0.5");
  const [liquidity, setLiquidity] = useState("1000");
  const [source, setSource] = useState("");
  const [settlement, setSettlement] = useState<"yes" | "no" | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  // Preserve a failed request's key so a retry cannot fill the same intent twice.
  const intent = useRef<{ body: string; key: string } | null>(null);
  const state = useSection(async () => {
    const [accounts, markets] = await Promise.all([
      Promise.all(accountIds.map((id) => api.getPaperAccount(id))),
      Promise.all(marketIds.map((id) => api.getPaperMarket(id))),
    ]);
    return { accounts, markets };
  }, [api, accountIds.join(","), marketIds.join(",")]);
  useEffect(() => {
    const timer = setInterval(state.reload, 10_000);
    return () => clearInterval(timer);
  }, [state.reload]);
  const account = state.data?.accounts.find((a) => a.id === accountId) ?? state.data?.accounts[0];
  const market = state.data?.markets.find((m) => m.id === marketId) ?? state.data?.markets[0];
  const open = market?.state === "open" && Date.parse(market.close_at) > Date.now();
  const act = async (operation: () => Promise<string>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setMessage(await operation());
      state.reload();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const money = (cents: number) => `${(cents / 100).toFixed(2)} EUR`;
  return (
    <section
      className="card"
      aria-label={tr("Paper orders and settlement", "Ordres simulés et règlement")}
    >
      <h3>
        <IconBarChart size={18} />{" "}
        {tr("Paper orders and settlement", "Ordres simulés et règlement")}
      </h3>
      <p className="muted">
        {tr(
          "Refreshes every 10 seconds. Orders fill immediately or are declined by the engine's risk policy. Buy Yes / Buy No are opposing positions; selling existing holdings is not supported. Stake is calculated by the engine.",
          "Actualisation toutes les 10 secondes. Les ordres sont exécutés immédiatement ou refusés par la politique de risque du moteur. Acheter Oui / Acheter Non sont des positions opposées ; la vente de positions existantes n'est pas prise en charge. La mise est calculée par le moteur.",
        )}
      </p>
      {state.error || error ? (
        <p role="alert" className="banner error">
          {error || state.error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      <button
        className="button"
        type="button"
        disabled={busy || state.loading}
        onClick={state.reload}
      >
        {tr("Refresh", "Actualiser")}
      </button>
      {!state.data ? (
        <p>{tr("Loading paper trading...", "Chargement de la simulation...")}</p>
      ) : (
        <>
          <div className="inline-admin-form">
            <label>
              {tr("Account", "Compte")}
              <select
                className="field"
                value={account?.id ?? ""}
                disabled={busy}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {state.data.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tr("Market", "Marché")}
              <select
                className="field"
                value={market?.id ?? ""}
                disabled={busy}
                onChange={(e) => {
                  setMarketId(e.target.value);
                  setSettlement(null);
                }}
              >
                {state.data.markets.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.question} ({m.state})
                  </option>
                ))}
              </select>
            </label>
          </div>
          {account ? (
            <p>
              {tr("Cash", "Liquidités")}: {money(account.cash_balance_cents)} |{" "}
              {tr("Exposure", "Exposition")}: {money(account.open_exposure_cents)} |{" "}
              {tr("Realized P&L", "P&L réalisé")}: {money(account.realized_pnl_cents)}
            </p>
          ) : (
            <Empty>{tr("Create an account first.", "Créez d'abord un compte.")}</Empty>
          )}
          <h4>{tr("Virtual order book", "Carnet virtuel")}</h4>
          {market?.latest_quote ? (
            <Table
              head={[
                tr("Buy Yes", "Acheter Oui"),
                tr("Buy No", "Acheter Non"),
                tr("Liquidity", "Liquidité"),
                tr("Observed", "Observé"),
              ]}
            >
              <tr>
                <td>{(market.latest_quote.yes_price_ppm / 1_000_000).toFixed(4)}</td>
                <td>{(1 - market.latest_quote.yes_price_ppm / 1_000_000).toFixed(4)}</td>
                <td>{money(market.latest_quote.liquidity_cents)}</td>
                <td>{market.latest_quote.observed_at}</td>
              </tr>
            </Table>
          ) : (
            <Empty>{tr("No quote available.", "Aucune cotation disponible.")}</Empty>
          )}
          <p className="muted">
            {tr(
              "Latest simulated quote; no resting limit orders or market depth.",
              "Dernière cotation simulée ; aucun ordre limite en attente ni profondeur de marché.",
            )}
          </p>
          <form
            className="inline-admin-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                if (!market) throw new Error("Select a market");
                await api.addPaperQuote(market.id, {
                  yes_price: price,
                  liquidity_eur: liquidity,
                  source_url: source,
                  observed_at: new Date().toISOString(),
                });
                return tr("Quote recorded.", "Cotation enregistrée.");
              });
            }}
          >
            <label>
              {tr("Yes price (0.01–0.99)", "Prix Oui (0,01–0,99)")}
              <input
                className="field"
                type="number"
                min="0.01"
                max="0.99"
                step="0.000001"
                required
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </label>
            <label>
              {tr("Liquidity EUR", "Liquidité EUR")}
              <input
                className="field"
                type="number"
                min="0"
                step="0.01"
                required
                value={liquidity}
                onChange={(e) => setLiquidity(e.target.value)}
              />
            </label>
            <label>
              {tr("Source HTTPS URL", "URL source HTTPS")}
              <input
                className="field"
                type="url"
                pattern="https://.*"
                required
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
            </label>
            <button className="button" disabled={busy || !open}>
              {tr("Record quote", "Enregistrer la cotation")}
            </button>
          </form>
          <form
            className="inline-admin-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                if (!market || !account) throw new Error("Select an account and market");
                const input = paperOrderInput(account.id, market, side, probability, confidence);
                const body = JSON.stringify(input);
                if (intent.current?.body !== body)
                  intent.current = { body, key: crypto.randomUUID() };
                const result = await api.placePaperOrder(input, intent.current.key);
                intent.current = null;
                return result.filled === false
                  ? `${tr("Declined", "Refusé")}: ${result.reasons.join(", ")}`
                  : `${tr("Filled", "Exécuté")}: ${result.outcome}, ${money(result.stake_cents)}`;
              });
            }}
          >
            <label>
              {tr("Side", "Position")}
              <select
                className="field"
                value={side}
                onChange={(e) => setSide(e.target.value as "yes" | "no")}
              >
                <option value="yes">{tr("Buy Yes", "Acheter Oui")}</option>
                <option value="no">
                  {tr("Buy No (opposite exposure)", "Acheter Non (exposition inverse)")}
                </option>
              </select>
            </label>
            <label>
              {tr("Model probability of Yes", "Probabilité estimée de Oui")}
              <input
                className="field"
                type="number"
                min="0.000001"
                max="0.999999"
                step="0.000001"
                required
                value={probability}
                onChange={(e) => setProbability(e.target.value)}
              />
            </label>
            <label>
              {tr("Confidence", "Confiance")}
              <input
                className="field"
                type="number"
                min="0.000001"
                max="1"
                step="0.000001"
                required
                value={confidence}
                onChange={(e) => setConfidence(e.target.value)}
              />
            </label>
            <button
              className="button"
              disabled={busy || !open || !market?.latest_quote || !account}
            >
              {tr("Submit paper order", "Soumettre l'ordre simulé")}
            </button>
          </form>
          <h4>{tr("Positions and order history", "Positions et historique des ordres")}</h4>
          {!account?.orders.length ? (
            <Empty>{tr("No positions.", "Aucune position.")}</Empty>
          ) : (
            <Table
              head={[
                tr("Market", "Marché"),
                tr("Side", "Position"),
                tr("State", "État"),
                tr("Stake", "Mise"),
                tr("P&L (estimated while open)", "P&L (estimé si ouvert)"),
              ]}
            >
              {account.orders.map((order) => {
                const m = state.data?.markets.find((m) => m.id === order.market_id);
                const pnl = paperOrderPnl(order, m);
                return (
                  <tr key={order.id}>
                    <td>{m?.question ?? order.market_id}</td>
                    <td>{order.outcome}</td>
                    <td>{order.state}</td>
                    <td>{money(order.stake_cents)}</td>
                    <td>{pnl === null ? tr("Unavailable", "Indisponible") : money(pnl)}</td>
                  </tr>
                );
              })}
            </Table>
          )}
          {market?.state === "open" ? (
            <div>
              <h4>{tr("Settle selected market", "Régler le marché sélectionné")}</h4>
              <p>
                {tr(
                  "Settlement resolves all accounts' positions on this market and cannot be undone.",
                  "Le règlement clôture les positions de tous les comptes sur ce marché et ne peut pas être annulé.",
                )}
              </p>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setSettlement("yes")}
              >
                {tr("Winning outcome: Yes", "Résultat gagnant : Oui")}
              </button>{" "}
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setSettlement("no")}
              >
                {tr("Winning outcome: No", "Résultat gagnant : Non")}
              </button>
              {settlement ? (
                <p>
                  {market.question}: {settlement}{" "}
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api.settlePaperMarket(market.id, settlement);
                        setSettlement(null);
                        return tr("Market settled.", "Marché réglé.");
                      })
                    }
                  >
                    {tr("Confirm settlement", "Confirmer le règlement")}
                  </button>{" "}
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => setSettlement(null)}
                  >
                    {tr("Cancel", "Annuler")}
                  </button>
                </p>
              ) : null}
            </div>
          ) : market ? (
            <p>
              {market.state}: {market.winning_outcome}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
