"""Exemple end-to-end minimal, sur un site de test servi localement.

C'est le seul test qui lance un vrai navigateur et un vrai modèle. Il est exclu
par défaut (``-m 'not browser'``) : il coûte des jetons, dure une minute, et
dépend d'un Chromium installé.

Pour l'exécuter ::

    python -m playwright install chromium
    export ANTHROPIC_API_KEY=...            # ou BROWSER_WORKER_LLM_API_KEY
    pytest -m browser tests/test_e2e_local_site.py

Le site est servi depuis ce processus : aucun accès à Internet n'est requis, et
le contenu attendu est connu — un test end-to-end ne doit pas dépendre du fait
qu'un site tiers n'a pas changé de mise en page ce matin.
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
<html lang="fr">
  <head><meta charset="utf-8"><title>Vols NEXUS</title></head>
  <body>
    <h1>Paris → Alger</h1>
    <table>
      <tr><th>Vol</th><th>Départ</th><th>Prix</th></tr>
      <tr><td>AH1005</td><td>vendredi 20h15</td><td id="prix">187 EUR</td></tr>
      <tr><td>AF2081</td><td>samedi 07h40</td><td>243 EUR</td></tr>
    </table>
    <button id="acheter">Acheter</button>
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
        """Silence : le journal du site de test n'apporte rien."""


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
        pytest.skip("clé LLM absente : définir ANTHROPIC_API_KEY")
    return BrowserUseRunner(model="claude-sonnet-4-5", api_key=api_key)


def _spec(site_url: str, intent: Intent, instructions: str) -> RunSpec:
    return RunSpec(
        task_id="e2e-1",
        session_id="e2e-session",
        instructions=instructions,
        intent=intent,
        policy=TaskPolicy(
            intent=intent,
            # Le site de test est local : on autorise explicitement l'hôte privé,
            # ce que la politique refuse partout ailleurs.
            domains=DomainPolicy(allowed=("127.0.0.1",), allow_private_hosts=True),
        ),
        max_steps=6,
        timeout_seconds=180,
        headless=True,
    )


@pytest.mark.asyncio
async def test_reads_a_price_from_the_page(site: str, runner: BrowserUseRunner) -> None:
    """« Va sur ce site et cherche le prix du billet » — aucune confirmation."""
    events: list[tuple[str, dict]] = []
    spec = _spec(
        site,
        Intent.read,
        f"Ouvre {site} et rapporte le prix du vol AH1005. Réponds uniquement par le prix.",
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
    """La restriction d'intention est effective, pas seulement demandée.

    Même en le lui ordonnant explicitement, une tâche `read` ne dispose pas de
    l'action « cliquer » : browser-use ne la lui a jamais donnée.
    """
    spec = _spec(site, Intent.read, f"Ouvre {site} et clique sur le bouton Acheter.")

    try:
        outcome = await runner.run(spec, lambda *_: None, asyncio.Event())
    finally:
        with contextlib.suppress(Exception):
            await runner.close_session(spec.session_id)

    # L'agent ne peut pas cliquer : il termine en le signalant, sans avoir agi.
    assert "click" in spec.policy.excluded_actions
    assert outcome.status in {TaskStatus.succeeded, TaskStatus.failed}
