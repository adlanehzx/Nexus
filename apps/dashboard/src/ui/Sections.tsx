/**
 * Supervision sections.
 *
 * Each loads its own data: a failure in one section does not take down the others,
 * and an unreachable MCP server must not clear the workers screen.
 *
 * Admin actions reuse existing business routes. Irreversible operations remain
 * explicitly confirmed; no section bypasses core permissions or validations.
 *
 * Split into one module per section: six lots touch this surface, and a single
 * 4 300-line file made every one of them a rebase conflict. This barrel keeps
 * the import that `App.tsx` lazy-loads unchanged.
 */

export * from "./sections/browser.js";
export * from "./sections/communication-graph.js";
export * from "./sections/dag-debugger.js";
export * from "./sections/devices.js";
export * from "./sections/logs.js";
export * from "./sections/marketplace.js";
export * from "./sections/mcp.js";
export * from "./sections/memory.js";
export * from "./sections/mission-engine.js";
export * from "./sections/notifications.js";
export * from "./sections/overview.js";
export * from "./sections/quota-forecast.js";
export * from "./sections/organizations.js";
export * from "./sections/observability.js";
export * from "./sections/run-comparison.js";
export * from "./sections/runs.js";
export * from "./sections/security.js";
export * from "./sections/tasks.js";
export * from "./sections/tools.js";
export * from "./sections/visual-control.js";
export * from "./sections/workers.js";
export * from "./sections/vcs-worktrees.js";
export * from "./sections/providers.js";
