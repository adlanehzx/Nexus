from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from nexus_engine.database import Database
from nexus_engine.errors import ConflictError
from nexus_engine.paper import PaperTradingRepository, RiskPolicy


@pytest.fixture
def paper(tmp_path) -> PaperTradingRepository:
    return PaperTradingRepository(Database(tmp_path / "paper.db"))


def account_and_market(paper: PaperTradingRepository):
    account = paper.create_account("Safe 50", Decimal("50.00"), RiskPolicy())
    market = paper.create_market(
        "Will the synthetic test event occur?", datetime.now(UTC) + timedelta(days=2)
    )
    paper.add_quote(
        market["id"],
        Decimal("0.50"),
        Decimal("100.00"),
        "https://example.org/evidence",
        datetime.now(UTC),
    )
    return account, market


def test_high_edge_order_is_capped_at_two_percent(paper) -> None:
    account, market = account_and_market(paper)
    result = paper.place_order(
        account_id=account["id"],
        market_id=market["id"],
        model_probability=Decimal("0.90"),
        confidence=Decimal("0.90"),
        idempotency_key="order-1",
    )
    assert result["filled"] is True
    assert result["stake_cents"] == 100
    stored = paper.account(account["id"])
    assert stored["cash_balance_cents"] == 4900
    assert stored["live_trading"] == 0


def test_low_edge_abstains_without_changing_cash(paper) -> None:
    account, market = account_and_market(paper)
    result = paper.place_order(
        account_id=account["id"],
        market_id=market["id"],
        model_probability=Decimal("0.52"),
        confidence=Decimal("0.90"),
        idempotency_key="order-low-edge",
    )
    assert result["filled"] is False
    assert "edge_below_minimum" in result["reasons"]
    assert paper.account(account["id"])["cash_balance_cents"] == 5000


def test_stale_quote_is_rejected(paper) -> None:
    account = paper.create_account("Safe 50", Decimal("50.00"), RiskPolicy())
    market = paper.create_market("Synthetic?", datetime.now(UTC) + timedelta(days=2))
    paper.add_quote(
        market["id"],
        Decimal("0.50"),
        Decimal("100.00"),
        "https://example.org/evidence",
        datetime.now(UTC) - timedelta(minutes=2),
    )
    result = paper.place_order(
        account_id=account["id"], market_id=market["id"],
        model_probability=Decimal("0.90"), confidence=Decimal("0.90"),
        idempotency_key="stale",
    )
    assert result["filled"] is False
    assert "stale_quote" in result["reasons"]


def test_order_idempotency_and_conflict(paper) -> None:
    account, market = account_and_market(paper)
    values = dict(
        account_id=account["id"], market_id=market["id"],
        model_probability=Decimal("0.90"), confidence=Decimal("0.90"),
        idempotency_key="same",
    )
    first = paper.place_order(**values)
    second = paper.place_order(**values)
    assert first["id"] == second["id"]
    assert paper.account(account["id"])["cash_balance_cents"] == 4900
    with pytest.raises(ConflictError):
        paper.place_order(**{**values, "model_probability": Decimal("0.80")})


def test_settlement_updates_cash_and_is_idempotent(paper) -> None:
    account, market = account_and_market(paper)
    paper.place_order(
        account_id=account["id"], market_id=market["id"],
        model_probability=Decimal("0.90"), confidence=Decimal("0.90"),
        idempotency_key="winner",
    )
    first = paper.settle_market(market["id"], "yes")
    second = paper.settle_market(market["id"], "yes")
    assert first["replayed"] is False
    assert second["replayed"] is True
    stored = paper.account(account["id"])
    assert stored["cash_balance_cents"] > 5000
    assert stored["open_exposure_cents"] == 0


def test_live_trading_cannot_be_enabled_in_database(paper) -> None:
    account = paper.create_account("Safe 50", Decimal("50.00"), RiskPolicy())
    with pytest.raises(Exception):
        with paper.db.transaction(immediate=True) as connection:
            connection.execute(
                "UPDATE paper_accounts SET live_trading=1 WHERE id=?", (account["id"],)
            )


def test_accounts_and_markets_are_listed_newest_first(paper) -> None:
    first = paper.create_account("First", Decimal("50.00"), RiskPolicy())
    second = paper.create_account("Second", Decimal("50.00"), RiskPolicy())
    market = paper.create_market("Listed?", datetime.now(UTC) + timedelta(days=2))
    assert [item["id"] for item in paper.accounts()] == [second["id"], first["id"]]
    assert [item["id"] for item in paper.markets()] == [market["id"]]


def test_audit_chain_verifies_and_detects_tampering(paper) -> None:
    paper.create_account("Safe 50", Decimal("50.00"), RiskPolicy())
    assert paper.verify_audit_chain()["valid"] is True
    with paper.db.transaction(immediate=True) as connection:
        connection.execute("UPDATE audit_log SET payload_json='{}' WHERE sequence=1")
    assert paper.verify_audit_chain()["valid"] is False
