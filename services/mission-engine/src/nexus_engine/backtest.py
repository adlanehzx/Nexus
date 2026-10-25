from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from decimal import Decimal, ROUND_DOWN
from pathlib import Path
from typing import Any

from nexus_engine.domain import canonical_json
from nexus_engine.errors import ValidationError


@dataclass(frozen=True)
class HistoricalObservation:
    at: str
    market_id: str
    yes_price: Decimal
    model_probability: Decimal
    resolved_yes: bool


@dataclass(frozen=True)
class BacktestPolicy:
    initial_cash_cents: int = 10_000
    max_stake_fraction: Decimal = Decimal("0.02")
    max_total_deployed_fraction: Decimal = Decimal("0.10")
    min_edge: Decimal = Decimal("0.05")

    def validate(self) -> None:
        if self.initial_cash_cents < 100:
            raise ValidationError("initial cash must be at least one paper currency unit")
        if not Decimal("0") < self.max_stake_fraction <= self.max_total_deployed_fraction <= Decimal("1"):
            raise ValidationError("backtest exposure limits are invalid")
        if not Decimal("0") <= self.min_edge < Decimal("1"):
            raise ValidationError("backtest minimum edge is invalid")


class ImmutableDataset:
    def __init__(self, raw: bytes, expected_sha256: str | None = None):
        self.raw = bytes(raw)
        self.sha256 = hashlib.sha256(self.raw).hexdigest()
        if expected_sha256 is not None and self.sha256 != expected_sha256:
            raise ValidationError("historical dataset hash does not match")

    @classmethod
    def from_path(cls, path: Path, expected_sha256: str) -> ImmutableDataset:
        if not path.is_file() or path.is_symlink():
            raise ValidationError("historical dataset must be a regular file")
        return cls(path.read_bytes(), expected_sha256)

    def observations(self) -> list[HistoricalObservation]:
        try:
            rows = json.loads(self.raw)
            if not isinstance(rows, list):
                raise TypeError
            parsed = [HistoricalObservation(at=str(row["at"]), market_id=str(row["market_id"]), yes_price=Decimal(str(row["yes_price"])), model_probability=Decimal(str(row["model_probability"])), resolved_yes=bool(row["resolved_yes"])) for row in rows]
        except (KeyError, TypeError, ValueError, ArithmeticError, json.JSONDecodeError) as error:
            raise ValidationError("historical dataset is malformed") from error
        if any(not item.market_id or not Decimal("0") < item.yes_price < Decimal("1") or not Decimal("0") < item.model_probability < Decimal("1") for item in parsed):
            raise ValidationError("historical observation is invalid")
        if [item.at for item in parsed] != sorted(item.at for item in parsed):
            raise ValidationError("historical observations must be ordered")
        return parsed


class HistoricalBacktester:
    def run(self, dataset: ImmutableDataset, policy: BacktestPolicy) -> dict[str, Any]:
        policy.validate()
        cash = policy.initial_cash_cents
        deployed = 0
        previous_hash = "0" * 64
        journal: list[dict[str, Any]] = []
        for observation in dataset.observations():
            edge = observation.model_probability - observation.yes_price
            stake = min(int((Decimal(policy.initial_cash_cents) * policy.max_stake_fraction).quantize(Decimal("1"), rounding=ROUND_DOWN)), cash)
            max_total = int(Decimal(policy.initial_cash_cents) * policy.max_total_deployed_fraction)
            allowed = edge >= policy.min_edge and deployed + stake <= max_total and stake > 0
            payout = 0
            if allowed:
                cash -= stake
                deployed += stake
                if observation.resolved_yes:
                    payout = int((Decimal(stake) / observation.yes_price).quantize(Decimal("1"), rounding=ROUND_DOWN))
                    cash += payout
            body = {
                "sequence": len(journal) + 1,
                "dataset_sha256": dataset.sha256,
                "at": observation.at,
                "market_id": observation.market_id,
                "market_price": str(observation.yes_price),
                "model_probability": str(observation.model_probability),
                "edge": str(edge),
                "allowed": allowed,
                "stake_cents": stake if allowed else 0,
                "payout_cents": payout,
                "previous_hash": previous_hash,
            }
            entry_hash = hashlib.sha256((previous_hash + canonical_json(body)).encode()).hexdigest()
            journal.append({**body, "hash": entry_hash})
            previous_hash = entry_hash
        return {
            "mode": "paper_only",
            "dataset_sha256": dataset.sha256,
            "strategy_sha256": hashlib.sha256(canonical_json({**asdict(policy), "max_stake_fraction": str(policy.max_stake_fraction), "max_total_deployed_fraction": str(policy.max_total_deployed_fraction), "min_edge": str(policy.min_edge)}).encode()).hexdigest(),
            "final_cash_cents": cash,
            "deployed_cents": deployed,
            "journal": journal,
            "journal_head": previous_hash,
        }

    @staticmethod
    def verify(result: dict[str, Any]) -> bool:
        previous_hash = "0" * 64
        for entry in result.get("journal", []):
            body = {key: value for key, value in entry.items() if key != "hash"}
            if body.get("previous_hash") != previous_hash:
                return False
            computed = hashlib.sha256((previous_hash + canonical_json(body)).encode()).hexdigest()
            if computed != entry.get("hash"):
                return False
            previous_hash = computed
        return previous_hash == result.get("journal_head")
