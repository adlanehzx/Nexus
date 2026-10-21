# ADR-001 — Monorepo pnpm + Turborepo

**Status**: Proposed · 2026-09-01

## Context

Seven applications (api, worker, mobile, desktop, web, device-agent, browser-worker) share
types, a WebSocket protocol, tool schemas, and error codes. These contracts evolve frequently in the
early stages of the project. The primary risk is **drift**: mobile speaking a version of the
protocol that the server no longer supports.

## Decision

A monorepo using pnpm workspaces + Turborepo, with `@nexus/contracts` as the pivot package and
dependency boundary rules enforced in CI. `apps/browser-worker` (Python) lives in the same
repository but maintains its own toolchain (`uv`, `pytest`), wired into the Turborepo graph as an
opaque task.

## Alternatives

- **Polyrepo + published npm packages.** Every contract change requires publishing, bumping, and
  synchronizing across 5 repositories. Prohibitive at this stage of the project.
- **Nx.** Richer feature set (generators, graph, plugins) but more prescriptive and heavier to
  learn; Turborepo is sufficient for a task cache and dependency graph.
- **npm/yarn workspaces.** pnpm was selected for its hard-linked store (fast installation, disk
  savings) and strict dependency isolation preventing phantom dependencies — essential when 7 apps
  coexist.

## Consequences

**Positive** — A contract change immediately breaks compilation across all consumers; atomic
refactoring; a single CI; straightforward onboarding.

**Negative, accepted** — Longer CI runs without proper caching (mitigation: Turborepo remote
cache); Expo/Metro requires specific configuration to resolve workspace packages
(`disableHierarchicalLookup`, `watchFolders`); repository grows larger; dependency boundary rules
must be automated, otherwise they will be violated.
