# ADR-010 — Deny by Default, Evaluated Risk, Hash-Bound Confirmation

**Status**: Proposed · 2026-09-01

## Context

The agent is capable of sending emails, deleting files, and executing shell commands. It may be
targeted by prompt injections originating from web pages or emails, or simply make an inference
error. System requirements establish three risk tiers (SAFE / CONFIRMATION / CRITICAL) and prohibit
any implicit permission grants.

## Decision

1. **Deny by default.** The absence of an explicit `PermissionGrant` evaluates to rejection. A newly
   installed tool is disabled until explicitly authorized by a human.
2. **Risk is dynamically evaluated, not merely declared.** `RiskEvaluator` combines the tool's base
   `riskLevel`, an analysis of its actual **arguments** (paths outside jail directories, byte sizes,
   monetary amounts, external recipients), and conversational context. It can only **escalate** risk
   levels, never downgrade them.
3. **Grants are scoped**, not binary: `device.fs.write` permitted _under `~/dev`, ≤ 5 MB, valid until
   Dec 31st_. Out-of-scope actions escalate to `CONFIRM` rather than outright `DENY`, keeping the
   human in the loop.
4. **Confirmations are bound to arguments** via an SHA-256 `payloadHash` and protected by a
   single-use `nonce` with an expiration window. Any discrepancy between what was approved and what
   is about to be dispatched invalidates the authorization, protecting against "bait-and-switch"
   attacks.
5. **`CRITICAL` actions can never be remembered** ("always allow" unavailable), require
   re-authentication, cannot be approved via voice or notification actions, and are automatically
   rejected if untrusted content entered the context during the current turn.
6. **Denial is an observation, not an unhandled crash**: The agent receives the rejection reason and
   can suggest an alternative approach or explain the necessary permission grant.

## Alternatives

- **Rely on the system prompt.** A prompt is not an access control boundary: it can be bypassed by
  adversarial phrasing. Rejected outright.
- **Confirm everything.** Secure in theory, unusable in practice: confirmation fatigue causes users
  to click approve without reading, which is _worse_ than fewer, highly targeted confirmations.
- **Traditional RBAC.** Designed for stable human organizational roles, not parameterized autonomous
  actions where risk is heavily dictated by argument payloads.

## Consequences

**Positive** — A successful prompt injection can at best _request_ a tool execution; actual dispatch
remains bound to permissions and explicit human approval. Every real action is tracked in
`ToolExecution` and `AuditLog`. Permissions can be revoked instantly.

**Negative, accepted** — Initial setup friction (mitigated by contextual scoped grant prompts and a
sensible initial set of default `SAFE` read-only tools); `RiskEvaluator` is critical domain logic
requiring exhaustive unit testing; the `payloadHash` prevents the agent from "fixing" an argument
post-approval — it must re-prompt, which is intentional security behavior.
