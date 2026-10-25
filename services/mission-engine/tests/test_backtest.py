from __future__ import annotations

import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from nexus_engine.backtest import BacktestPolicy, HistoricalBacktester, ImmutableDataset
from nexus_engine.errors import ValidationError
from nexus_engine.polymarket import PolymarketPaperDataAdapter


ROWS = [
    {"at": "2026-01-01T00:00:00Z", "market_id": "m1", "yes_price": "0.40", "model_probability": "0.70", "resolved_yes": True},
    {"at": "2026-01-02T00:00:00Z", "market_id": "m2", "yes_price": "0.60", "model_probability": "0.61", "resolved_yes": False},
]


def test_backtest_is_reproducible_bounded_and_tamper_evident(tmp_path: Path) -> None:
    raw = json.dumps(ROWS, separators=(",", ":")).encode()
    path = tmp_path / "history.json"
    path.write_bytes(raw)
    dataset = ImmutableDataset.from_path(path, hashlib.sha256(raw).hexdigest())
    engine = HistoricalBacktester()
    first = engine.run(dataset, BacktestPolicy())
    second = engine.run(dataset, BacktestPolicy())
    assert first == second
    assert first["mode"] == "paper_only"
    assert first["deployed_cents"] <= 1000
    assert first["journal"][0]["stake_cents"] == 200
    assert first["journal"][1]["allowed"] is False
    assert engine.verify(first) is True
    first["journal"][0]["stake_cents"] = 9000
    assert engine.verify(first) is False


def test_dataset_hash_and_order_are_enforced(tmp_path: Path) -> None:
    path = tmp_path / "history.json"
    path.write_text(json.dumps(list(reversed(ROWS))))
    with pytest.raises(ValidationError, match="hash"):
        ImmutableDataset.from_path(path, "0" * 64)
    with pytest.raises(ValidationError, match="ordered"):
        ImmutableDataset(path.read_bytes()).observations()


class MarketHandler(BaseHTTPRequestHandler):
    methods: list[str] = []

    def do_GET(self) -> None:  # noqa: N802
        self.methods.append("GET")
        body = json.dumps([{"id": "market-1", "question": "Will the test pass?", "outcomePrices": "[\"0.42\",\"0.58\"]", "liquidityNum": 2500, "updatedAt": "2026-10-25T00:00:00Z"}]).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        pass


def test_polymarket_compatibility_uses_real_read_only_http() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), MarketHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        observations = PolymarketPaperDataAdapter(f"http://127.0.0.1:{server.server_port}/").markets(limit=1)
        assert observations[0].market_id == "market-1"
        assert str(observations[0].yes_price) == "0.42"
        assert MarketHandler.methods == ["GET"]
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def test_adapter_has_no_order_or_authenticated_transport() -> None:
    adapter = PolymarketPaperDataAdapter(transport=lambda _url: b"[]")
    assert not hasattr(adapter, "order")
    assert not hasattr(adapter, "place_order")
    assert not hasattr(adapter, "submit")
    with pytest.raises(ValidationError, match="credentials"):
        PolymarketPaperDataAdapter("https://token:secret@example.test/")
    with pytest.raises(ValidationError, match="loopback"):
        PolymarketPaperDataAdapter("http://example.test/")
