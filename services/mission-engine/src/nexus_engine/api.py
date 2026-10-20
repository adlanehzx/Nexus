from __future__ import annotations

import asyncio
import contextlib
import threading
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from nexus_engine.acp import AcpError, AcpGateway
from nexus_engine.agent_core import AgentCoreGateway, validated_base_url
from nexus_engine.config import Settings
from nexus_engine.database import Database
from nexus_engine.errors import ConflictError, NotFoundError, ValidationError
from nexus_engine.paper import PaperTradingRepository, RiskPolicy
from nexus_engine.repository import MissionRepository
from nexus_engine.research import ResearchRunRepository, build_research_plan
from nexus_engine.worker import Worker


class MissionOwnerRequest(BaseModel):
    """Identité propriétaire signée, émise par l'API NEXUS.

    Le moteur ne vérifie pas la signature : il n'a pas la clé, et c'est voulu —
    ce qui vérifie ne doit pas pouvoir émettre. Il conserve l'assertion et la
    rejoue au moment d'agir ; c'est l'API qui la refuse si elle est forgée,
    périmée ou hors de sa portée.
    """

    model_config = ConfigDict(extra="forbid")

    user_id: str
    assertion: str


class MissionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    external_key: str
    title: str
    workspace: str
    defaults: dict[str, Any] = Field(default_factory=dict)
    tasks: list[dict[str, Any]]
    owner: MissionOwnerRequest | None = None


class ResearchMissionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    objective: str
    question: str
    close_at: datetime
    workspace: str
    sources: list[str]
    account_id: str
    market_id: str


class PaperAccountRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = "Portefeuille de recherche"
    bankroll_eur: Decimal = Decimal("50.00")


class PaperMarketRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str
    close_at: datetime


class PaperQuoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    yes_price: Decimal
    liquidity_eur: Decimal
    source_url: str
    observed_at: datetime


class PaperOrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_id: str
    market_id: str
    model_probability: Decimal
    confidence: Decimal


class PaperSettlementRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    winning_outcome: str


class AgentRegistrationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    agent_profile_id: str = Field(min_length=1, max_length=128)


class AgentCreationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    name: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
    template_profile_id: str = Field(min_length=1, max_length=128)
    model: str | None = Field(default=None, max_length=200)


class AgentProfileUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$")
    command: str = Field(min_length=1, max_length=4096)
    args: list[str] = Field(default_factory=list, max_length=64)
    model: str | None = Field(default=None, max_length=200)
    system_prompt: str = Field(default="", max_length=32000)
    reasoning_effort: str | None = Field(
        default=None, pattern=r"^(minimal|low|medium|high|xhigh|max|ultra)$"
    )
    additional_dirs: list[str] = Field(default_factory=list, max_length=32)
    config_options: dict[str, str] = Field(default_factory=dict)


class AgentTestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    workspace: str = Field(min_length=1, max_length=4096)
    prompt: str = Field(default="Réponds uniquement NEXUS_ACP_OK", min_length=1, max_length=8000)
    timeout_seconds: int = Field(default=120, ge=10, le=600)


class AgentHealthRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: str = Field(
        pattern=r"^(available|degraded|cooldown|quota_exhausted|auth_required|unknown)$"
    )
    cooldown_until: datetime | None = None
    remaining_5h_percent: int | None = Field(default=None, ge=0, le=100)
    remaining_week_percent: int | None = Field(default=None, ge=0, le=100)
    resets_5h_at: datetime | None = None
    resets_week_at: datetime | None = None
    usage_source: str = Field(default="manual", max_length=64)


class RuntimeSettingsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_timeout_seconds: int = Field(ge=10, le=86400)
    max_attempts: int = Field(ge=1, le=10)
    retry_delay_seconds: int = Field(ge=1, le=3600)
    context_budget_chars: int = Field(ge=4000, le=400000)
    quality_review: bool
    research_priority: list[str] = Field(min_length=1, max_length=20)
    review_priority: list[str] = Field(min_length=1, max_length=20)
    synthesis_priority: list[str] = Field(min_length=1, max_length=20)


def create_app(settings: Settings | None = None) -> FastAPI:
    configured = settings or Settings.from_environment()
    repository = MissionRepository(Database(configured.database_path))
    paper = PaperTradingRepository(repository.db)
    research_runs = ResearchRunRepository(repository.db, paper)
    repository.sync_profiles(configured.load_profiles())
    profile_lock = threading.Lock()
    profile_gateway = (
        AcpGateway(configured.acp_runner, configured.acp_registry)
        if configured.acp_runner is not None and configured.acp_registry is not None
        else None
    )
    # Construite même sans URL : la passerelle sait dire qu'elle n'est pas
    # configurée, et le dire sur une tâche vaut mieux que de laisser le worker
    # découvrir un `None` au moment de l'exécuter.
    agent_core_gateway = AgentCoreGateway(
        validated_base_url(configured.api_base_url),
        timeout_seconds=configured.api_timeout_seconds,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if configured.worker_enabled and profile_gateway is None:
            raise RuntimeError("worker enabled without the NEXUS ACP runtime")
        stop = asyncio.Event()

        async def worker_loop(index: int) -> None:
            assert profile_gateway is not None
            worker = Worker(
                worker_id=f"local-{index}",
                repository=repository,
                gateway=profile_gateway,
                agent_core=agent_core_gateway,
            )
            while not stop.is_set():
                try:
                    worked = await asyncio.to_thread(worker.run_once)
                except Exception:
                    # A worker slot is infrastructure: one unexpected task
                    # failure must not permanently reduce concurrency until the
                    # whole service is restarted. The durable lease will expire
                    # and make the attempt recoverable by a later iteration.
                    worked = False
                if not worked:
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=1.0)
                    except TimeoutError:
                        pass

        async def research_reconciler_loop() -> None:
            while not stop.is_set():
                await asyncio.to_thread(research_runs.process_pending)
                try:
                    await asyncio.wait_for(stop.wait(), timeout=2.0)
                except TimeoutError:
                    pass

        tasks = (
            [
                asyncio.create_task(worker_loop(index))
                for index in range(configured.worker_concurrency)
            ]
            if configured.worker_enabled
            else []
        )
        if configured.worker_enabled:
            tasks.append(asyncio.create_task(research_reconciler_loop()))
        try:
            yield
        finally:
            stop.set()
            for task in tasks:
                task.cancel()
            for task in tasks:
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    app = FastAPI(title="NEXUS Mission Engine", version="0.3.0", lifespan=lifespan)
    app.state.repository = repository
    app.state.paper = paper
    app.state.research_runs = research_runs

    @app.get("/v1/health/live")
    def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/v1/health/ready")
    def ready() -> dict[str, Any]:
        return {
            "status": "ready",
            "worker_enabled": configured.worker_enabled,
            "worker_concurrency": configured.worker_concurrency,
            "profiles": sorted(repository.routable_profiles()),
        }

    @app.get("/v1/profiles")
    def profiles() -> dict[str, list[str]]:
        return {"profiles": sorted(repository.enabled_profiles())}

    @app.get("/v1/settings")
    def runtime_settings() -> dict[str, Any]:
        return configured.load_runtime_settings()

    @app.put("/v1/settings")
    def update_runtime_settings(request: RuntimeSettingsRequest) -> dict[str, Any]:
        values = request.model_dump()
        for field in ("research_priority", "review_priority", "synthesis_priority"):
            values[field] = list(dict.fromkeys(values[field]))
        configured.save_runtime_settings(values)
        return values

    def agent_registry() -> dict[str, Any]:
        if profile_gateway is None:
            raise HTTPException(503, "NEXUS ACP profile discovery is not configured")
        try:
            available = [
                {
                    "id": str(item.get("id", "")),
                    "name": str(item.get("name", "")),
                    "agent_kind": str(item.get("agent_kind", "acp")),
                    "revision": item.get("revision"),
                    "command": str(item.get("command", "")),
                    "args": [str(value) for value in item.get("args", [])],
                    "model": (
                        str(item["model"])
                        if isinstance(item.get("model"), str)
                        else None
                    ),
                    "system_prompt": str(item.get("system_prompt", "")),
                    "reasoning_effort": item.get("reasoning_effort"),
                    "additional_dirs": [str(value) for value in item.get("additional_dirs", [])],
                    "config_options": {
                        str(key): str(value)
                        for key, value in item.get("config_options", {}).items()
                    },
                    "permission_policy": "workspace",
                }
                for item in profile_gateway.agent_profiles()
                if item.get("id") and item.get("name")
            ]
        except Exception as exc:
            raise HTTPException(502, "NEXUS ACP profile discovery failed") from exc
        configured_profiles = repository.profile_activity()
        registered_ids = {
            item["agent_profile_id"]: item["key"] for item in configured_profiles
        }
        for item in available:
            item["registered_as"] = registered_ids.get(item["id"])
        return {
            "worker_enabled": configured.worker_enabled,
            "configured": configured_profiles,
            "available": available,
        }

    @app.get("/v1/agents")
    def agents() -> dict[str, Any]:
        return agent_registry()

    @app.patch("/v1/agents/{profile_key}/health")
    def update_agent_health(
        profile_key: str, request: AgentHealthRequest
    ) -> dict[str, Any]:
        try:
            repository.update_profile_health(
                profile_key,
                status=request.status,
                cooldown_until=(
                    request.cooldown_until.astimezone(UTC).isoformat()
                    if request.cooldown_until is not None
                    else None
                ),
                remaining_5h_percent=request.remaining_5h_percent,
                remaining_week_percent=request.remaining_week_percent,
                resets_5h_at=(
                    request.resets_5h_at.astimezone(UTC).isoformat()
                    if request.resets_5h_at is not None
                    else None
                ),
                resets_week_at=(
                    request.resets_week_at.astimezone(UTC).isoformat()
                    if request.resets_week_at is not None
                    else None
                ),
                usage_source=request.usage_source,
                reset_failures=request.status == "available",
            )
        except NotFoundError as exc:
            raise HTTPException(404, "unknown agent profile") from exc
        return agent_registry()

    @app.post("/v1/agents", status_code=201)
    def register_agent(request: AgentRegistrationRequest) -> dict[str, Any]:
        if profile_gateway is None:
            raise HTTPException(503, "NEXUS ACP profile discovery is not configured")
        with profile_lock:
            profiles = configured.load_profiles()
            if request.key in profiles:
                raise HTTPException(409, "agent key is already registered")
            registry = agent_registry()
            available_ids = {item["id"] for item in registry["available"]}
            if request.agent_profile_id not in available_ids:
                raise HTTPException(422, "unknown NEXUS ACP profile")
            existing_key = next(
                (key for key, value in profiles.items() if value == request.agent_profile_id),
                None,
            )
            if existing_key is not None and existing_key != request.key:
                raise HTTPException(409, "agent profile is already registered")
            if request.key in profiles and profiles[request.key] != request.agent_profile_id:
                raise HTTPException(409, "agent key is already registered")
            profiles[request.key] = request.agent_profile_id
            configured.save_profiles(profiles)
            repository.sync_profiles(profiles)
            return agent_registry()

    @app.post("/v1/agents/create", status_code=201)
    def create_agent(request: AgentCreationRequest) -> dict[str, Any]:
        if profile_gateway is None:
            raise HTTPException(503, "NEXUS ACP profile discovery is not configured")
        with profile_lock:
            profiles = configured.load_profiles()
            if request.key in profiles:
                raise HTTPException(409, "agent key is already registered")
            registry = agent_registry()
            if any(item["name"] == request.name for item in registry["available"]):
                raise HTTPException(409, "NEXUS ACP profile name already exists")
            template = next(
                (
                    item
                    for item in registry["available"]
                    if item["id"] == request.template_profile_id
                ),
                None,
            )
            if template is None or template["agent_kind"] != "acp":
                raise HTTPException(422, "template must be an existing ACP profile")
            try:
                profile_gateway.clone_agent_profile(
                    str(template["id"]), request.key, request.name, request.model
                )
                created = next(
                    (
                        item
                        for item in profile_gateway.agent_profiles()
                        if item.get("id") == request.key
                    ),
                    None,
                )
            except Exception as exc:
                raise HTTPException(502, "NEXUS ACP profile creation failed") from exc
            if created is None:
                raise HTTPException(502, "NEXUS did not return the created ACP profile")
            profiles[request.key] = str(created["id"])
            configured.save_profiles(profiles)
            repository.sync_profiles(profiles)
            return agent_registry()

    @app.put("/v1/agents/profiles/{profile_id}")
    def update_agent_profile(
        profile_id: str, request: AgentProfileUpdateRequest
    ) -> dict[str, Any]:
        if profile_gateway is None:
            raise HTTPException(503, "NEXUS ACP profile discovery is not configured")
        with profile_lock:
            try:
                profile_gateway.update_agent_profile(
                    profile_id,
                    name=request.name,
                    command=request.command,
                    args=request.args,
                    model=request.model,
                    system_prompt=request.system_prompt,
                    reasoning_effort=request.reasoning_effort,
                    additional_dirs=request.additional_dirs,
                    config_options=request.config_options,
                )
            except AcpError as exc:
                if str(exc) == "unknown ACP profile":
                    raise HTTPException(404, "unknown NEXUS ACP profile") from exc
                raise HTTPException(422, str(exc)) from exc
            return agent_registry()

    @app.delete("/v1/agents/{profile_key}")
    def disable_agent(profile_key: str) -> dict[str, Any]:
        with profile_lock:
            profiles = configured.load_profiles()
            if profile_key not in profiles:
                raise HTTPException(404, "unknown registered agent")
            del profiles[profile_key]
            configured.save_profiles(profiles)
            repository.sync_profiles(profiles)
            return agent_registry()

    @app.post("/v1/agents/profiles/{profile_id}/test")
    def test_agent_profile(profile_id: str, request: AgentTestRequest) -> dict[str, Any]:
        if profile_gateway is None:
            raise HTTPException(503, "NEXUS ACP runtime is not configured")
        try:
            response = profile_gateway.execute(
                profile_key=profile_id,
                workspace=request.workspace,
                prompt=request.prompt,
                timeout_seconds=request.timeout_seconds,
                heartbeat=lambda: None,
            )
        except AcpError as exc:
            raise HTTPException(502, f"ACP test failed: {exc.category}") from exc
        return {"ok": True, "response": response[:20_000]}

    @app.post("/v1/missions")
    def submit_mission(
        request: MissionRequest,
        response: Response,
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> dict[str, Any]:
        try:
            mission_id, replayed = repository.submit(
                request.model_dump(), idempotency_key
            )
        except ValidationError as exc:
            raise HTTPException(422, str(exc)) from exc
        except ConflictError as exc:
            raise HTTPException(409, str(exc)) from exc
        response.status_code = 200 if replayed else 201
        return {"mission_id": mission_id, "replayed": replayed}

    @app.get("/v1/missions/{mission_id}")
    def get_mission(mission_id: str) -> dict[str, Any]:
        try:
            return repository.mission(mission_id)
        except NotFoundError as exc:
            raise HTTPException(404, "mission not found") from exc

    @app.get("/v1/missions")
    def list_missions(
        limit: int = 50, external_prefix: str | None = None
    ) -> dict[str, Any]:
        return {"missions": repository.missions(limit, external_prefix)}

    @app.post("/v1/research-missions")
    def submit_research_mission(
        request: ResearchMissionRequest,
        response: Response,
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> dict[str, Any]:
        try:
            values = request.model_dump()
            account_id = values.pop("account_id")
            market_id = values.pop("market_id")
            market = paper.market(market_id)
            if market["question"] != values["question"]:
                raise ValidationError("research question must exactly match the paper market")
            if datetime.fromisoformat(market["close_at"]) != values["close_at"].astimezone(UTC):
                raise ValidationError("research close_at must exactly match the paper market")
            paper.account(account_id)
            plan = build_research_plan(**values)
            mission_id, replayed = repository.submit(plan, idempotency_key)
            run = research_runs.register(
                mission_id, account_id, market_id, values["sources"]
            )
        except ValidationError as exc:
            raise HTTPException(422, str(exc)) from exc
        except ConflictError as exc:
            raise HTTPException(409, str(exc)) from exc
        except NotFoundError as exc:
            raise HTTPException(404, "paper account or market not found") from exc
        response.status_code = 200 if replayed else 201
        return {"mission_id": mission_id, "research_run_id": run["id"], "replayed": replayed, "mode": "paper_only"}

    @app.get("/v1/research-runs/{run_id}")
    def get_research_run(run_id: str) -> dict[str, Any]:
        try:
            return research_runs.get(run_id)
        except NotFoundError as exc:
            raise HTTPException(404, "research run not found") from exc

    @app.get("/v1/research-runs")
    def list_research_runs(limit: int = 50) -> dict[str, Any]:
        return {"runs": research_runs.list(limit)}

    @app.post("/v1/paper/accounts", status_code=201)
    def create_paper_account(request: PaperAccountRequest) -> dict[str, Any]:
        try:
            return paper.create_account(request.name, request.bankroll_eur, RiskPolicy())
        except ValidationError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/v1/paper/accounts/{account_id}")
    def get_paper_account(account_id: str) -> dict[str, Any]:
        try:
            return paper.account(account_id)
        except NotFoundError as exc:
            raise HTTPException(404, "paper account not found") from exc

    @app.get("/v1/paper/accounts")
    def list_paper_accounts(limit: int = 50) -> dict[str, Any]:
        return {"accounts": paper.accounts(limit)}

    @app.post("/v1/paper/markets", status_code=201)
    def create_paper_market(request: PaperMarketRequest) -> dict[str, Any]:
        try:
            return paper.create_market(request.question, request.close_at)
        except ValidationError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/v1/paper/markets/{market_id}")
    def get_paper_market(market_id: str) -> dict[str, Any]:
        try:
            return paper.market(market_id)
        except NotFoundError as exc:
            raise HTTPException(404, "paper market not found") from exc

    @app.get("/v1/paper/markets")
    def list_paper_markets(limit: int = 50) -> dict[str, Any]:
        return {"markets": paper.markets(limit)}

    @app.post("/v1/paper/markets/{market_id}/quotes", status_code=201)
    def add_paper_quote(market_id: str, request: PaperQuoteRequest) -> dict[str, Any]:
        try:
            return paper.add_quote(market_id, **request.model_dump())
        except ValidationError as exc:
            raise HTTPException(422, str(exc)) from exc
        except NotFoundError as exc:
            raise HTTPException(404, "paper market not found") from exc
        except ConflictError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/v1/paper/orders")
    def place_paper_order(
        request: PaperOrderRequest,
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> dict[str, Any]:
        try:
            return paper.place_order(**request.model_dump(), idempotency_key=idempotency_key)
        except ValidationError as exc:
            raise HTTPException(422, str(exc)) from exc
        except NotFoundError as exc:
            raise HTTPException(404, "paper account or market not found") from exc
        except ConflictError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/v1/paper/markets/{market_id}/settle")
    def settle_paper_market(market_id: str, request: PaperSettlementRequest) -> dict[str, Any]:
        try:
            return paper.settle_market(market_id, request.winning_outcome)
        except ValidationError as exc:
            raise HTTPException(422, str(exc)) from exc
        except NotFoundError as exc:
            raise HTTPException(404, "paper market not found") from exc
        except ConflictError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.get("/v1/paper/audit/verify")
    def verify_paper_audit() -> dict[str, Any]:
        return paper.verify_audit_chain()

    return app


app = create_app()


def main() -> None:
    uvicorn.run("nexus_engine.api:app", host="127.0.0.1", port=18100)
