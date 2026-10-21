# 18 — Browser Use (Implemented Architecture)

## 0. Recommended Local Route: Zero Paid API Keys

For local ACP agents (Codex, Claude), NEXUS utilizes the official
[`browser-harness`](https://github.com/browser-use/browser-harness). The ACP model drives Chromium
directly via CDP: the harness contains no secondary LLM loop and requires zero third-party API keys.
A systemd user service runs a dedicated NEXUS Chromium profile on the local loopback `127.0.0.1:19222`;
access to personal user browser profiles is never granted implicitly.

The planner routes web navigation tasks to Codex, falling back to Claude, and excludes Antigravity
from browser fallbacks until its ACP adapter demonstrates verified browser support. The local harness
is a shared resource: browser actions are serialized, while other tasks execute concurrently in parallel.

The Python worker described throughout the remainder of this document remains available as an
advanced autonomous mode. It runs its own internal `browser-use` loop requiring an external LLM
provider; it is not utilized in the default local keyless configuration.

This document describes the integration **as built in the codebase**. Document [05 — Browser Use worker](05-browser-use.md)
establishes the conceptual foundation; this document reflects the implemented code.

Packages: [`services/browser-worker`](../../services/browser-worker) (Python),
[`@nexus/browser-client`](../../packages/browser-client) (TypeScript).

## 1. Verified API and Engine Compatibility

`browser-use 0.13.8`, Python ≥ 3.11. The integration was verified **against the installed package
bytecode**, rather than documentation:

| Element               | Component Invocation                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Agent                 | `Agent(task, llm, browser, tools, sensitive_data, task_id, register_should_stop_callback, step_timeout)` |
| Execution             | `agent.run(max_steps=…, on_step_end=…)`                                                                  |
| Action Sandboxing     | `Tools(exclude_actions=[…])`                                                                             |
| Browser Driver        | `Browser(browser_profile=BrowserProfile(…))`                                                             |
| Language Model        | `ChatAnthropic`                                                                                          |

Two pitfalls were discovered during package inspection:

- **`allowed_domains` belongs on `BrowserProfile`, not `Browser`.** If passed to `Browser`, domain
  whitelisting would fail silently without error: the browser would navigate freely while assuming
  restrictions were active.
- **`Agent.__init__` accepts arbitrary `**kwargs`.** Passing `max_steps` to the constructor — rather
  than to `run()` — was silently swallowed with zero operational effect.

The adapter avoids brittle hardcoded signatures: `_supported_kwargs()` inspects the runtime signature
and transmits only accepted parameters.

## 2. Process and Network Isolation

The TypeScript backend never imports Python code directly. Communication flows over a versioned HTTP contract:

```
Agent Core ─▶ BrowserWorkerClient ─▶ FastAPI ─▶ browser-use ─▶ Chromium
    (TS)       (TS, HTTP + Bearer)   (Python)
```

The worker container publishes **zero host ports**, runs as an unprivileged user with `no-new-privileges`,
and inherits zero backend application secrets. It is configured as an optional Docker Compose profile:
its container image packages full Chromium binaries (~1.5 GB) and does not run during standard API development.

## 3. Intent as a Security Constraint, Not a Tag

Four operational intents — `read`, `interact`, `login`, `purchase` — define both the risk level on the
agent side and the action restrictions on the worker side.

The central core decides _what should be done_; the local worker enforces _what is permitted to happen_.
A task assigned the `read` intent is physically denied the "click" action: `browser-use` does not
register it. A compromised backend cannot turn a read operation into an unauthorized purchase.

**`evaluate` (arbitrary JavaScript execution) is permanently excluded across all intents.** It would
bypass all UI boundary restrictions and risk exfiltrating cookies and session tokens. Direct disk
filesystem operations are likewise disabled.

A boot-time check verifies that restricted action names exist within the installed library registry.
This caught regressions immediately: action names assumed from early documentation (`click_element_by_index`,
`input_text`) did not exist in version 0.13.8, where they are named `click` and `input`.

## 4. Human-in-the-Loop Safeguards

Three defensive layers: explicit prompt constraints, output classification, and a dedicated `needs_human`
state. `needs_human` is not an unhandled failure — the agent receives a structured explanation to relay
to the user, who takes manual control of the browser step before resuming autonomous execution.

The worker contains zero CAPTCHA-solving bypass routines.

## 5. Secret Handling and Masking

Site credentials pass through `sensitive_data` in `browser-use`: the model prompt sees placeholder
tokens, never plaintext secrets. In output processing, `redact_text()` is applied to return values,
errors, and event streams, matching known session inputs — preventing models from echoing credentials
entered into form fields.

## 6. Real-Time Progress Visibility

`ToolContext` provides an `onProgress` channel, relayed by the agent loop as `tool.progress` events.
This avoids displaying a generic spinner while a browser is navigating. Worker events (`navigation`,
`action`, `progress`) translate into clear human-readable messages: "Navigating to flights.test",
"Step 3 of 15".

## 7. Refinements from Initial Design (Doc 05)

| Dimension              | Document 05                     | Implemented Code                              | Justification                                                                                             |
| ---------------------- | ------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Exposed Tools          | `browser.act` + low-level tools | Distinct tool per operational intent          | Risk must be granular; "extract pricing" and "execute purchase" cannot share an identical approval grant |
| Progress Updates       | Redis Streams                   | HTTP long-polling with `seq` sequence markers | Numbered events make resumption reliable without persistent connections for internal services            |
| Screenshot Archiving   | Per-step object storage         | `screenshotRef` reserved in schema metadata   | Object storage integration attaches in infrastructure deployment phase                                    |
| Persistent Profiles    | Encrypted cookies at rest       | Ephemeral browser contexts only               | Host credential manager protects service tokens; persistent cross-site cookies remain out of scope        |

## 8. Local Administration Dashboard

The Browser Use configuration tab supports two modes. The recommended "Local Browser" mode sets the
local loopback CDP endpoint and runs `browser-harness doctor --json --require-existing-daemon`; the check
verifies connectivity without leaking page titles, URLs, or tab contents to the API. Health probes
execute a silent `page_info()` query, reporting ready only when the CDP session connects successfully.
The `nexus-browser.service` systemd unit enforces `Restart=always` so that closing Chromium does not
leave the dashboard in a dead state.

The advanced "Standalone Worker" mode preserves internal URLs and `vault://nexus/...` secret references:
bearer tokens resolve via the host keychain and are never returned to the browser client. HTTP is
restricted strictly to `localhost`, `127.0.0.1`, or `::1`; remote endpoints require HTTPS.

## 9. Cross-Language TypeScript ↔ Python Contract Tests

Two complementary test mechanisms:

- **Contract Tests** (`tests/test_contract.py`): Zod schemas are exported to JSON Schema and compared
  against Pydantic models — field names, required flags, enums, event variants.
- **Integration Tests** (`packages/browser-client/test/integration.test.ts`): Boots an actual Uvicorn
  worker driven by the real TypeScript client — verifying HTTP transport, serialization, auth, and error codes.

## 10. Unified Native Web Navigation (Agent Core & browser-harness)

To eliminate dependency on the heavy Python worker while guaranteeing full autonomy without API keys,
NEXUS unifies the local `browser-harness` daemon directly with Agent Core via `@nexus/browser-client`.

### Architecture and Control Flow

Chromium runs on `127.0.0.1:19222` under `nexus-browser.service`. Agent Core orchestrates native navigation via:

```
Agent Core (TS)
  │
  ├── ToolRegistry (5 native browser.* tools)
  │      │
  │      ▼
  └── BrowserSessionManager ──▶ BrowserSecurityPolicy (SSRF, protocols, downloads, CAPTCHA)
         │
         ├── Tab isolation per mission (createTab / switchTab / closeTab)
         ├── Action quotas (50 max) and session duration limits (300s max)
         ├── Artifact storage (var/artifacts/browser/<sessionId>/)
         │
         ▼
      BrowserHarnessDriver (CDP local 127.0.0.1:19222)
         │
         ▼
      browser-harness CLI ──▶ Chromium Daemon
```

### The 5 Native Agent Core Tools

1. **`browser.navigate`**:
   - Navigates to a secure web URL (`http:` or `https:`).
   - Opens or activates the dedicated session tab (`sessionId` derived from mission `runId`).
   - Awaits DOM stabilization (`wait_for_load`).
   - Detects bot-detection challenges and authentication prompts immediately.
   - Captures a timestamped screenshot, persisting it as a managed artifact.

2. **`browser.extract`**:
   - Extracts readable text from the current page in `markdown`, `text`, or `html` format.
   - Optionally targets a DOM subtree via CSS selector.
   - Sanitizes content by stripping `<script>`, `<style>`, `<noscript>`, `<iframe>`, and `<input type="password">` elements.
   - Enforces character bounds via `maxCharacters` (default 12,000) with explicit truncation notices.

3. **`browser.click`**:
   - Clicks an element targeted by CSS selector or relative `(x, y)` coordinates.
   - For selectors, calculates element center via `getBoundingClientRect()` and verifies visibility prior to CDP click dispatch.
   - Waits for page stabilization (`wait_for_load`), returning the updated page URL and title.

4. **`browser.type`**:
   - Enters text into an element targeted by CSS selector.
   - Supports `clear` (clears existing text prior to input, enabled by default) and `submit` (sends `Enter` key and awaits page load).

5. **`browser.screenshot`**:
   - Captures an explicit screenshot of the active session tab.
   - Saves the image as a PNG artifact under `var/artifacts/browser/<sessionId>/<timestamp>-<uuid>.png`.
   - Records and returns artifact metadata (`artifactId`, `fileName`, `filePath`, `url`, `title`).

### Session Isolation and Operational Quotas

- **Strict Tab Isolation**: Each navigation session binds to a unique `sessionId` (defaulting to mission `runId`).
  A session controls a dedicated Chromium tab; invoking `closeSession()` terminates the associated CDP tab.
- **Action Ceiling**: Sessions enforce a default limit of 50 actions (`QuotaExceededError`) to prevent infinite navigation loops.
- **Time-to-Live (TTL)**: Sessions expire automatically after 300 seconds (5 minutes) of activity.

### Security Policies and Human Intervention

- **Protocol Validation**: Only `http:` and `https:` schemes are permitted. Schemes such as `file:`,
  `chrome:`, `javascript:`, `about:`, and `data:` are rejected immediately.
- **Anti-SSRF Protections**: Explicit blocking of local loopback addresses (`127.0.0.1`, `localhost`, `::1`),
  cloud instance metadata services (`169.254.169.254`), and private subnets under RFC 1918 and RFC 4193
  (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`).
- **Binary Download Prevention**: Blocks navigation to URLs referencing executable installers (`.exe`,
  `.sh`, `.bin`, `.msi`, `.dmg`, `.apk`, `.deb`, `.iso`, etc.).
- **Human Takeover Detection**: Proactive DOM and title scanning identifies Cloudflare Turnstile, CAPTCHAs,
  and MFA challenges. When detected, `BrowserSessionManager` suspends the session, captures a visual snapshot,
  and raises `HumanInterventionRequiredError`, allowing the operator to resolve the challenge from the
  dashboard before resuming autonomous execution.
