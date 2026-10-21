# Browser Worker

Isolated Python worker that drives a browser via [browser-use](https://github.com/browser-use/browser-use).

**Status: Implemented and tested.** 75 unit and integration tests, 11 TypeScript ↔ Python contract
tests, 6 real-communication tests, 2 local end-to-end tests (optional).

---

## Why a Separate Service

Three non-negotiable reasons:

1. **Language.** The backend is TypeScript; `browser-use` is Python. The boundary is an HTTP
   contract, never an in-process binding (ADR-006).
2. **Resources.** Chromium consumes between 300 MB and 1 GB of RAM and can crash. It must not
   destabilize or exhaust memory on the API server.
3. **Security.** The browser visits untrusted external content by definition. It runs without
   publicly exposed ports, without application secrets, and under an unprivileged user account.

```
Agent Core ─▶ BrowserWorkerClient ─▶ Browser Worker ─▶ browser-use ─▶ Chromium
  (TS)            (TS, HTTP)            (Python)
```

---

## Installation

### Local Environment

```bash
cd services/browser-worker

python -m venv .venv                 # Python 3.11 or newer
.venv/Scripts/activate               # Windows; source .venv/bin/activate on Linux/macOS
pip install -e ".[dev]"
python -m playwright install chromium

export BROWSER_WORKER_AUTH_TOKEN=$(openssl rand -hex 32)
export BROWSER_WORKER_LLM_API_KEY=...          # Anthropic API key

uvicorn app.main:build --factory --port 8100
curl http://localhost:8100/v1/health
```

Installation downloads Chromium (~150 MB) and ~100 Python packages; allow a few minutes on first run.

### With Docker

The worker is an **optional Docker profile**: its container image includes Chromium (~1.5 GB) and
does not need to run during standard backend development.

```bash
# In the root .env:
BROWSER_WORKER_TOKEN=$(openssl rand -hex 32)
LLM_API_KEY=...

pnpm docker:browser        # Builds and runs only the browser worker container
```

No host port is published: the worker is reachable exclusively over the internal Docker network.
This is deliberate — **never expose this service directly to the Internet.**

---

## Configuration

All configuration variables are prefixed with `BROWSER_WORKER_` and validated at startup:
a missing mandatory parameter prevents startup rather than failing on the first incoming request.

| Variable                       | Default             | Purpose                                                  |
| ------------------------------ | ------------------- | -------------------------------------------------------- |
| `AUTH_TOKEN`                   | —                   | **Mandatory**, minimum 16 characters. Shared auth token  |
| `LLM_MODEL`                    | `claude-sonnet-4-5` | Model used by browser-use to navigate                    |
| `LLM_API_KEY`                  | —                   | Provider API key                                         |
| `HEADLESS`                     | `true`              | Set `false` to display the UI (useful for debugging)     |
| `MAX_SESSIONS`                 | `5`                 | Maximum simultaneous browser instances                   |
| `SESSION_TTL_SECONDS`          | `600`               | Idle session lifetime                                    |
| `DEFAULT_TASK_TIMEOUT_SECONDS` | `180`               | Maximum task execution timeout                           |
| `ALLOW_PRIVATE_HOSTS`          | `false`             | **Testing only.** Allows `127.0.0.1` private addresses   |
| `LOG_LEVEL`                    | `INFO`              | Log verbosity level                                      |

---

## API

All endpoints require `Authorization: Bearer <token>`, except `/v1/health` — which remains accessible
without credentials so that health checks and misconfiguration diagnostics can always be performed.

| Verb     | Route                     | Purpose                                          |
| -------- | ------------------------- | ------------------------------------------------ |
| `GET`    | `/v1/health`              | Health status, protocol version, active sessions |
| `POST`   | `/v1/sessions`            | Spawns an isolated browser instance              |
| `GET`    | `/v1/sessions/{id}`       | Queries session state                            |
| `DELETE` | `/v1/sessions/{id}`       | Closes browser and releases resources            |
| `POST`   | `/v1/sessions/{id}/tasks` | Dispatches task (returns immediately)            |
| `GET`    | `/v1/tasks/{id}?since=N`  | Retrieves task state + events since sequence `N` |
| `POST`   | `/v1/tasks/{id}/cancel`   | Cooperative cancellation                         |

Events are strictly sequenced (`seq`): reconnecting after a network interruption loses no events and
replays none. Event types: `started`, `navigation`, `thinking`, `action`, `progress`, `result`,
`error`, `finished`.

---

## Intents: Security at the Right Layer

The backend decides *what the user intends to do*; the worker decides *what actions are physically permitted*.
A compromised backend cannot unilaterally escalate a read intent into a purchase.

| Intent     | Agent Tool         | Risk Level | Confirmation | Stripped Actions                     |
| ---------- | ------------------ | ---------- | ------------ | ------------------------------------ |
| `read`     | `browser.read`     | SAFE       | No           | click, input, tabs, JS eval, file ops|
| `interact` | `browser.interact` | MEDIUM     | Yes          | JS eval, file ops                    |
| `login`    | `browser.login`    | HIGH       | Yes          | JS eval, file ops                    |
| `purchase` | `browser.purchase` | CRITICAL   | Yes          | JS eval, file ops                    |

**`evaluate` (arbitrary JavaScript execution) is stripped across all intents.** It would bypass
all interface restrictions and could be exploited to exfiltrate cookies and session tokens. File operations
are also stripped: the browser has no legitimate reason to access the worker's filesystem.

`interact`, `login`, and `purchase` share identical allowed action primitives — clicking to filter results
and clicking to purchase are physically identical browser gestures. What distinguishes them is external:
required permissions, human confirmation requirements, and system instructions provided to the model.

Example:

- "Go to this website and check the ticket price" → `browser.read` → **no confirmation required**.
- "Purchase the ticket" → `browser.purchase` → **mandatory human confirmation**, with the exact price
  rendered in the preview modal.

---

## CAPTCHA and MFA: Never Automated

Three layers of defense, applied in sequence:

1. **System Prompt Constraint**: Placed ahead of user instructions: never attempt to solve CAPTCHAs,
   never bypass secondary authentication factors; halt immediately and describe the obstacle.
2. **Output Detection**: If the model output indicates human intervention is required, the task transitions
   to `needs_human`.
3. **Dedicated Status**: Not classified as a failure: the agent receives an explanatory message formatted
   for direct presentation to the user, allowing them to take control of the session.

The worker contains zero CAPTCHA solving code and will not include any.

---

## Secrets Management

| Rule                                    | Implementation                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| LLM never receives raw credentials      | Passed to browser-use via `sensitive_data`, which substitutes values upon form submission                                     |
| No secret leakage in output             | `redact_text()` applied to task output, error messages, and events, matching known sensitive task inputs                      |
| Zero secrets logged                     | Log redaction filter on root logger: by parameter key name **and** regex pattern (`sk-...`, `ghp_...`, JWTs, credit card numbers) |
| Configuration values never leak         | `describe()` exports parameter names and flags, never secret values                                                           |

---

## Network Isolation

`DomainPolicy` unconditionally blocks `localhost`, RFC 1918 private subnets, and cloud metadata
endpoints (`169.254.169.254`). An agent browsing untrusted external pages must never serve as an internal SSRF pivot.

A per-session allowlist can restrict navigation to authorized hostnames, enforced at the browser engine level via `BrowserProfile`.

---

## Tests

```bash
pytest                       # 75 unit/integration tests without browser or LLM
pytest -m browser            # + 2 end-to-end tests (requires Chromium and LLM key)
ruff check . && ruff format --check .
```

Only the browser + model runner is mocked (`FakeRunner`): API routes, authentication, sessions, policies,
events, cancellation, and redaction logic run against real implementations.

### TypeScript ↔ Python Contract

```bash
pnpm --filter @nexus/browser-client contract:emit   # after any protocol schema change
pytest tests/test_contract.py
```

The contract schema is emitted from backend Zod definitions and validated against Python Pydantic models:
field names, required attributes, enum values, and event variants. Schema drift breaks the CI build before
reaching production (Risk R7).

### Real Process Communication

```bash
NEXUS_WORKER_PYTHON=/path/to/python \
  pnpm --filter @nexus/browser-client test
```

Spawns the real Python worker and drives it with the TypeScript client over HTTP: testing JSON serialization,
token authentication, and HTTP error handling.

### Local End-to-End Test

`tests/test_e2e_local_site.py` serves a local flight booking mock page directly from the test runner and directs
the agent to extract flight prices — then verifies that a `read` task is strictly **prevented** from clicking
"Purchase". Zero external internet access is required, ensuring reproducible, deterministic tests.

---

## Diagnostics

| Symptom                                | Likely Cause                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `status: "degraded"` on `/v1/health`   | `browser-use` is not installed — worker boots in degraded mode to remain diagnostic-friendly                                |
| Worker refuses to start                | `BROWSER_WORKER_AUTH_TOKEN` missing or under 16 characters                                                                  |
| `BROWSER_SESSION_BUSY`                 | Session limit reached, or a task is already running in the selected session                                                 |
| Chromium crashes in container          | Insufficient shared memory (`shm_size`) — minimum 1 GB configured in compose                                                |
| Log: "restricted actions not found"    | Upstream browser-use update modified action names. **Resolve immediately**: an intent restriction may be rendered inactive |
