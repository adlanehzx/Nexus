from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Callable
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen

from nexus_engine.errors import ValidationError


@dataclass(frozen=True)
class MarketObservation:
    market_id: str
    question: str
    yes_price: Decimal
    liquidity_usd: Decimal
    observed_at: datetime
    source_url: str


ReadTransport = Callable[[str], bytes]


def _read_only_http_get(url: str) -> bytes:
    request = Request(url, method="GET", headers={"Accept": "application/json"})
    with urlopen(request, timeout=10) as response:  # noqa: S310 -- URL is validated below.
        return response.read(2_000_001)


class PolymarketPaperDataAdapter:
    """Polymarket-compatible public-data reader. It has no auth or write transport."""

    def __init__(self, base_url: str = "https://gamma-api.polymarket.com/", transport: ReadTransport | None = None):
        parsed = urlsplit(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValidationError("market data base URL must be HTTP(S) without credentials")
        if parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ValidationError("unencrypted market data is allowed only on loopback")
        self._base_url = base_url.rstrip("/") + "/"
        self._transport = transport or _read_only_http_get

    def markets(self, *, limit: int = 100) -> list[MarketObservation]:
        if not 1 <= limit <= 500:
            raise ValidationError("market data limit must be between 1 and 500")
        url = urljoin(self._base_url, "markets") + "?" + urlencode({"active": "true", "closed": "false", "limit": limit})
        payload = self._transport(url)
        if len(payload) > 2_000_000:
            raise ValidationError("market data response exceeds 2 MB")
        try:
            decoded = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValidationError("market data response is not valid JSON") from error
        if not isinstance(decoded, list):
            raise ValidationError("market data response must be a list")
        return [self._normalize(item, url) for item in decoded]

    @staticmethod
    def _normalize(item: Any, source_url: str) -> MarketObservation:
        if not isinstance(item, dict):
            raise ValidationError("market entry must be an object")
        try:
            prices = item.get("outcomePrices", [])
            if isinstance(prices, str):
                prices = json.loads(prices)
            yes_price = Decimal(str(prices[0]))
            liquidity = Decimal(str(item.get("liquidityNum", item.get("liquidity", "0"))))
            market_id = str(item["id"])
            question = str(item["question"])
            observed = datetime.fromisoformat(str(item.get("updatedAt", datetime.now(UTC).isoformat())).replace("Z", "+00:00"))
        except (KeyError, IndexError, TypeError, ValueError, ArithmeticError, json.JSONDecodeError) as error:
            raise ValidationError("market entry is malformed") from error
        if not market_id or not question or not Decimal("0") < yes_price < Decimal("1") or liquidity < 0 or observed.tzinfo is None:
            raise ValidationError("market entry contains invalid values")
        return MarketObservation(market_id, question, yes_price, liquidity, observed.astimezone(UTC), source_url)
