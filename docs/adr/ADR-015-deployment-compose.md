# ADR-015 — Docker Compose on a VPS, No Kubernetes

**Status**: Proposed · 2026-09-01

## Context

The system runs roughly ten services (api, worker, browser-worker, mcp-runner, postgres, redis,
minio, caddy, observability). It serves **a single user**, or at most a small private team. The
specifications request an architecture that is "easily deployable on a standard VPS".

## Decision

Docker Compose on a single VPS (4 vCPU / 8–16 GB RAM), fronted by Caddy for automated TLS termination,
isolated Docker networks (`edge` exposed, `internal` without ingress routing), schema migrations
executed as a one-shot container prior to app boot, and offsite encrypted backups with monthly
scripted restoration testing.

## Alternatives

- **Kubernetes (k3s or managed cloud K8s).** Autoscaling, rolling updates, self-healing, native secrets.
  Rejected: for a single-tenant or small private system, orchestrator overhead consumes more operational
  time and system resources than the application itself. Classic case of unnecessary complexity.
- **PaaS (Railway, Fly.io, Render).** Zero infra ops, simple deploys — but higher cost at this scale,
  strict timeouts on long-running processes, heavy container limitations (Playwright with Chromium),
  and vendor lock-in. Remains a viable option for staging environments.
- **Serverless.** Incompatible with multi-minute agent loops, persistent WebSocket gateway connections,
  and warm browser pools.

## Consequences

**Positive** — Predictable cost ($25–50/month); running `docker compose up` accurately replicates
production locally; zero cloud vendor dependencies; reduced attack surface.

**Negative, accepted** — **Single point of failure**: if the VPS host fails, all services go down.
Acceptable for a personal assistant with offsite backups and verified restoration scripts. No
automated horizontal autoscaling (worker concurrency is manually tuned). Deployment is driven via
SSH scripts rather than declarative GitOps operators: must remain idempotent and versioned.

## Migration Path

The architecture is designed to be "K8s-ready": stateless services, 12-factor environment config,
health probes, decoupled database migrations, and contract-based networking. Transitioning to
Kubernetes in the future would simply involve writing manifests without changing application code.
Scaling order if demand grows: Managed PostgreSQL → Managed Redis → browser-worker on dedicated
compute host → autoscaled workers → container orchestrator.
