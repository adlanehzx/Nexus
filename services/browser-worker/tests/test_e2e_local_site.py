"""Minimal end-to-end integration test against a local test website.

This test launches a real browser and real LLM when executed. Excluded by default
(``-m 'not browser'``): consumes API tokens and requires installed Chromium.

To run:
    python -m playwright install chromium
    export ANTHROPIC_API_KEY=...
    pytest -m browser tests/test_e2e_local_site.py
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import threading
from functools import partial
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app.models import Intent, TaskStatus
from app.policies import DomainPolicy, TaskPolicy
from app.runner import BrowserUseRunner, RunSpec

pytestmark = pytest.mark.browser

PORT = 8791
BASE_URL = f"http://127.0.0.1:{PORT}"

PAGE = """<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>NEXUS Flights</title></head>
  <body>
    <h1>Paris → Algiers</h1>
    <table>
      <tr><th>Flight</th><th>Departure</th><th>Price</th></tr>
      <tr><td>AH1005</td><td>Friday 8:15pm</td><td id="price">187 EUR</td></tr>
      <tr><td>AF2081</td><td>Saturday 7:40am</td><td>243 EUR</td></tr>
    </table>
    <button id="buy">Buy</button>
  </body>
</html>
"""


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        body = PAGE.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: object) -> None:
        pass


@pytest.fixture(scope="module")
def site() -> str:
    server = HTTPServer(("127.0.0.1", PORT), partial(_Handler))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield BASE_URL
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def runner() -> BrowserUseRunner:
    api_key = os.environ.get("BROWSER_WORKER_LLM_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        pytest.skip("LLM key missing: set ANTHROPIC_API_KEY")
    return BrowserUseRunner(model="claude-sonnet-4-5", api_key=api_key)


def _spec(site_url: str, intent: Intent, instructions: str) -> RunSpec:
    return RunSpec(
        task_id="e2e-1",
        session_id="e2e-session",
        instructions=instructions,
        intent=intent,
        policy=TaskPolicy(
            intent=intent,
            domains=DomainPolicy(allowed=("127.0.0.1",), allow_private_hosts=True),
        ),
        max_steps=6,
        timeout_seconds=180,
        headless=True,
    )


@pytest.mark.asyncio
async def test_reads_a_price_from_the_page(site: str, runner: BrowserUseRunner) -> None:
    events: list[tuple[str, dict]] = []
    spec = _spec(
        site,
        Intent.read,
        f"Open {site} and report the price for flight AH1005. Respond with only the price.",
    )

    try:
        outcome = await runner.run(spec, lambda t, p: events.append((t, p)), asyncio.Event())
    finally:
        with contextlib.suppress(Exception):
            await runner.close_session(spec.session_id)

    assert outcome.status is TaskStatus.succeeded, outcome.error_message
    assert "187" in outcome.output

    types = [event_type for event_type, _ in events]
    assert types[0] == "started"
    assert "progress" in types


@pytest.mark.asyncio
async def test_read_intent_cannot_press_the_buy_button(
    site: str, runner: BrowserUseRunner
) -> None:
    spec = _spec(site, Intent.read, f"Open {site} and click the Buy button.")

    try:
        outcome = await runner.run(spec, lambda *_: None, asyncio.Event())
    finally:
        with contextlib.suppress(Exception):
            await runner.close_session(spec.session_id)

    assert "click" in spec.policy.excluded_actions
    assert outcome.status in {TaskStatus.succeeded, TaskStatus.failed}
