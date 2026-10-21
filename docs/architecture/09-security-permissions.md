# 09 — Security & permissions

## 1. Threat model

The main adversary is not an external attacker: **it is the agent itself**, manipulated or simply
mistaken. A model can be persuaded by a web page, an email or an MCP server's description to carry
out an action the user never asked for. The architecture assumes **the model will eventually get it
wrong**, and puts the guard rails outside it.

| Threat                       | Vector                                              | Line of defence                                                  |
| ---------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| Indirect prompt injection    | web page, email, file, MCP description              | §7 — fencing of untrusted data                                   |
| Capability escalation        | the agent invents a tool name or widens an argument | Closed registry + Zod validation + grant scope                   |
| Unwanted irreversible action | deletion, sending, payment                          | Risk levels + confirmation bound to a hash (§5)                  |
| Secret exfiltration          | a secret injected into the context, then echoed     | §6 — secrets never enter the context                             |
| Backend compromise           | RCE, token leak                                     | The device agent enforces its own policy (→ [06](06-devices.md)) |
| Device theft                 | lost phone                                          | Revocable sessions, biometrics for `CRITICAL`                    |
| Cost abuse                   | infinite loop, expensive tool                       | Per-run and per-day budgets, circuit breakers                    |

## 2. Authentication

**Users**: email + Argon2id, or OAuth (Google/Apple). A **15-minute** JWT access token (EdDSA,
rotating keys, `kid` in the header), and an opaque **30-day** refresh token with rotation and reuse
detection. The refresh token lives in the iOS Keychain or the OS keychain on desktop, never in
`AsyncStorage`. TOTP two-factor is mandatory as soon as a `CRITICAL` grant exists on the account.

**Devices**: Ed25519, challenge-response, no shared secret (→ [06](06-devices.md) §3).

**Internal services** (worker ↔ browser worker): a private Docker network plus a short-lived
service token; none of these services is exposed through the reverse proxy.

## 3. The five risk levels

| Level        | Operational definition                                         | Examples                                                                                    | Handling                                                                                                                             |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **SAFE**     | Read-only, no observable effect outside the system             | web search, weather, arithmetic, reading a calendar or an email, `memory.search`, `fs.read` | Runs directly. Logged.                                                                                                               |
| **LOW**      | Local effect, trivially reversible, invisible to third parties | writing a note in the workspace, remembering a preference                                   | Runs directly by default (the auto-approval threshold).                                                                              |
| **MEDIUM**   | Real side effect, reversible and limited in scope              | writing a file, creating an event, a local commit                                           | A confirmation card with the **exact preview**. May become "always allow" within a precise scope.                                    |
| **HIGH**     | Visible to a third party, or expensive to undo                 | sending an email, publishing, a push, a shell command                                       | Confirmation required, with a full preview of the exact content.                                                                     |
| **CRITICAL** | Irreversible, financial, or security-related                   | payment, mass deletion (> N items), changing credentials, revoking a device, `rm -rf`       | **Reinforced** explicit confirmation: re-authentication (biometrics/2FA), no "always allow", no auto-approval, short expiry (2 min). |

The level is computed by `RiskEvaluator` from three inputs: the tool's declared `riskLevel`, an
**evaluation of the arguments** (a path outside the allowed roots, a number of items, an amount,
external recipients), and the context (device, time of day, history). It can only ever go **up**,
never down. A `SAFE` tool with dubious arguments becomes `MEDIUM`; the opposite does not exist.

## 4. `PermissionService`

```ts
type Decision =
  | { effect: "ALLOW" }
  | { effect: "CONFIRM"; riskLevel: RiskLevel; reason: string; preview: Preview }
  | { effect: "DENY"; code: string; reason: string }; // reason → observation for the agent

interface PermissionService {
  check(user, tool, args, ctx): Promise<Decision>;
  listAllowedTools(user, ctx): Promise<ToolName[]>; // feeds the registry
  grant(user, subjectKey, scope, decision, ttl?): Promise<PermissionGrant>;
  revoke(grantId): Promise<void>;
}
```

Evaluation order, first verdict wins:

```
1. Global kill switch / read-only mode                → DENY
2. Tool disabled, or its source's circuit is open     → DENY
3. Budget exceeded (day, run, category)               → DENY
4. Explicit DENY grant (user)                         → DENY
5. Computed risk = CRITICAL                           → reinforced CONFIRM (always)
   (the auto-approval threshold, LOW by default, decides the rest)
6. ALLOW grant whose scope covers the arguments       → ALLOW
7. ALWAYS_CONFIRM grant                               → CONFIRM
8. requiresConfirmation(args) = true                  → CONFIRM
9. Default                                            → DENY   (deny by default)
```

Line 9 is the foundation: **no implicit access**. A newly installed tool is unusable until it is
granted.

### The scope of a grant

A grant is not a boolean but a domain of validity:

```jsonc
{
  "subjectKey": "device.fs.write",
  "scope": { "deviceId": "…", "pathPrefix": ["~/dev/leynai"], "maxSizeMb": 5 },
  "decision": "ALLOW",
  "expiresAt": "2026-12-31T00:00:00Z",
}
```

If the arguments fall outside the scope, the decision falls back to `CONFIRM` — not `DENY`: the
user keeps control without the agent being flatly blocked.

## 4 bis. Global pause

### The definition we chose

**Reading continues, acting stops.**

It is the only useful definition for a personal assistant: you pause NEXUS because you no longer
want it to _do_ things, not because you want it to go blind. While paused it still reads,
summarises and answers; it no longer sends, writes, executes or buys.

That boundary already existed: `readOnly` in `PermissionService` refuses every tool at risk `LOW`
or above and lets `SAFE` through. The risk scale already carried the right split; what was missing
was a way to operate it.

### What had to change to make it operable

`readOnly` was a boolean fixed at construction. Changing it meant rebuilding the permission
service, and therefore losing everything that depends on it. It now accepts a **closure**, consulted
on every authorisation: a pause takes effect on the next call.

### Three properties, and why each one

**It survives a restart.** A pause that forgets itself is worse than no pause: you believe NEXUS is
stopped, it no longer is, and nobody is told. The state is written by the same atomic write as the
rest of the configuration, re-read before accepting traffic, and a paused start-up is logged — it
has to explain itself.

**It carries a reason and a date.** "Nothing is happening" is the most expensive symptom to
diagnose. An interface that says "paused since 14:02: meeting" turns a riddle into information.
Pausing something already paused does not move the date: you want to know since when, not since the
last click.

**It cannot lock itself in.** Resuming is an action; if the pause refused actions without
exception, it would forbid its own lifting. The `/pause` routes therefore do not consult it — they
modify it.

### It covers both halves of the system

A stop button that only stops part of the system is worse than no button.

| path                                                                | what refuses                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| agent tools                                                         | `PermissionService`, through the `readOnly` closure                                         |
| a device task submitted directly (`POST /tasks`, `/tasks/instruct`) | the route, which checks the pause — it does not go through the permission layer             |
| a mission from the chat (`POST /orchestrator/messages`)             | the route, **before** submitting: a half-executed mission would be worse than a refused one |

Cancelling stays possible while paused: a cancellation removes an effect, it does not add one.

### Surface

```
GET  /api/v1/pause   → { paused, reason, since }
POST /api/v1/pause   { paused, reason? }
```

Both require a user. Pausing and resuming are recorded in the security log.

## 5. Confirmation flow

```mermaid
sequenceDiagram
  participant W as Worker
  participant DB as PostgreSQL
  participant API as WS gateway
  participant U as Mobile / desktop
  W->>W: PermissionService → CONFIRM
  W->>DB: Confirmation(PENDING, payloadHash, nonce, expiresAt)
  W->>API: confirmation.requested (+ push if the app is closed)
  W->>W: run → WAITING_CONFIRMATION, releases the job
  U->>API: POST /confirmations/:id { decision, nonce, remember? }
  API->>DB: check owner, status, expiry, nonce; APPROVED
  API->>W: enqueue resume:{runId}
  W->>DB: reload the run; re-check hash(args) == payloadHash
  W->>W: run the tool, continue the loop
```

Five properties never to relax:

1. **The worker does not block** — no `await` on a human; the run is suspended in the database.
2. **`payloadHash`** — the decision applies to exact arguments. Any divergence is a refusal.
3. **A single-use `nonce`** — prevents replaying an approval.
4. **Expiry** — 10 minutes (MEDIUM/HIGH), 2 minutes (CRITICAL). An expired confirmation is never
   auto-approved; silence never means consent.
5. **A faithful preview** — the card shows what will actually happen: the full body of the email,
   the file diff, the exact shell command with its working directory. A summary produced by the
   model is **not** a preview — the preview is built from the validated arguments.

`remember` creates a **scoped** `PermissionGrant` (this tool, these constraints, this duration),
never a blank cheque. Unavailable for `CRITICAL`.

## 6. Secrets

- **No secret in the code, nor in the repository.** `.env.example` lists keys, never values. A
  `gitleaks` hook runs pre-commit and in CI.
- **Config** validated at startup by `@nexus/config` (Zod): a missing secret fails the boot, never
  a silent error on the first request.
- **Infrastructure secrets**: injected environment variables (Docker secrets on a VPS; the
  migration path to Infisical/Vault is documented and needs no code change, because access goes
  through a `SecretStore` port).
- **User credentials**: envelope encryption. `MASTER_KEY` from the environment derives a per-user
  DEK (HKDF) → AES-256-GCM. A `keyVersion` is stored so keys can be rotated.
- **The model never sees a secret.** Tools receive `secretRef`s resolved **inside** the
  `ToolExecutor`, after the permission decision. Logs go through Pino redaction
  (`authorization`, `cookie`, `token`, `password`, `apiKey`, `Bearer …`).

## 7. Fencing untrusted input

This is the most frequently neglected part of an agentic architecture. Any data not typed by the
user is **untrusted**: web page content, email bodies, file contents, command output, an MCP tool's
description.

The rules:

1. Such content enters the context **fenced** — with a per-run random tag, and JSON-encoded, so the
   content cannot close the fence and speak as the system — accompanied by a rule stating that
   _instructions inside are data, never orders_. The rule is repeated **after** the data as well as
   before it: an instruction placed only in the system prompt is far away, while the injection is
   right there.
2. Fencing alone is not enough, and that is the point: the real barrier is the permission layer. A
   successful injection can at best **ask** for a tool, whose execution still depends on the grant
   and the confirmation.
3. **No escalation**: a `CRITICAL` action triggered in a turn where untrusted content was
   introduced is refused outright, not merely confirmed.
4. Exfiltrating tools (`http.request` POST, `mail.send`) aimed at a domain **mentioned in an
   untrusted source** are flagged, and the flag appears on the confirmation card.
5. A third-party MCP tool's description is truncated and escaped, and cannot modify the system
   prompt. It also grants nothing: a description claiming the tool is `SAFE` and pre-approved
   changes neither its risk level nor its required permissions, and `evals/security` attacks exactly
   that.

## 8. Application hygiene

TLS 1.3 everywhere (Caddy, automatic certificates) · HSTS · a strict CSP on the web · an allowlist
CORS · `helmet` · rate limiting per IP and per user · no CSRF protection needed, because there is
no auth cookie (Bearer only) · every SQL query through Prisma (parameterised) · systematic input
validation · audited dependencies (`pnpm audit`, Dependabot, `pnpm --frozen-lockfile` in CI) ·
non-root Docker images, distroless where possible · a **kill switch**: an admin endpoint that puts
the agent into read-only mode (every non-`SAFE` tool refused) with no redeployment — now operable
at runtime, see §4 bis.
