# Security policy

## Supported versions

NEXUS is alpha software. Only the latest commit on the default branch and the latest release are
supported. Earlier releases may receive a fix only when an immediate upgrade is impossible.

## Reporting a vulnerability

Use the repository's **GitHub private vulnerability reporting**. Do not open a public issue, and
never attach real tokens, cookies, private keys or session exports. Please include:

- the affected component and version;
- the impact and its preconditions;
- a minimal reproduction using fake credentials;
- a proposed fix, if you have one.

We aim to acknowledge within 72 hours. Coordinated disclosure happens once a fix and a security
advisory are available.

## Trust boundaries

These four lines are the whole threat model in short form. They are not aspirations: each one is
enforced somewhere in the code and covered by tests.

- **ACP agents and MCP servers are external processes, and potentially hostile.**
- **Model output and web content are data, never system instructions.** Tool results are fenced
  with a per-run random tag and JSON-encoded, so content cannot close the fence and speak as the
  system.
- **Secrets are injected into the process that needs them** and never enter prompts, logs, traces
  or API responses. Redaction happens on the way out, by key name and by value shape.
- **An irreversible or risky operation requires an explicit policy** and, where applicable, a
  human confirmation bound to the exact arguments. Approval of one payload does not authorise a
  different one.

`evals/security` attacks these boundaries on the assumption that **the model is already lost** —
that prompt injection succeeded and the agent does exactly what an attacker asked. The pass
criterion is not "the model resisted" but **"no unauthorised action was executed"**, because the
first is unmeasurable and changes with every model, while the second is measured on side effects.

Availability problems with no security impact can be reported as a normal issue.
