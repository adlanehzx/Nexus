# ADR-013 — Secrets: Envelope Encryption and `SecretStore` Port

**Status**: Proposed · 2026-09-01

## Context

Two distinct categories of secrets exist and are frequently conflated:

- **Infrastructure** — LLM API keys, PostgreSQL passwords, JWT signing keys.
- **User Credentials** — Google/GitHub OAuth tokens, third-party API keys, web session cookies.

Specification constraint: Zero hardcoded secrets in code. Furthermore, an agent-specific constraint
applies: **the LLM must never view raw user credentials**, preventing accidental regurgitation or
exfiltration under prompt injection attacks.

## Decision

1. **Infrastructure Secrets** — Injected environment variables (Docker secrets in production),
   strictly validated at startup by `@nexus/config` (Zod). Missing configuration **aborts startup**.
   Accessed exclusively via the `SecretStore` port, never via arbitrary `process.env` lookups.
2. **User Credentials** — Envelope encryption: `MASTER_KEY` (env) → per-user DEK (HKDF) →
   AES-256-GCM encryption on each credential record, with `keyVersion` metadata supporting zero-downtime
   key rotation. Never exposed in API responses (metadata and scopes only).
3. **Tools receive `secretRef` handles**, resolved **inside `ToolExecutor`** only after permission
   grants have been confirmed. The LLM prompt sees `secretRef: FLIGHT_API_KEY`, never the secret
   value; logged tool arguments are redacted.
4. **Automated redaction** (Pino) covering `authorization`, `cookie`, `token`, `password`, `apiKey`,
   plus regex fallback filters (`sk-`, `ghp_`, JWT signatures).
5. **`gitleaks`** in pre-commit hooks and CI; `.env.example` documents keys with placeholder values.

## Alternatives

- **HashiCorp Vault / Infisical from day one.** Standard at enterprise scale, but represents another
  stateful service to operate and back up for single-tenant or personal usage. The `SecretStore` port
  makes future adoption seamless: write an adapter without changing callers.
- **Cloud KMS (AWS/GCP KMS).** High-grade key management, but couples the architecture to a single
  cloud vendor when our deployment target is neutral VPS infrastructure.
- **Plaintext database storage.** Completely unacceptable: a compromised database dump would leak
  all connected user accounts.

## Consequences

**Positive** — A stolen database dump alone cannot compromise user third-party credentials (it
requires the external `MASTER_KEY`); key rotation is fully supported; the LLM cannot exfiltrate what
it never observes.

**Negative, accepted** — `MASTER_KEY` becomes the root of trust: losing it renders credentials
unrecoverable (requiring offline password manager backups), while leaking it alongside a database dump
is catastrophic. Root key rotation requires scripted automation (`infra/scripts/rotate-master-key.ts`)
and thorough verification.
