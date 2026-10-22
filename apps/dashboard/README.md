# NEXUS Dashboard

Supervision interface for the entire system. **Read-only, reserved for administrators.**

```
apps/dashboard  ──▶  /api/v1/dashboard/*  ──▶  requireAdmin  ──▶  DashboardService
   (React)                                       (role read               (reads)
                                                from store)
```

## Twelve Sections

| Section       | What is displayed                                                                          |
| ------------- | ------------------------------------------------------------------------------------------ |
| Overview      | online devices, active workers, running and failed tasks, recent activity, system health   |
| Devices       | role, platform, status, capabilities, last heartbeat, health, trust, effective permissions |
| Workers       | declared **and** actual channel state, load, capabilities                                  |
| Tasks         | plan, steps, assigned workers, progress, execution log, results, errors                    |
| Agent Runs    | status, actions, tools, progress, result, errors, metrics                                  |
| Tools         | catalog, risk levels, required permissions, authorization status                           |
| MCP           | servers, state, published tools, circuit breaker, last error                               |
| Browser Use   | configured, reachable, reported health status                                              |
| Memory        | volumes by tier, provenance and sensitivity, recent memories                               |
| Notifications | unread count, severity, message contents                                                   |
| Security      | device trust levels, effective permissions, security events                                |
| Logs          | retained log lines, filterable by log level and text query                                 |

## Three Invariant Rules

### 1. Model Chain of Thought Is Never Exposed

An agent run contains its complete transcript and opaque provider blocks (`LlmMessage.providerBlocks`).
These exist to be replayed in subsequent turns, not to be read by users or operators.

This guarantee is enforced **by construction**: `projectAgentRun` reads only from `AgentRunRecord` —
never from `AgentState.messages`. One cannot forget to redact a field that is never queried. The
Zod response schema seals the boundary a second time: even if the projection changed, an undeclared
field would not be serialized.

What is exposed: **status, action, tool, progress, result, error, metrics.**

Proven by a test run where every forbidden field carries a recognizable canary string, subsequently
searched across the full JSON response (`services/api/test/dashboard.test.ts`), and reinforced by
client-side structural validation (`test/exposure.test.ts`).

### 2. Twelve Sections, Single Security Guard

Every route requires `requireAdmin`. There is no "less sensitive" subset accessible to regular clients:
a partial view of the infrastructure is still a view of the infrastructure, and splitting access guards
would multiply security surface areas.

The role is resolved **from the persistent store, not from the access token**. If embedded in an access
token, revoked permissions would remain active for up to 15 minutes. Sessions are already checked on
every request; an additional store lookup is negligible and guarantees immediate revocation.

Access denials are discreet: an ordinary account receives "Resource not found" (404), not "Admin role
required" (403). The administrative surface is not advertised to unprivileged users.

### 3. Read-Only Operations

No dashboard route or client method performs mutations. Supervision and administration are distinct
surfaces; putting destructive actions into a dashboard frequently consulted in passing invites costly
accidents. Device approvals, revocations, and task cancellations remain on their respective dedicated
routes with their own granular controls.

## Scopes

Two scopes are intentionally differentiated:

- **Per-user resources** — devices, tasks, memories, notifications, runs — are queried on behalf of the
  administrator, never dumped globally across all accounts. The `ADMIN` role grants infrastructure
  supervision; it was never intended to expose other users' private conversations.
- **System-level resources** — MCP servers, browser worker, tool catalog, logs — are global.

## "Unconfigured" Is Not "Degraded"

An unconfigured MCP server that has never been set up is not failing. Displaying it in red would trigger
investigations into nonexistent incidents. `unconfigured` is therefore treated as a distinct status
level, displayed in gray, and excluded from global health score calculations — if all services are
unconfigured, the system reports "unknown", which is far more truthful than reporting an ungrounded green.

## Development

```bash
pnpm --filter @nexus/dashboard dev     # http://localhost:5274
```

`VITE_NEXUS_URL` points to the NEXUS Core. **No secrets are bundled**: the dashboard authenticates
like any regular client, and account roles unlock access to dashboard sections.

Authentication tokens reside **only in memory** and are cleared on page reload. An administrative
dashboard is the last place where long-lived tokens should be stored in browser storage accessible to
page scripts.

## The First Account

`InMemoryUserStore` automatically assigns the `ADMIN` role to the **first registered account** —
allowing initial configuration on a fresh installation. Subsequent registrations are standard accounts.

> **Important Deployment Note:** Any publicly exposed deployment must disable open registration
> immediately after creating the initial administrative account. Otherwise, arbitrary visitors could
> register and gain administrative privileges.
