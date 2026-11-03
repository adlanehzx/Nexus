# ADR-017 — The Execution Boundary Between the Container and the Host

**Status**: Accepted · 2026-11-02

## Context

The API ships as a container with `ReadonlyRootfs=true` and `network_mode: host`. Two
consequences of that shape were never written down, and both produced defects that looked
like application bugs.

**Agent CLIs live on the host, not in the image.** ACP agents are other people's binaries —
`agy`, `claude`, `codex` — authenticated against the operator's own subscriptions, in the
operator's home directory. `docker exec nexus-api command -v agy` finds nothing, and that is
correct: baking third-party CLIs and their sessions into an image would mean copying
credentials into a build artifact.

**A read-only image has no writable working directory.** `AcpOrchestrator` resolved its
workspace root as `resolve(process.cwd(), ".nexus-workspaces")`. From a checkout that is the
repository root and it works; from `/app` in the image it fails with `ENOENT`, surfaced as
`INTERNAL_ERROR`. Every mission submitted through `POST /orchestrator/messages` returned a 500
with nothing in it to act on. A QA campaign attributed the failure to the LLM provider instead,
because the symptom was indistinguishable from a missing engine.

## Decision

**The Mission Engine runs on the host, under a systemd user unit, and is deliberately not a
Compose service.** It is the component that spawns ACP agent CLIs, so it must sit where those
CLIs and their sessions are. Containerising it would break ACP for the same reason the API
cannot call `agy`. `network_mode: host` is what lets the API reach it at
`127.0.0.1:18100` without publishing anything.

**Anything the API writes at runtime goes to a declared mount, never to a path derived from
the working directory.** Mission workspaces follow `NEXUS_RUNTIME_CONFIG_DIR` and its siblings:
`NEXUS_ACP_WORKSPACE_DIR`.

**Mission workspaces are a 1:1 bind mount, not a named volume.** This is the one mount that
cannot be container-local. The Mission Engine runs on the host and spawns each agent with the
workspace as its working directory (`mission-engine/src/nexus_engine/acp.py`, `cwd=workspace`),
so the path the API writes must be the same absolute path the host can enter. A named volume
satisfies the API and silently breaks every agent: the mission is accepted, planned, and then
fails at execution with nothing pointing at the cause. The host directory must exist and be
owned by uid 1000 before first start.

**And it must not live under `/tmp`.** The Mission Engine unit sets `PrivateTmp=true`, so the
engine sees its own `/tmp` namespace: a workspace there exists for the API and not for the
engine, and `subprocess.Popen` fails with `FileNotFoundError` because its `cwd` is absent. The
symptom is a mission that plans correctly, then fails instantly on every profile and fallback
with `worker_error_FileNotFoundError` — which names neither the path nor the namespace.

**A missing writable precondition is an operational error, not an internal one.** Failing to
create a workspace raises `DEPENDENCY_UNAVAILABLE` (503) naming the path and the variable that
fixes it, instead of a generic 500.

**The connector does not cross this boundary.** It runs on the host and can report which CLIs
are installed and whether they work, but its method set is closed and takes no executable. It
is not, and must not become, an execution broker that lets the container run host binaries:
that would reintroduce arbitrary host execution through a service whose entire value is that
it refuses it.

## Alternatives

- **Containerise the Mission Engine.** Rejected: it could no longer spawn the agent CLIs, which
  is its only job.
- **Mount the host CLIs and their config into the API image.** Rejected: it places live
  credentials inside a container surface and couples the image to one machine's home directory.
- **Drop `ReadonlyRootfs`.** Rejected: a writable image root removes a real containment
  property to work around a path that should have been configurable from the start.
- **Write workspaces to `/tmp`.** Rejected: `/tmp` is a 256 MB tmpfs here, and missions are
  durable — their workspaces must survive a restart.

## Consequences

- Deployment has two halves, and that is intentional: containers for the platform, systemd on
  the host for the ACP engine. Documentation and installers must stop presenting Compose alone
  as a complete deployment.
- `NEXUS_ACP_WORKSPACE_DIR` is effectively required for any read-only image. The default
  remains the checkout-relative path so a development run keeps working unchanged.
- The container and the host share one writable directory by design. It is the narrowest
  possible crossing of the boundary — a directory, not an execution channel — and it is the
  price of keeping the ACP engine where the agent CLIs live.
- Scheduled missions resolve the same root; they carried an identical copy of the defect.
- A deployment check should assert the workspace root is writable at startup rather than at the
  first mission.
