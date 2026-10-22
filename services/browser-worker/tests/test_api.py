"""API: authentication, sessions, tasks, events, cancellation."""

from __future__ import annotations

import time

from fastapi.testclient import TestClient

from app.models import TaskStatus
from app.runner import RunOutcome
from tests.conftest import TOKEN, FakeRunner, open_session, run_and_wait


class TestAuthentication:
    def test_rejects_missing_token(self, client: TestClient) -> None:
        response = client.post("/v1/sessions", json={"ownerId": "u"}, headers={"authorization": ""})
        assert response.status_code == 401

    def test_rejects_wrong_token(self, client: TestClient) -> None:
        response = client.post(
            "/v1/sessions",
            json={"ownerId": "u"},
            headers={"authorization": "Bearer bad-token-sufficiently-long"},
        )
        assert response.status_code == 401

    def test_health_stays_reachable_without_token(self, client: TestClient) -> None:
        response = client.get("/v1/health", headers={"authorization": ""})
        assert response.status_code == 200
        assert response.json()["protocolVersion"] == 1

    def test_accepts_valid_token(self, client: TestClient) -> None:
        response = client.post(
            "/v1/sessions",
            json={"ownerId": "u"},
            headers={"authorization": f"Bearer {TOKEN}"},
        )
        assert response.status_code == 200


class TestSessionLifecycle:
    def test_creates_and_reads_session(self, client: TestClient) -> None:
        session_id = open_session(client)
        session = client.get(f"/v1/sessions/{session_id}").json()

        assert session["status"] == "open"
        assert session["ownerId"] == "user-1"
        assert session["expiresAt"] > session["createdAt"]

    def test_closes_session_and_releases_browser(
        self, client: TestClient, runner: FakeRunner
    ) -> None:
        session_id = open_session(client)
        assert client.delete(f"/v1/sessions/{session_id}").status_code == 204

        assert session_id in runner.closed
        assert client.get(f"/v1/sessions/{session_id}").status_code == 404

    def test_enforces_session_limit(self, client: TestClient) -> None:
        for _ in range(3):
            open_session(client)
        response = client.post("/v1/sessions", json={"ownerId": "user-1"})

        assert response.status_code == 429
        assert response.json()["error"]["code"] == "BROWSER_SESSION_BUSY"

    def test_expires_session_after_ttl(self, client: TestClient) -> None:
        session_id = open_session(client, ttlSeconds=1)
        time.sleep(1.1)
        assert client.get(f"/v1/sessions/{session_id}").status_code == 404

    def test_unknown_session_is_404(self, client: TestClient) -> None:
        response = client.get("/v1/sessions/bs_nonexistent")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "BROWSER_SESSION_NOT_FOUND"


class TestTaskExecution:
    def test_runs_a_read_task_and_returns_result(self, client: TestClient) -> None:
        session_id = open_session(client)
        task = run_and_wait(client, session_id)

        assert task["status"] == "succeeded"
        assert task["output"] == "42 dollars"
        assert task["durationMs"] >= 0

    def test_emits_the_full_event_sequence(self, client: TestClient) -> None:
        session_id = open_session(client)
        task = run_and_wait(client, session_id)

        types = [event["type"] for event in task["events"]]
        assert types[0] == "started"
        assert "navigation" in types
        assert "progress" in types
        assert "action" in types
        assert types[-1] == "finished"

        seqs = [event["seq"] for event in task["events"]]
        assert seqs == sorted(seqs)
        assert len(set(seqs)) == len(seqs)

    def test_since_returns_only_new_events(self, client: TestClient) -> None:
        session_id = open_session(client)
        task = run_and_wait(client, session_id)
        cutoff = task["events"][1]["seq"]

        later = client.get(f"/v1/tasks/{task['taskId']}?since={cutoff}").json()
        assert all(event["seq"] > cutoff for event in later["events"])

    def test_passes_intent_through_to_the_runner(
        self, client: TestClient, runner: FakeRunner
    ) -> None:
        session_id = open_session(client)
        run_and_wait(client, session_id, intent="purchase", taskId="t-purchase")

        spec = runner.calls[-1]
        assert spec.intent.value == "purchase"
        assert "write_file" in spec.policy.excluded_actions

    def test_read_intent_removes_mutating_actions(
        self, client: TestClient, runner: FakeRunner
    ) -> None:
        session_id = open_session(client)
        run_and_wait(client, session_id, intent="read")

        excluded = runner.calls[-1].policy.excluded_actions
        assert "click" in excluded
        assert "input" in excluded
        assert "evaluate" in excluded

    def test_rejects_second_task_in_same_session(
        self, client: TestClient, runner: FakeRunner
    ) -> None:
        runner.wait_for_cancel = True
        session_id = open_session(client)
        client.post(
            f"/v1/sessions/{session_id}/tasks",
            json={
                "taskId": "t1",
                "sessionId": session_id,
                "instructions": "long task",
                "intent": "read",
            },
        )
        response = client.post(
            f"/v1/sessions/{session_id}/tasks",
            json={
                "taskId": "t2",
                "sessionId": session_id,
                "instructions": "other",
                "intent": "read",
            },
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "BROWSER_SESSION_BUSY"
        client.post("/v1/tasks/t1/cancel")

    def test_is_idempotent_on_task_id(self, client: TestClient, runner: FakeRunner) -> None:
        session_id = open_session(client)
        run_and_wait(client, session_id, taskId="t-idem")
        before = len(runner.calls)

        response = client.post(
            f"/v1/sessions/{session_id}/tasks",
            json={
                "taskId": "t-idem",
                "sessionId": session_id,
                "instructions": "repeat",
                "intent": "read",
            },
        )
        assert response.status_code == 200
        assert len(runner.calls) == before

    def test_rejects_mismatched_session_id(self, client: TestClient) -> None:
        session_id = open_session(client)
        response = client.post(
            f"/v1/sessions/{session_id}/tasks",
            json={
                "taskId": "t",
                "sessionId": "bs_other",
                "instructions": "x",
                "intent": "read",
            },
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "BROWSER_INVALID_REQUEST"

    def test_rejects_unknown_intent(self, client: TestClient) -> None:
        session_id = open_session(client)
        response = client.post(
            f"/v1/sessions/{session_id}/tasks",
            json={
                "taskId": "t",
                "sessionId": session_id,
                "instructions": "x",
                "intent": "delete_everything",
            },
        )
        assert response.status_code == 422


class TestFailures:
    def test_runner_crash_becomes_a_failed_task(
        self, client: TestClient, runner: FakeRunner
    ) -> None:
        runner.raise_error = RuntimeError("chromium crashed")
        session_id = open_session(client)
        task = run_and_wait(client, session_id)

        assert task["status"] == "failed"
        assert task["error"]["retryable"] is True
        assert "chromium" in task["error"]["message"]

    def test_timeout_is_reported_as_such(self, client: TestClient, runner: FakeRunner) -> None:
        runner.outcome = RunOutcome(
            status=TaskStatus.timeout,
            steps=3,
            error_code="BROWSER_TASK_TIMEOUT",
            error_message="Task exceeded 180s timeout.",
            retryable=True,
        )
        session_id = open_session(client)
        task = run_and_wait(client, session_id)

        assert task["status"] == "timeout"
        assert task["error"]["code"] == "BROWSER_TASK_TIMEOUT"

    def test_unknown_task_is_404(self, client: TestClient) -> None:
        assert client.get("/v1/tasks/nonexistent").status_code == 404


class TestHumanIntervention:
    def test_captcha_stops_the_task_instead_of_being_solved(
        self, client: TestClient, runner: FakeRunner
    ) -> None:
        runner.outcome = RunOutcome(
            status=TaskStatus.needs_human,
            output="The site displays a CAPTCHA challenge.",
            steps=2,
            error_code="BROWSER_HUMAN_INTERVENTION_REQUIRED",
            error_message="The site requires human verification.",
        )
        session_id = open_session(client)
        task = run_and_wait(client, session_id, intent="login")

        assert task["status"] == "needs_human"
        assert task["error"]["code"] == "BROWSER_HUMAN_INTERVENTION_REQUIRED"


class TestCancellation:
    def test_cancels_a_running_task(self, client: TestClient, runner: FakeRunner) -> None:
        runner.wait_for_cancel = True
        session_id = open_session(client)

        client.post(
            f"/v1/sessions/{session_id}/tasks",
            json={
                "taskId": "t-cancelled",
                "sessionId": session_id,
                "instructions": "long task",
                "intent": "read",
            },
        )
        cancelled = client.post("/v1/tasks/t-cancelled/cancel").json()

        assert cancelled["status"] == "cancelled"

    def test_cancelling_a_finished_task_is_harmless(self, client: TestClient) -> None:
        session_id = open_session(client)
        task = run_and_wait(client, session_id)

        again = client.post(f"/v1/tasks/{task['taskId']}/cancel").json()
        assert again["status"] == "succeeded"

    def test_closing_a_session_cancels_its_task(
        self, client: TestClient, runner: FakeRunner
    ) -> None:
        runner.wait_for_cancel = True
        session_id = open_session(client)
        client.post(
            f"/v1/sessions/{session_id}/tasks",
            json={
                "taskId": "t-session",
                "sessionId": session_id,
                "instructions": "long task",
                "intent": "read",
            },
        )

        assert client.delete(f"/v1/sessions/{session_id}").status_code == 204
        assert client.get("/v1/tasks/t-session").json()["status"] == "cancelled"


class TestSecrets:
    def test_secrets_never_come_back_in_the_response(
        self, client: TestClient, runner: FakeRunner
    ) -> None:
        runner.outcome = RunOutcome(
            status=TaskStatus.succeeded,
            output="Logged in with super-secret-password",
            steps=1,
        )
        session_id = open_session(client)
        task = run_and_wait(
            client,
            session_id,
            intent="login",
            secrets={"password": "super-secret-password"},
        )

        assert "super-secret-password" not in str(task)
        assert "[REDACTED]" in task["output"]

    def test_secrets_reach_the_runner_but_not_the_events(
        self, client: TestClient, runner: FakeRunner
    ) -> None:
        session_id = open_session(client)
        task = run_and_wait(
            client, session_id, intent="login", secrets={"password": "hunter2-long-secret"}
        )

        assert runner.calls[-1].secrets == {"password": "hunter2-long-secret"}
        assert "hunter2-long-secret" not in str(task["events"])


def test_shutdown_closes_everything(runner: FakeRunner, settings) -> None:
    from app.main import create_app

    app = create_app(runner=runner, settings=settings)
    with TestClient(app) as client:
        client.headers.update({"authorization": f"Bearer {TOKEN}"})
        session_id = open_session(client)

    assert session_id in runner.closed
