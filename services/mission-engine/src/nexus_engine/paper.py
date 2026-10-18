from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP
from typing import Any
from urllib.parse import urlsplit

from nexus_engine.database import Database
from nexus_engine.domain import canonical_json
from nexus_engine.errors import ConflictError, NotFoundError, ValidationError
from nexus_engine.repository import timestamp


PPM = Decimal(1_000_000)


@dataclass(frozen=True)
class RiskPolicy:
    max_position_fraction: Decimal = Decimal("0.02")
    max_total_exposure_fraction: Decimal = Decimal("0.10")
    max_daily_deployed_fraction: Decimal = Decimal("0.03")
    max_drawdown_fraction: Decimal = Decimal("0.10")
    fractional_kelly: Decimal = Decimal("0.25")
    min_edge: Decimal = Decimal("0.05")
    min_confidence: Decimal = Decimal("0.60")
    fee_bps: int = 20
    slippage_bps: int = 30
    max_orders_per_day: int = 5
    max_open_positions: int = 5
    minimum_stake_cents: int = 25
    max_quote_age_seconds: int = 60
    min_liquidity_multiple: int = 5

    def validate(self) -> None:
        fractions = {
            "max_position_fraction": self.max_position_fraction,
            "max_total_exposure_fraction": self.max_total_exposure_fraction,
            "max_daily_deployed_fraction": self.max_daily_deployed_fraction,
            "max_drawdown_fraction": self.max_drawdown_fraction,
            "fractional_kelly": self.fractional_kelly,
            "min_edge": self.min_edge,
            "min_confidence": self.min_confidence,
        }
        for label, value in fractions.items():
            if not Decimal("0") < value <= Decimal("1"):
                raise ValidationError(f"{label} must be in (0, 1]")
        if self.max_position_fraction > self.max_total_exposure_fraction:
            raise ValidationError("position limit cannot exceed total exposure limit")
        if not 0 <= self.fee_bps <= 1000 or not 0 <= self.slippage_bps <= 1000:
            raise ValidationError("fees and slippage must be between 0 and 1000 bps")
        if not 1 <= self.max_orders_per_day <= 100:
            raise ValidationError("max_orders_per_day must be between 1 and 100")
        if not 1 <= self.max_open_positions <= 20:
            raise ValidationError("max_open_positions must be between 1 and 20")
        if not 1 <= self.minimum_stake_cents <= 10_000:
            raise ValidationError("minimum_stake_cents is invalid")
        if not 1 <= self.max_quote_age_seconds <= 3600:
            raise ValidationError("max_quote_age_seconds is invalid")
        if not 1 <= self.min_liquidity_multiple <= 100:
            raise ValidationError("min_liquidity_multiple is invalid")

    def json_value(self) -> dict[str, Any]:
        value = asdict(self)
        return {key: str(item) if isinstance(item, Decimal) else item for key, item in value.items()}

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> RiskPolicy:
        return cls(
            max_position_fraction=Decimal(str(value["max_position_fraction"])),
            max_total_exposure_fraction=Decimal(str(value["max_total_exposure_fraction"])),
            max_daily_deployed_fraction=Decimal(str(value["max_daily_deployed_fraction"])),
            max_drawdown_fraction=Decimal(str(value.get("max_drawdown_fraction", "0.10"))),
            fractional_kelly=Decimal(str(value["fractional_kelly"])),
            min_edge=Decimal(str(value["min_edge"])),
            min_confidence=Decimal(str(value["min_confidence"])),
            fee_bps=int(value["fee_bps"]),
            slippage_bps=int(value["slippage_bps"]),
            max_orders_per_day=int(value["max_orders_per_day"]),
            max_open_positions=int(value.get("max_open_positions", 5)),
            minimum_stake_cents=int(value.get("minimum_stake_cents", 25)),
            max_quote_age_seconds=int(value.get("max_quote_age_seconds", 60)),
            min_liquidity_multiple=int(value.get("min_liquidity_multiple", 5)),
        )


def _cents(eur: Decimal) -> int:
    return int((eur * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _ppm(probability: Decimal) -> int:
    if not Decimal("0") < probability < Decimal("1"):
        raise ValidationError("probability must be strictly between 0 and 1")
    return int((probability * PPM).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _safe_evidence_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValidationError("source_url must be a public HTTPS URL without credentials")
    return value


class PaperTradingRepository:
    """Deterministic paper-only ledger. It contains no network execution path."""

    def __init__(self, database: Database):
        self.db = database
        self.db.migrate()

    def create_account(self, name: str, bankroll_eur: Decimal, policy: RiskPolicy) -> dict[str, Any]:
        if not name.strip() or len(name) > 100:
            raise ValidationError("account name must contain 1 to 100 characters")
        cents = _cents(bankroll_eur)
        if not 100 <= cents <= 1_000_000:
            raise ValidationError("paper bankroll must be between 1 and 10000 EUR")
        policy.validate()
        account_id = str(uuid.uuid4())
        current = timestamp()
        with self.db.transaction(immediate=True) as connection:
            connection.execute(
                """INSERT INTO paper_accounts(
                    id,name,currency,initial_balance_cents,cash_balance_cents,
                    risk_policy_json,live_trading,created_at,updated_at
                ) VALUES (?,?, 'EUR', ?, ?, ?, 0, ?, ?)""",
                (account_id, name.strip(), cents, cents, canonical_json(policy.json_value()), current, current),
            )
            self._audit(connection, "paper.account.created", account_id, {"bankroll_cents": cents}, current)
        return self.account(account_id)

    def account(self, account_id: str) -> dict[str, Any]:
        with self.db.connect() as connection:
            row = connection.execute("SELECT * FROM paper_accounts WHERE id=?", (account_id,)).fetchone()
            if not row:
                raise NotFoundError(account_id)
            exposure = connection.execute(
                "SELECT COALESCE(SUM(stake_cents),0) FROM paper_orders WHERE account_id=? AND state='filled'",
                (account_id,),
            ).fetchone()[0]
            orders = [dict(item) for item in connection.execute(
                "SELECT * FROM paper_orders WHERE account_id=? ORDER BY created_at", (account_id,)
            )]
            result = dict(row)
            result["risk_policy"] = json.loads(result.pop("risk_policy_json"))
            result["open_exposure_cents"] = int(exposure)
            result["orders"] = orders
            return result

    def accounts(self, limit: int = 50) -> list[dict[str, Any]]:
        bounded = max(1, min(limit, 200))
        with self.db.connect() as connection:
            ids = [
                str(row["id"])
                for row in connection.execute(
                    "SELECT id FROM paper_accounts ORDER BY created_at DESC LIMIT ?", (bounded,)
                )
            ]
        return [self.account(account_id) for account_id in ids]

    def create_market(self, question: str, close_at: datetime) -> dict[str, Any]:
        if not question.strip() or len(question) > 500:
            raise ValidationError("market question must contain 1 to 500 characters")
        if close_at.tzinfo is None:
            raise ValidationError("market close_at must include a timezone")
        close = close_at.astimezone(UTC)
        if close <= datetime.now(UTC):
            raise ValidationError("market close_at must be in the future")
        market_id = str(uuid.uuid4())
        current = timestamp()
        with self.db.transaction(immediate=True) as connection:
            connection.execute(
                "INSERT INTO paper_markets(id,question,close_at,venue,state,created_at,updated_at) VALUES (?,?,?,'paper','open',?,?)",
                (market_id, question.strip(), timestamp(close), current, current),
            )
            self._audit(connection, "paper.market.created", market_id, {"question": question.strip()}, current)
        return self.market(market_id)

    def market(self, market_id: str) -> dict[str, Any]:
        with self.db.connect() as connection:
            row = connection.execute("SELECT * FROM paper_markets WHERE id=?", (market_id,)).fetchone()
            if not row:
                raise NotFoundError(market_id)
            quote = connection.execute(
                "SELECT * FROM paper_quotes WHERE market_id=? ORDER BY observed_at DESC, created_at DESC LIMIT 1",
                (market_id,),
            ).fetchone()
            result = dict(row)
            result["latest_quote"] = dict(quote) if quote else None
            return result

    def markets(self, limit: int = 50) -> list[dict[str, Any]]:
        bounded = max(1, min(limit, 200))
        with self.db.connect() as connection:
            ids = [
                str(row["id"])
                for row in connection.execute(
                    "SELECT id FROM paper_markets ORDER BY created_at DESC LIMIT ?", (bounded,)
                )
            ]
        return [self.market(market_id) for market_id in ids]

    def add_quote(
        self,
        market_id: str,
        yes_price: Decimal,
        liquidity_eur: Decimal,
        source_url: str,
        observed_at: datetime,
    ) -> dict[str, Any]:
        price = _ppm(yes_price)
        liquidity = _cents(liquidity_eur)
        if liquidity < 0:
            raise ValidationError("liquidity cannot be negative")
        source = _safe_evidence_url(source_url)
        quote_id = str(uuid.uuid4())
        current = timestamp()
        with self.db.transaction(immediate=True) as connection:
            market = connection.execute("SELECT state,close_at FROM paper_markets WHERE id=?", (market_id,)).fetchone()
            if not market:
                raise NotFoundError(market_id)
            if market["state"] != "open":
                raise ConflictError("market is not open")
            if observed_at.tzinfo is None:
                raise ValidationError("observed_at must include a timezone")
            if observed_at.astimezone(UTC) > datetime.now(UTC):
                raise ValidationError("observed_at cannot be in the future")
            connection.execute(
                "INSERT INTO paper_quotes(id,market_id,yes_price_ppm,liquidity_cents,source_url,observed_at,created_at) VALUES (?,?,?,?,?,?,?)",
                (quote_id, market_id, price, liquidity, source, timestamp(observed_at.astimezone(UTC)), current),
            )
            self._audit(connection, "paper.quote.recorded", market_id, {"quote_id": quote_id, "yes_price_ppm": price}, current)
        return {"id": quote_id, "market_id": market_id, "yes_price_ppm": price, "liquidity_cents": liquidity}

    def place_order(
        self,
        *,
        account_id: str,
        market_id: str,
        model_probability: Decimal,
        confidence: Decimal,
        idempotency_key: str,
    ) -> dict[str, Any]:
        model_ppm = _ppm(model_probability)
        if not Decimal("0") < confidence <= Decimal("1"):
            raise ValidationError("confidence must be in (0, 1]")
        confidence_ppm = _ppm(confidence) if confidence < 1 else 1_000_000
        if not idempotency_key or len(idempotency_key) > 128:
            raise ValidationError("a non-empty idempotency key up to 128 chars is required")
        current = timestamp()
        today = datetime.now(UTC).date().isoformat()
        with self.db.transaction(immediate=True) as connection:
            existing = connection.execute("SELECT * FROM paper_orders WHERE idempotency_key=?", (idempotency_key,)).fetchone()
            if existing:
                if (
                    existing["account_id"] != account_id
                    or existing["market_id"] != market_id
                    or int(existing["model_probability_ppm"]) != model_ppm
                    or int(existing["confidence_ppm"]) != confidence_ppm
                ):
                    raise ConflictError("idempotency key reused with different order input")
                return dict(existing)
            account = connection.execute("SELECT * FROM paper_accounts WHERE id=?", (account_id,)).fetchone()
            market = connection.execute("SELECT * FROM paper_markets WHERE id=?", (market_id,)).fetchone()
            if not account or not market:
                raise NotFoundError("account or market not found")
            if int(account["live_trading"]) != 0:
                raise ConflictError("live trading is forbidden")
            if market["venue"] != "paper" or market["state"] != "open":
                raise ConflictError("only open paper markets are supported")
            if datetime.fromisoformat(str(market["close_at"])) <= datetime.now(UTC):
                raise ConflictError("market is closed")
            quote = connection.execute(
                "SELECT * FROM paper_quotes WHERE market_id=? ORDER BY observed_at DESC,created_at DESC LIMIT 1",
                (market_id,),
            ).fetchone()
            if not quote:
                raise ConflictError("market has no quote")
            policy = RiskPolicy.from_json(json.loads(str(account["risk_policy_json"])))
            quote_age = (datetime.now(UTC) - datetime.fromisoformat(str(quote["observed_at"]))).total_seconds()
            price_yes = Decimal(int(quote["yes_price_ppm"])) / PPM
            p_model = Decimal(model_ppm) / PPM
            outcome = "yes" if p_model >= price_yes else "no"
            market_price = price_yes if outcome == "yes" else Decimal(1) - price_yes
            model_outcome = p_model if outcome == "yes" else Decimal(1) - p_model
            edge = model_outcome - market_price
            reasons: list[str] = []
            if Decimal(confidence_ppm) / PPM < policy.min_confidence:
                reasons.append("confidence_below_minimum")
            if edge < policy.min_edge:
                reasons.append("edge_below_minimum")
            if quote_age > policy.max_quote_age_seconds:
                reasons.append("stale_quote")
            open_exposure = int(connection.execute(
                "SELECT COALESCE(SUM(stake_cents),0) FROM paper_orders WHERE account_id=? AND state='filled'",
                (account_id,),
            ).fetchone()[0])
            daily = int(connection.execute(
                "SELECT COALESCE(SUM(stake_cents),0) FROM paper_orders WHERE account_id=? AND substr(created_at,1,10)=?",
                (account_id, today),
            ).fetchone()[0])
            count = int(connection.execute(
                "SELECT COUNT(*) FROM paper_orders WHERE account_id=? AND substr(created_at,1,10)=?",
                (account_id, today),
            ).fetchone()[0])
            open_positions = int(connection.execute(
                "SELECT COUNT(DISTINCT market_id) FROM paper_orders WHERE account_id=? AND state='filled'",
                (account_id,),
            ).fetchone()[0])
            bankroll = int(account["initial_balance_cents"])
            kelly = max(Decimal(0), edge / (Decimal(1) - market_price))
            proposed = int((Decimal(bankroll) * kelly * policy.fractional_kelly).quantize(Decimal("1"), rounding=ROUND_DOWN))
            proposed = min(proposed, int(Decimal(bankroll) * policy.max_position_fraction))
            proposed = min(proposed, int(account["cash_balance_cents"]))
            if open_exposure + proposed > int(Decimal(bankroll) * policy.max_total_exposure_fraction):
                reasons.append("total_exposure_limit")
            if daily + proposed > int(Decimal(bankroll) * policy.max_daily_deployed_fraction):
                reasons.append("daily_deployment_limit")
            if count >= policy.max_orders_per_day:
                reasons.append("daily_order_limit")
            if open_positions >= policy.max_open_positions:
                reasons.append("open_position_limit")
            if int(account["realized_pnl_cents"]) <= -int(Decimal(bankroll) * policy.max_drawdown_fraction):
                reasons.append("drawdown_kill_switch")
            if proposed < policy.minimum_stake_cents:
                reasons.append("stake_below_minimum")
            if int(quote["liquidity_cents"]) < proposed * policy.min_liquidity_multiple:
                reasons.append("insufficient_liquidity")
            inputs = {
                "model_probability_ppm": model_ppm,
                "confidence_ppm": confidence_ppm,
                "market_yes_price_ppm": int(quote["yes_price_ppm"]),
                "edge_ppm": int(edge * PPM),
                "open_exposure_cents": open_exposure,
                "daily_deployed_cents": daily,
                "quote_age_seconds": int(quote_age),
                "liquidity_cents": int(quote["liquidity_cents"]),
            }
            decision_id = str(uuid.uuid4())
            allowed = not reasons
            connection.execute(
                "INSERT INTO risk_decisions(id,account_id,market_id,allowed,proposed_stake_cents,reasons_json,inputs_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
                (decision_id, account_id, market_id, int(allowed), proposed, canonical_json(reasons), canonical_json(inputs), current),
            )
            self._audit(connection, "risk.decision", decision_id, {"allowed": allowed, "reasons": reasons, "stake_cents": proposed}, current)
            if not allowed:
                return {"filled": False, "risk_decision_id": decision_id, "stake_cents": proposed, "reasons": reasons}
            slippage = Decimal(policy.slippage_bps) / Decimal(10_000)
            execution_price = min(Decimal("0.999999"), market_price * (Decimal(1) + slippage))
            execution_ppm = int((execution_price * PPM).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
            fee = int((Decimal(proposed) * Decimal(policy.fee_bps) / Decimal(10_000)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
            spendable = proposed - fee
            if spendable <= 0:
                raise ConflictError("stake is too small after fees")
            shares_micro = int((Decimal(spendable) / execution_price * PPM).quantize(Decimal("1"), rounding=ROUND_DOWN))
            order_id = str(uuid.uuid4())
            connection.execute(
                """INSERT INTO paper_orders(
                    id,idempotency_key,account_id,market_id,outcome,stake_cents,fee_cents,
                    execution_price_ppm,shares_micro,model_probability_ppm,confidence_ppm,state,created_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'filled',?)""",
                (order_id, idempotency_key, account_id, market_id, outcome, proposed, fee, execution_ppm, shares_micro, model_ppm, confidence_ppm, current),
            )
            connection.execute(
                "UPDATE paper_accounts SET cash_balance_cents=cash_balance_cents-?,updated_at=? WHERE id=?",
                (proposed, current, account_id),
            )
            self._audit(connection, "paper.order.filled", order_id, {"stake_cents": proposed, "outcome": outcome}, current)
            return {"filled": True, "id": order_id, "risk_decision_id": decision_id, "stake_cents": proposed, "outcome": outcome, "fee_cents": fee, "execution_price_ppm": execution_ppm}

    def settle_market(self, market_id: str, winning_outcome: str) -> dict[str, Any]:
        if winning_outcome not in {"yes", "no"}:
            raise ValidationError("winning_outcome must be yes or no")
        current = timestamp()
        with self.db.transaction(immediate=True) as connection:
            market = connection.execute("SELECT * FROM paper_markets WHERE id=?", (market_id,)).fetchone()
            if not market:
                raise NotFoundError(market_id)
            if market["state"] == "settled":
                if market["winning_outcome"] != winning_outcome:
                    raise ConflictError("market already settled with another outcome")
                return {"market_id": market_id, "winning_outcome": winning_outcome, "replayed": True}
            orders = connection.execute("SELECT * FROM paper_orders WHERE market_id=? AND state='filled'", (market_id,)).fetchall()
            for order in orders:
                payout = int((Decimal(int(order["shares_micro"])) / PPM).quantize(Decimal("1"), rounding=ROUND_DOWN)) if order["outcome"] == winning_outcome else 0
                pnl = payout - int(order["stake_cents"])
                connection.execute("UPDATE paper_orders SET state='settled',payout_cents=?,settled_at=? WHERE id=?", (payout, current, order["id"]))
                connection.execute("UPDATE paper_accounts SET cash_balance_cents=cash_balance_cents+?,realized_pnl_cents=realized_pnl_cents+?,updated_at=? WHERE id=?", (payout, pnl, current, order["account_id"]))
            connection.execute("UPDATE paper_markets SET state='settled',winning_outcome=?,updated_at=? WHERE id=?", (winning_outcome, current, market_id))
            self._audit(connection, "paper.market.settled", market_id, {"winning_outcome": winning_outcome, "orders": len(orders)}, current)
        return {"market_id": market_id, "winning_outcome": winning_outcome, "orders_settled": len(orders), "replayed": False}

    def audit(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.db.connect() as connection:
            return [dict(row) for row in connection.execute("SELECT * FROM audit_log ORDER BY sequence DESC LIMIT ?", (max(1, min(limit, 1000)),))]

    def verify_audit_chain(self) -> dict[str, Any]:
        previous_hash = "0" * 64
        checked = 0
        with self.db.connect() as connection:
            for row in connection.execute("SELECT * FROM audit_log ORDER BY sequence"):
                expected = hashlib.sha256(
                    f"{previous_hash}|{row['event_type']}|{row['aggregate_id']}|{row['payload_json']}|{row['created_at']}".encode()
                ).hexdigest()
                if row["previous_hash"] != previous_hash or row["event_hash"] != expected:
                    return {"valid": False, "checked": checked, "failed_sequence": row["sequence"]}
                previous_hash = str(row["event_hash"])
                checked += 1
        return {"valid": True, "checked": checked, "head": previous_hash}

    @staticmethod
    def _audit(connection, event_type: str, aggregate_id: str, payload: dict[str, Any], current: str) -> None:
        previous = connection.execute("SELECT event_hash FROM audit_log ORDER BY sequence DESC LIMIT 1").fetchone()
        previous_hash = str(previous[0]) if previous else "0" * 64
        payload_json = canonical_json(payload)
        event_hash = hashlib.sha256(f"{previous_hash}|{event_type}|{aggregate_id}|{payload_json}|{current}".encode()).hexdigest()
        connection.execute("INSERT INTO audit_log(event_type,aggregate_id,payload_json,previous_hash,event_hash,created_at) VALUES (?,?,?,?,?,?)", (event_type, aggregate_id, payload_json, previous_hash, event_hash, current))
