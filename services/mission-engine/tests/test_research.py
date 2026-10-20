from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from nexus_engine.errors import ValidationError
from nexus_engine.database import Database
from nexus_engine.paper import PaperTradingRepository, RiskPolicy
from nexus_engine.repository import MissionRepository
from nexus_engine.research import ResearchRunRepository, build_research_plan


def values() -> dict:
    return {
        "objective": "Estimate the outcome using only dated evidence",
        "question": "Will the synthetic event occur?",
        "close_at": datetime.now(UTC) + timedelta(days=3),
        "workspace": "/tmp/research",
        "sources": ["https://example.org/official-feed"],
    }


def test_research_plan_uses_all_three_agents_and_never_trades() -> None:
    plan = build_research_plan(**values())
    assert [task["profile"] for task in plan["tasks"]] == [
        "antigravity", "claude", "codex", "claude", "codex"
    ]
    assert plan["tasks"][-1]["depends_on"] == ["forecast", "red_team"]
    assert all("aucun ordre réel" in task["instruction"] for task in plan["tasks"])


@pytest.mark.parametrize(
    "source",
    ["http://example.org/feed", "https://user:pass@example.org/feed", "file:///etc/passwd"],
)
def test_research_plan_rejects_unsafe_source_urls(source: str) -> None:
    payload = values()
    payload["sources"] = [source]
    with pytest.raises(ValidationError):
        build_research_plan(**payload)


def test_completed_multi_agent_research_executes_paper_order(tmp_path) -> None:
    database = Database(tmp_path / "automated.db")
    missions = MissionRepository(database)
    for profile in ("antigravity", "claude", "codex"):
        missions.register_profile(profile, f"profile-{profile}")
    paper = PaperTradingRepository(database)
    runs = ResearchRunRepository(database, paper)
    account = paper.create_account("Safe 50", Decimal("50.00"), RiskPolicy())
    market = paper.create_market(values()["question"], datetime.now(UTC) + timedelta(days=3))
    paper.add_quote(
        market["id"], Decimal("0.50"), Decimal("100"),
        "https://example.org/quote", datetime.now(UTC),
    )
    mission_id, _ = missions.submit(build_research_plan(**values()), "research-auto")
    run = runs.register(
        mission_id, account["id"], market["id"], values()["sources"]
    )
    assert runs.list()[0]["id"] == run["id"]
    responses = [
        "collected", "verified", "forecast", "red team",
        '{"question":"Will the synthetic event occur?","as_of":"now",'
        '"probability":0.9,"confidence":0.9,'
        '"evidence_urls":["https://example.org/official-feed"],"counterarguments":[],'
        '"abstain":false,"abstain_reason":""}',
    ]
    for response in responses:
        lease = missions.acquire("test-worker")
        assert lease is not None
        missions.mark_running(lease)
        missions.succeed(lease, response)
    assert runs.process_pending() == 1
    stored = runs.get(run["id"])
    assert stored["state"] == "executed"
    assert paper.account(account["id"])["cash_balance_cents"] == 4900


def test_research_rejects_final_evidence_outside_allowlist(tmp_path) -> None:
    database = Database(tmp_path / "provenance.db")
    missions = MissionRepository(database)
    for profile in ("antigravity", "claude", "codex"):
        missions.register_profile(profile, f"profile-{profile}")
    paper = PaperTradingRepository(database)
    runs = ResearchRunRepository(database, paper)
    account = paper.create_account("Safe 50", Decimal("50.00"), RiskPolicy())
    market = paper.create_market(values()["question"], datetime.now(UTC) + timedelta(days=3))
    mission_id, _ = missions.submit(build_research_plan(**values()), "research-bad-source")
    run = runs.register(mission_id, account["id"], market["id"], values()["sources"])
    responses = ["a", "b", "c", "d", (
        '{"probability":0.9,"confidence":0.9,"abstain":false,'
        '"evidence_urls":["https://unapproved.example/news"]}'
    )]
    for response in responses:
        lease = missions.acquire("test-worker")
        assert lease is not None
        missions.mark_running(lease)
        missions.succeed(lease, response)
    runs.process_pending()
    stored = runs.get(run["id"])
    assert stored["state"] == "failed"
    assert stored["error_code"] == "unauthorized_evidence_source"
    assert paper.account(account["id"])["cash_balance_cents"] == 5000
