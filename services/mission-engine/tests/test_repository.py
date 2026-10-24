from __future__ import annotations

import json
from dataclasses import replace

import pytest

from nexus_engine.database import Database
from nexus_engine.errors import ConflictError, LeaseLostError
from nexus_engine.repository import MissionRepository


def test_profile_sync_disables_entries_removed_from_configuration(tmp_path) -> None:
    repository = MissionRepository(Database(tmp_path / "profiles.db"))
    repository.register_profile("claude", "profile-claude")
    repository.sync_profiles({"codex": "profile-codex"})

    assert repository.enabled_profiles() == {"codex"}


@pytest.fixture
def repository(tmp_path) -> MissionRepository:
    result = MissionRepository(Database(tmp_path / "state.db"))
    result.register_profile("codex", "codex-profile-id")
    result.register_profile("claude", "claude-profile-id")
    return result


def spec() -> dict:
    return {
        "external_key": "mission-demo",
        "title": "Mission demo",
        "workspace": "/tmp/workspace",
        "defaults": {"profile": "codex", "max_attempts": 2},
        "tasks": [
            {"key": "produce", "instruction": "Produce", "depends_on": []},
            {
                "key": "review",
                "profile": "claude",
                "instruction": "Review",
                "depends_on": ["produce"],
            },
        ],
    }


def test_submission_is_idempotent(repository: MissionRepository) -> None:
    first, replayed = repository.submit(spec(), "request-1")
    second, replayed_again = repository.submit(spec(), "request-1")
    assert first == second
    assert replayed is False
    assert replayed_again is True


def test_recent_missions_include_dependencies_and_attempts(repository: MissionRepository) -> None:
    mission_id, _ = repository.submit(spec(), "observable-request")
    lease = repository.acquire("worker-a")
    assert lease is not None

    visible = repository.missions(10, "mission-")

    assert [mission["id"] for mission in visible] == [mission_id]
    assert visible[0]["tasks"][1]["depends_on"] == ["produce"]
    assert visible[0]["tasks"][0]["attempts"][0]["conversation_id"] == lease.conversation_id
    assert repository.missions(10, "another-owner-") == []


def test_idempotency_conflict(repository: MissionRepository) -> None:
    repository.submit(spec(), "request-1")
    changed = spec()
    changed["title"] = "Different"
    with pytest.raises(ConflictError):
        repository.submit(changed, "request-1")


def test_secondary_idempotency_key_is_bound(repository: MissionRepository) -> None:
    first, _ = repository.submit(spec(), "request-1")
    second, replayed = repository.submit(spec(), "request-2")
    assert (second, replayed) == (first, True)
    changed = spec()
    changed["title"] = "Different"
    with pytest.raises(ConflictError):
        repository.submit(changed, "request-2")


def test_dependency_unlocks_after_success(repository: MissionRepository) -> None:
    mission_id, _ = repository.submit(spec(), "request-1")
    first = repository.acquire("worker-a")
    assert first is not None and first.task_key == "produce"
    repository.mark_running(first)
    repository.succeed(first, "done")
    second = repository.acquire("worker-b")
    assert second is not None and second.task_key == "review"
    assert second.agent_profile_id == "claude-profile-id"
    assert "<DEPENDENCY_RESULTS>" in second.instruction
    assert '"task_key":"produce"' in second.instruction
    assert '"response":"done"' in second.instruction
    assert repository.mission(mission_id)["state"] == "running"


def test_fencing_token_blocks_stale_worker(repository: MissionRepository) -> None:
    repository.submit(spec(), "request-1")
    lease = repository.acquire("worker-a")
    assert lease is not None
    stale = replace(lease, lease_token="wrong")
    with pytest.raises(LeaseLostError):
        repository.succeed(stale, "must not commit")


def test_fencing_checks_bound_task_and_mission(repository: MissionRepository) -> None:
    repository.submit(spec(), "request-1")
    lease = repository.acquire("worker-a")
    assert lease is not None
    inconsistent = replace(lease, task_id="another-task")
    with pytest.raises(LeaseLostError):
        repository.succeed(inconsistent, "must not commit")


def test_deterministic_conversation_id_is_persisted(repository: MissionRepository) -> None:
    repository.submit(spec(), "request-1")
    lease = repository.acquire("worker-a")
    assert lease is not None
    assert len(lease.conversation_id) == 36
    with repository.db.connect() as connection:
        stored = connection.execute(
            "SELECT conversation_id FROM attempts WHERE id=?", (lease.attempt_id,)
        ).fetchone()[0]
    assert stored == lease.conversation_id


def test_profile_is_snapshotted_when_plan_is_submitted(
    repository: MissionRepository,
) -> None:
    repository.submit(spec(), "request-1")
    repository.register_profile("codex", "new-codex-profile")
    lease = repository.acquire("worker-a")
    assert lease is not None
    assert lease.agent_profile_id == "codex-profile-id"


def test_expired_lease_is_reclaimed(repository: MissionRepository) -> None:
    repository.submit(spec(), "request-1")
    first = repository.acquire("worker-a", lease_seconds=30)
    assert first is not None
    with repository.db.transaction(immediate=True) as connection:
        connection.execute(
            "UPDATE attempts SET lease_expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (first.attempt_id,),
        )
    reclaimed = repository.acquire("worker-b")
    assert reclaimed is not None
    assert reclaimed.attempt_id == first.attempt_id
    assert reclaimed.conversation_id == first.conversation_id
    assert reclaimed.lease_owner == "worker-b"


def test_failure_fails_over_to_next_profile(repository: MissionRepository) -> None:
    plan = spec()
    plan["tasks"][0]["fallback_profiles"] = ["claude"]
    mission_id, _ = repository.submit(plan, "failover-request")

    first = repository.acquire("worker-a")
    assert first is not None and first.profile_key == "codex"
    repository.fail(first, "worker_error_rate_limited")

    with repository.db.transaction(immediate=True) as connection:
        connection.execute(
            "UPDATE tasks SET next_attempt_at='2000-01-01T00:00:00+00:00' WHERE id=?",
            (first.task_id,),
        )
    second = repository.acquire("worker-b")
    assert second is not None
    assert second.profile_key == "claude"
    assert second.agent_profile_id == "claude-profile-id"
    repository.succeed(second, "recovered")
    recovered = repository.mission(mission_id)["tasks"][0]
    assert recovered["state"] == "succeeded"
    assert recovered["error_json"] is None
    assert repository.mission(mission_id)["state"] == "running"


def test_quota_exhausted_profile_is_not_routable(repository: MissionRepository) -> None:
    repository.update_profile_health(
        "codex",
        status="quota_exhausted",
        remaining_5h_percent=0,
        remaining_week_percent=40,
        usage_source="provider",
    )
    assert repository.routable_profiles() == {"claude"}
    activity = {item["key"]: item for item in repository.profile_activity()}
    assert activity["codex"]["status"] == "quota_exhausted"
    assert activity["codex"]["remaining_5h_percent"] == 0


def test_router_skips_exhausted_primary_before_first_attempt(
    repository: MissionRepository,
) -> None:
    repository.update_profile_health(
        "codex", status="quota_exhausted", remaining_5h_percent=0
    )
    plan = spec()
    plan["tasks"][0]["fallback_profiles"] = ["claude"]
    repository.submit(plan, "preflight-routing")

    lease = repository.acquire("worker-a")
    assert lease is not None
    assert lease.profile_key == "claude"
    snapshot = repository.mission(lease.mission_id)["tasks"][0]
    decision = snapshot["routing_decisions"][0]
    assert decision["selected_profile"] == "claude"
    assert decision["reason"] == "selected_fallback"
    assert json.loads(decision["observations_json"]) == [
        {"profile": "codex", "status": "quota_exhausted"},
        {"profile": "claude", "status": "unknown"},
    ]


def test_unknown_quota_is_preserved_and_does_not_mean_unlimited(
    repository: MissionRepository,
) -> None:
    repository.submit(spec(), "unknown-quota")
    lease = repository.acquire("worker-a")
    assert lease is not None

    activity = {item["key"]: item for item in repository.profile_activity()}
    assert activity["codex"]["status"] == "unknown"
    assert activity["codex"]["remaining_5h_percent"] is None
    assert activity["codex"]["remaining_week_percent"] is None
    decision = repository.mission(lease.mission_id)["tasks"][0]["routing_decisions"][0]
    assert json.loads(decision["observations_json"]) == [
        {"profile": "codex", "status": "unknown"}
    ]


def test_router_scores_quality_latency_cost_context_privacy_and_unknown_quota(
    repository: MissionRepository,
) -> None:
    repository.update_profile_health(
        "codex",
        status="available",
        quality_score=95,
        latency_ms=5_000,
        cost_per_million_microunits=40_000_000,
        max_context_tokens=128_000,
        privacy_level="external_cloud",
    )
    repository.update_profile_health(
        "claude",
        status="available",
        quality_score=82,
        latency_ms=100,
        cost_per_million_microunits=0,
        max_context_tokens=32_000,
        privacy_level="local_only",
    )
    plan = spec()
    plan["tasks"][0]["fallback_profiles"] = ["claude"]
    repository.submit(plan, "multi-factor-routing")

    lease = repository.acquire("worker-a")
    assert lease is not None and lease.profile_key == "claude"
    decision = repository.mission(lease.mission_id)["tasks"][0]["routing_decisions"][0]
    assert decision["reason"] == "selected_fallback"
    observations = json.loads(decision["observations_json"])
    assert observations[0]["quota"] == "unknown"
    assert observations[1]["quota"] == "unknown"
    assert observations[1]["score"] > observations[0]["score"]


def test_dependency_context_is_compacted_to_task_budget(repository: MissionRepository) -> None:
    plan = spec()
    plan["tasks"][1]["context_budget_chars"] = 4_000
    repository.submit(plan, "compact-context")
    first = repository.acquire("worker-a")
    assert first is not None
    repository.succeed(first, "x" * 20_000)

    second = repository.acquire("worker-b")
    assert second is not None
    assert len(second.instruction) <= 4_000
    assert "context compacted by NEXUS" in second.instruction


def quality_gate_spec() -> dict:
    return {
        "external_key": "quality-gate-demo",
        "title": "Quality gate demo",
        "workspace": "/tmp/workspace",
        "defaults": {"profile": "codex", "max_attempts": 2},
        "tasks": [
            {"key": "produce", "instruction": "Produce", "depends_on": []},
            {
                "key": "nexus_quality_review_1",
                "profile": "claude",
                "fallback_profiles": ["codex"],
                "instruction": "Review",
                "depends_on": ["produce"],
            },
            {
                "key": "nexus_final_synthesis",
                "profile": "claude",
                "instruction": "Synthesize",
                "depends_on": ["produce", "nexus_quality_review_1"],
            },
        ],
    }


def test_quality_review_durably_replans_then_allows_final(
    repository: MissionRepository,
) -> None:
    mission_id, _ = repository.submit(quality_gate_spec(), "quality-replan")
    produce = repository.acquire("worker")
    assert produce is not None and produce.task_key == "produce"
    repository.succeed(produce, "draft")

    review = repository.acquire("worker")
    assert review is not None and review.task_key == "nexus_quality_review_1"
    repository.succeed(
        review,
        '{"verdict":"revise","summary":"missing evidence",'
        '"corrective_instruction":"add verifiable evidence"}',
    )
    snapshot = repository.mission(mission_id)
    states = {task["task_key"]: task["state"] for task in snapshot["tasks"]}
    assert states["nexus_correction_1"] == "ready"
    assert states["nexus_quality_review_2"] == "blocked"
    assert states["nexus_final_synthesis"] == "blocked"

    correction = repository.acquire("worker")
    assert correction is not None and correction.task_key == "nexus_correction_1"
    assert correction.profile_key == "codex"
    assert "missing evidence" in correction.instruction
    repository.succeed(correction, "corrected draft with evidence")

    review_two = repository.acquire("worker")
    assert review_two is not None and review_two.task_key == "nexus_quality_review_2"
    repository.succeed(
        review_two,
        '{"verdict":"pass","summary":"validation succeeded",'
        '"corrective_instruction":""}',
    )
    final = repository.acquire("worker")
    assert final is not None and final.task_key == "nexus_final_synthesis"
    assert "nexus_quality_review_2" in final.instruction


def test_invalid_quality_review_cannot_expand_task_graph(
    repository: MissionRepository,
) -> None:
    mission_id, _ = repository.submit(quality_gate_spec(), "invalid-quality-review")
    produce = repository.acquire("worker")
    assert produce is not None
    repository.succeed(produce, "draft")
    review = repository.acquire("worker")
    assert review is not None
    repository.succeed(review, "not valid JSON")

    snapshot = repository.mission(mission_id)
    assert len(snapshot["tasks"]) == 3
    final = repository.acquire("worker")
    assert final is not None and final.task_key == "nexus_final_synthesis"
