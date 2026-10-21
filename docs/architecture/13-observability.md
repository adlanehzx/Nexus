# 13 — Observability

An autonomous agent is a non-deterministic system executing costly and mutating actions. Without comprehensive
observability, it is impossible to debug: errors cannot be reproduced, decisions cannot be explained, and
costs cannot be controlled. Observability is a structural requirement, not an operational afterthought.

## Implemented Architecture

- OpenTelemetry metrics exposed in Prometheus format on an independent metrics port;
- Distributed HTTP spans with optional OTLP export to an OpenTelemetry Collector and Grafana Tempo;
- Real-time counters for runs, token consumption, tool executions, errors, model fallbacks, and agent latency;
- API cost estimation based on an administrator-provided model pricing matrix;
- "Runs" administrative UI displaying latency percentiles (avg/p95), error breakdowns, and analysis replays;
- Optional local monitoring stack comprising Prometheus, Grafana, Loki, Tempo, Collector, and Alloy;
- Read-only Docker log harvesting without exposing root Docker sockets.

Launch local observability stack:

```bash
pnpm docker:observability
```

Grafana listens strictly on `http://127.0.0.1:3300`. Update `GRAFANA_ADMIN_PASSWORD` in `.env` before
running in non-development environments. The API exports traces when `OTEL_EXPORTER_OTLP_ENDPOINT` is
configured. Core metrics remain available independently of the Grafana stack.

## 1. Trace and Log Correlation

A single unique identifier traverses the entire lifecycle and is injected into **every** log line,
trace span, and metric event:

```
correlationId  →  HTTP Request → BullMQ Job → Agent Run → LLM Call
               →  Tool Execution → Device Task → Browser Worker Call
               →  WebSocket Event Rendered by Client UI
```

Displayed subtly in client error toasts: users can reference it, and a single grep across logs reveals
the complete execution history. Secondary correlation attributes: `userId`, `runId`, `conversationId`,
`execId`, `deviceId`.

## 2. Structured Logging (Pino → JSON)

```jsonc
{
  "level": "info",
  "time": "2026-10-21T14:32:00.123Z",
  "correlationId": "01J...",
  "userId": "usr_123",
  "runId": "run_456",
  "component": "tool-executor",
  "event": "tool.completed",
  "tool": "mail.send",
  "riskLevel": "CONFIRM",
  "durationMs": 412,
  "ok": true,
}
```

Rules: Logs are **discrete events**, not arbitrary prose strings (`event` is an immutable enum) ·
Native redaction across `authorization`, `cookie`, `password`, `token`, `apiKey`, and email values ·
Zero user message content logged at `info` level (reserved for `debug`, disabled in production) ·
All error events include both `code` and `correlationId`.

## 3. Traces (OpenTelemetry)

A single root trace per agent run, with child spans mapping the execution loop:

```
run.execute                                   [12.4s]
├── context.assemble                          [ 0.2s]  tokens=8412
├── llm.generate  model=… iteration=1         [ 2.1s]  in=8412 out=142 cost=0.021
├── permission.check tool=mail.list           [ 0.01s] effect=ALLOW
├── tool.execute  mail.list                   [ 1.2s]  ok=true
├── llm.generate  iteration=2                 [ 3.4s]
├── confirmation.wait                         [ 4.2s]  ← Isolated human wait time
└── tool.execute  mail.send                   [ 1.3s]
```

Isolating `confirmation.wait` is essential: without this span separation, human approval delays would
distort automated agent latency metrics.

Sampling strategy: 100% of failed runs, 100% of runs executing `CRITICAL` tools, 10% sample of standard runs.

## 4. Key Metrics (Prometheus)

| Domain      | Metric Names                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Agent Core  | `nexus_agent_runs_total{agent,status}`, `nexus_agent_run_duration_seconds`, `nexus_agent_fallbacks_total` |
| LLM Engine  | `nexus_agent_tokens_total{agent,direction}`, `nexus_agent_api_equivalent_cost_usd_total`                  |
| Tool System | `nexus_tool_calls_total{tool,status,agent}`                                                               |
| Permissions | `permission_decisions_total{effect,risk}`, `confirmations_total{status}`, `confirmation_response_seconds` |
| Real-time   | `ws_connections`, `ws_messages_total{type}`, `ws_dropped_frames_total`, `ws_resume_total`                 |
| Devices     | `devices_online`, `device_task_duration_seconds`, `device_policy_denied_total`                            |
| Infra       | HTTP latencies, queue depths, PostgreSQL pool stats, memory usage, `outbox_lag_seconds`                   |

Reported cost metrics represent a **configurable API equivalent**. If `MODEL_PRICING_JSON` is unconfigured,
NEXUS reports "unconfigured" rather than guessing.

## 5. Critical Alerts

| Alert Condition             | Threshold          | Justification                                        |
| --------------------------- | ------------------ | ---------------------------------------------------- |
| Run failure rate            | > 10% over 15m     | Functional regression or upstream provider outage    |
| Hourly cost anomaly         | > 3× rolling median| Looping agent or unintentional overuse               |
| Expired confirmations       | > 20%              | Push notifications failing or UX friction            |
| Runs stuck in `RUNNING`     | > 10m              | Worker crash without releasing distributed lock      |
| Queue backlog depth         | > 100 jobs         | Worker capacity under-provisioned                    |
| Upstream `PROVIDER` errors  | > 5%               | Model outage requiring automatic provider fallback   |
| Outbox event lag            | > 60s              | Asynchronous outbox dispatcher stalled               |
| Unexpected device offline   | Immediate          | Workstation capability unavailable                   |

## 6. Run Inspection and Replay

The administrative "Agent Runs" dashboard provides detailed breakdowns of status, final responses,
invoked tools, redacted arguments, errors, and timing metrics. Private user session transcripts and
raw secret values are never exported in traces.

Replaying a run instantiates a clean debug conversation linked to the source run with `maxToolCalls = 0`.
This guarantees an **analytical replay**: even if the model attempts to invoke external mutating tools,
they are blocked from executing. Mutating operations require initiating a new mission through standard
confirmation gates.

## 7. Deployment Configuration

The bundled Docker Compose observability stack is designed for single-node private environments.
Data is persisted in named Docker volumes, binding Grafana and Prometheus strictly to the local loopback
interface. For VPS deployments, ensure TLS termination, offsite backups, and reverse-proxy authentication.
