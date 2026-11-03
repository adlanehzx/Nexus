# Running the Remediation Lots in Parallel

Three agents work at once on the lots that follow lot 1. The partition below is by
**file ownership**, not by theme: themes overlap, files do not, and a rebase conflict costs more
than a slightly awkward boundary.

## Why ownership and not topic

Two files used to serialise the whole plan. `apps/dashboard/src/ui/Sections.tsx` held twenty
screens in 4 319 lines and is touched by six lots; `services/api/src/services/container.ts`
registered every tool domain inline, so any lot adding one had to edit that constructor. Lot 1
split the first into one module per section and moved the second behind `TOOL_DOMAINS`. Without
that, three agents in parallel conflict on every rebase — which is why lot 1 lands before the
lanes open, not after.

## Branches and worktrees

Integration happens on one branch. Nothing merges to `master` directly.

```
integration/nexus-remediation          ← single integration branch
├── claude/lot-core                    work/claude/lot-core
├── codex/lot-surface                  work/codex/lot-surface
└── antigravity/lot-domains            work/antigravity/lot-domains
```

```bash
git worktree add -b <agent>/<topic> work/<agent>/<topic> integration/nexus-remediation
```

Each worktree needs its own `pnpm install` — worktrees share git history, not `node_modules`.

## Ownership

| Agent | Lots | Owns exclusively | Must not touch |
| --- | --- | --- | --- |
| **Claude Code** | 3, 4, 6, 8 | `services/api/src/{app,server}.ts` · `services/api/src/services/{container,tool-registration,autonomy-safety,connection-manager,pause}.ts` · `routes/v1/{organizations,connections}.ts` · `packages/{config,llm,protocol}` · `infrastructure/` · `packaging/linux` · `.github/workflows` | `apps/dashboard/**` · `services/api/src/services/career/**` · `services/mission-engine/**` |
| **Codex** | 5, 9, 10 | `apps/dashboard/src/ui/sections/**` · `apps/dashboard/src/lib/api.ts` · `routes/v1/dashboard.ts` · `services/api/src/services/observability*` · `e2e/**` | `container.ts` · `packages/protocol` · `prisma/schema.prisma` |
| **Antigravity** | 7, 11, 12 | `packages/client-core/src/career-education/**` · `services/api/src/services/career/**` · `routes/v1/career.ts` · `services/mission-engine/**` · `routes/v1/satellites.ts` · `packaging/satellite` · `apps/dashboard/src/ui/i18n/**` | `container.ts` · `routes/v1/dashboard.ts` · `packages/protocol` |

Codex works through its own CLI in its worktree, **not** as an agent orchestrated by NEXUS:
BUG-003 leaves `@agentclientprotocol/codex-acp@1.10.0` silent on `initialize`. Lot 3.4 fixes the
adapter; until then no task may be routed to the `codex` ACP profile.

## The three remaining contention points

- **`apps/dashboard/src/ui/App.tsx`** — navigation and `renderSection`. Lots 5, 9 and 11 each add
  or rename a section. Handle it with small dedicated PRs merged first, never inside a feature
  branch.
- **`prisma/schema.prisma`** — only lot 7.3 touches it, one additive migration, reviewed by
  Claude Code before merge.
- **`packages/protocol/src/{envelope,worker}.ts`** — frozen. See below.

## Merge gate

A branch merges into integration when it passes, in this order:

1. `pnpm lint`, `pnpm typecheck`, `pnpm test` — all three now run with `--continue`, so a failure
   in one package no longer hides the rest.
2. The API wiring check (lot 1.3): a route with no caller and no justified allowlist entry fails.
3. The worker contract check (lot 1.3): any diff under `packages/protocol/src/{envelope,worker}.ts`
   without a version bump fails. Four workers share that envelope — Windows, Android, browser
   host, and the future ESP32 — so an unversioned change breaks all of them at once.
4. From lot 10.1 onward, the end-to-end job against the compose deployment. It is the gate that
   would have caught BUG-002: 2 169 unit tests passed while the chat answered 500.

Rebase onto integration daily. A worktree that drifts for more than a day on a shared file is the
main source of conflicts this partition exists to prevent.

## Invariants no lot may break

`packages/protocol` version and the `start → connect → hello → challenge → authenticate → session`
handshake; `POST /devices/pair` and the pairing-ticket flow; the six allowlisted satellite
commands; `BU_CDP_URL` and the browser host transport; and the database — no destructive migration
is planned anywhere in this work.
