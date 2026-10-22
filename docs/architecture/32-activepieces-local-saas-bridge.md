# 32. Activepieces Local Automation and SaaS Actions

## 1. Context and Goals

Activepieces provides NEXUS with an ecosystem of hundreds of turnkey SaaS connectors (Slack, Discord, Notion, Stripe, GitHub, Airtable, etc.) orchestrable on local infrastructure:

1. **Isolated Local Deployment**:
   - Containerized deployment via `infrastructure/docker/docker-compose.activepieces.yml`.
   - Strict localhost loopback `127.0.0.1:8080` with no external exposition or Tailscale routing.
   - Secrets and API credentials resolved dynamically from the secure NEXUS vault (`vault://nexus/...`).
2. **NEXUS → Activepieces Bridge (`@nexus/activepieces`)**:
   - `ActivepiecesBridgeClient` coordinates with the local Activepieces REST API and webhook endpoints.
   - Synchronous or asynchronous flow triggering with execution tracking (`pollRun`).
   - Direct action execution against any registered SaaS piece.
3. **Security Gating and Mandatory Human Confirmation**:
   - Any irreversible external action (public message broadcast, Stripe financial charge, resource deletion) **MANDATORILY** triggers a human confirmation request with clear action preview.
   - Read-only actions (querying records, listing databases) proceed without blocking.
4. **Result Ingestion into NEXUS Missions**:
   - Structured outputs (remote object identifiers, extracted data) are returned directly to agents and missions as `ToolResult`.

## 2. Native Tools for NEXUS Agents

| Tool                          | Domain             | Risk Level | Human Confirmation                | Description                                                 |
| ----------------------------- | ------------------ | ---------- | --------------------------------- | ----------------------------------------------------------- |
| `activepieces.list_flows`     | `terminal.execute` | `SAFE`     | No                                | Lists available local automation flows                      |
| `activepieces.trigger_flow`   | `terminal.execute` | `HIGH`     | Conditional (`isSensitive`)       | Triggers a full flow via webhook or ID                      |
| `activepieces.execute_action` | `terminal.execute` | `HIGH`     | **Dynamic / Mandatory if scoped** | Executes a direct SaaS action (Slack, Stripe, Notion, etc.) |
| `activepieces.get_run`        | `terminal.execute` | `SAFE`     | No                                | Queries status and output of a specific run                 |

## 3. Isolated Local Deployment

To start the isolated local Activepieces stack:

```bash
docker compose -f infrastructure/docker/docker-compose.activepieces.yml up -d
```

The UI and API are bound strictly to localhost loopback `http://127.0.0.1:8080`.
