# 02 — Backend Architecture

## 1. Two Processes, Two Responsibilities

|                             | `apps/api`                                           | `apps/worker`                             |
| --------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| Role                        | Network boundary: REST, WebSockets, auth, validation | Execution of agent runs and long jobs     |
| Operation duration          | Milliseconds                                         | Seconds to minutes                        |
| Scaling                     | Horizontal, sticky sessions not required             | Horizontal by queue concurrency           |
| May call an LLM?            | No                                                   | Yes                                       |
| May execute a tool?         | No                                                   | Yes                                       |

Separating these two is not gratuitous complexity: an agent run lasts between 5 and 120 seconds and
consumes significant context memory. Co-locating it within the HTTP process makes deployments
destructive (a rolling deployment terminates active runs) and skews API p99 latency metrics. With this
separation, deploying the API loses zero in-flight runs, and an interrupted run is resumed cleanly by
another worker since state is persisted in the database.

## 2. Layers of `apps/api`

```
routes/         Fastify routes. Zod schemas (validation + OpenAPI generation). Zero business logic.
  v1/auth  v1/conversations  v1/messages  v1/agent  v1/tools
  v1/devices  v1/tasks  v1/memory  v1/permissions  v1/confirmations  v1/voice
plugins/        JWT auth, rate-limit, request-id, cors, helmet, sensible, OpenTelemetry
services/       Application use cases (orchestration, database transactions)
gateway/        WebSockets: client sessions + device sessions, Redis fanout, sequence replay
repositories/   Prisma. Only layer aware of SQL schemas.
```

Rule: A route handler never queries Prisma directly. It invokes a service. The service owns the
transaction boundary. This design allows `POST /agent/runs` to be fully atomic (message + run + job)
via the **transactional outbox** pattern (§4).

## 3. Technology Choices

| Requirement      | Choice                                       | Justification                                                 |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------- |
| HTTP Framework   | Fastify 5                                    | High throughput, encapsulated plugins, native schema parsing  |
| Schema Validation| Zod + `fastify-type-provider-zod`            | Types inferred directly from schemas, single source of truth  |
| API Docs         | `@fastify/swagger` generated from schemas    | Docs are guaranteed up-to-date with runtime validation        |
| ORM / Database   | Prisma                                       | Type safety, migrations, pgvector via `Unsupported` & queries|
| Queue Engine     | BullMQ                                       | Retries, exponential backoff, priority, cron, job DAGs        |
| Cache & PubSub   | ioredis                                      | Unified Redis instance for queues, pubsub, streams, rate limit|
| WebSockets       | `@fastify/websocket` (ws)                    | Native standard ws, avoiding unnecessary Socket.IO lock-in    |
| Authentication   | Short-lived JWTs + rotating refresh tokens   | See [09-security](09-security-permissions.md)                |
| Logging          | Pino                                         | Structured JSON, native high-performance redaction pipeline   |

## 4. Reliability: Outbox, Idempotency, and Distributed Locks

**Transactional Outbox.** Writing to the database and publishing a message to a queue are two separate
distributed systems; they cannot be made atomic in a single call. We persist an `OutboxEvent` in the
same SQL transaction as the domain data, and an asynchronous dispatcher reads the outbox table to enqueue
the BullMQ job. In the worst case, a job is dispatched twice — hence the requirement for idempotency.

**Idempotency.** Enforced at three levels:

1. _API Layer_ — `Idempotency-Key` header on all mutating requests; backed by the `IdempotencyKey` table
   (key, request hash, cached response, 24-hour TTL). Mobile network retries do not spawn duplicate runs.
2. _Job Layer_ — Deterministic `jobId` naming (`run:{runId}:step:{n}`); BullMQ deduplicates natively.
3. _Tool Execution_ — Every tool call generates an idempotency key derived from
   `(runId, stepIndex, tool, hash(args))`. Mutating tools must propagate this token to upstream APIs when
   supported, or query `ToolExecution` before executing. See [04-tools](04-tools-mcp.md).

**Distributed Locks.** Each active run acquires a Redis lock (`lock:run:{id}`, auto-renewing TTL):
only one worker can progress a run at a time. This prevents race conditions during confirmation resumption.

## 5. Error Handling

A unified error taxonomy defined in `@nexus/errors`:

```
AppError { code, httpStatus, severity, retryable, userMessage, context }
 ├── ValidationError        400  Never retryable
 ├── AuthError              401/403
 ├── NotFoundError          404
 ├── ConflictError          409  (Idempotency collision, version mismatch)
 ├── PermissionDeniedError  403  → Observation fed back to the agent, not an unhandled crash
 ├── ConfirmationRequired   -    Control flow signal, not an application error
 ├── ToolExecutionError     -    { toolName, phase, retryable }
 ├── ProviderError          502  { provider, upstreamCode } Retryable if 429/5xx
 ├── TimeoutError           504  Retryable
 └── BudgetExceededError    -    Cleanly terminates run, returning partial results
```

Three core principles: (1) `userMessage` is always safe for end-user display; `context` is for logs only;
(2) Error codes are public contracts and remain stable; (3) A tool failure is not an unhandled run crash —
it becomes an observation that the LLM can evaluate (retry with alternative arguments, use fallback tool,
or explain graceful abandonment).

## 6. Rate Limiting and Resource Quotas

- Per-IP rate limits on `/auth/*` (brute-force defense), per-user limits on `/agent/runs`.
- Business quotas distinct from network rate limits: tokens/day, dollar cost/day, concurrent runs,
  tool executions/hour broken down by risk tier. Stored in Redis, modeled in `Budget`, exposed via
  `/api/v1/me/usage`. Breaches yield HTTP 429 with `retryAfter`, and workers refuse to initialize runs.
