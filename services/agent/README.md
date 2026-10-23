# NEXUS ACP agent runtime

This service runs a declared ACP profile in a bounded workspace. It initializes
the ACP session, applies supported model and reasoning options, streams the
response and grants tool permissions only for locations inside the configured
workspace roots.

Profiles are structured JSON records. Commands and arguments come from the
registry rather than user input, and provider sessions remain owned by the
provider CLI. NEXUS does not copy provider tokens.

## Deterministic tests

The default suite uses a fake ACP provider and never consumes an external
allowance:

```bash
pnpm --filter @nexus/agent test
```

## Real provider smoke test

A real conversation is available behind explicit opt-in. Run it only after the
account owner approves quota use:

```bash
NEXUS_REAL_AGENT_CONVERSATION=1 \
NEXUS_REAL_AGENT_PROFILE=codex \
NEXUS_REAL_AGENT_REGISTRY=services/agent/config/profiles.example.json \
pnpm --filter @nexus/agent exec vitest run test/real-agent.smoke.test.ts
```

The test records only pass/fail evidence. It does not print the model response
or provider credentials.

## References

- [Agent architecture](../../docs/architecture/03-agent.md)
- [ACP profile example](config/profiles.example.json)
