# Lab 2 implementation handoff

The implementation adds a spot/stocks execution path under `/api/v1/mission-control/trading`. All routes require the administrator session. The original binary prediction-market paper workflow remains at `/paper/*`.

## Architecture and requirements

1. `ExecutionVenue` defines balances, positions, order placement/cancellation/status, quotes and open-order enumeration. `TradingLab` applies the same Kelly/risk checks before virtual or live execution. Adapters live in the TypeScript API to resolve credentials directly from the existing vault; no raw trading credentials are sent to Python. **The new PaperVenue is a persisted spot simulator, not a wrapper around the existing Python binary ledger. The original Python strategy/risk engine has not been migrated into this interface. This part of requirement 1 remains incomplete.**
2. Binance Spot REST supports the official Spot Test Network and production with HMAC-SHA256 signatures. Kraken Spot REST uses the documented SHA256 + HMAC-SHA512 construction. Kraken Spot testnet fails explicitly without a request: the publicly documented Kraken demo is for derivatives, which this spot adapter does not implement. IBKR uses an authenticated HTTPS Client Portal Gateway on loopback, verifies SSO and the selected account, and requires a DU paper account in testnet mode. TLS verification is never disabled. IBKR does not use a fabricated HMAC/API-key authentication scheme. No SDK/dependency was added. Polymarket and Kalshi are absent from the live venue allowlist.
3. Dashboard configuration persists mode, enabled state, per-venue environment, quote currency, symbol/base-asset mappings, account/gateway, capital, order/position limits, daily loss, drawdown, Kelly fraction and manual confirmation. Only limit orders and long-only positions are supported. Secrets use `vault://nexus/trading-<venue>-<environment>`; saved responses/state/audit contain no credential values. Key rotation invalidates production confirmation. Global kill latches before network cancellation attempts, including remembered live venues after a mode switch. Failed cancellations are visible and can be retried with the kill button.
4. Default is virtual and disabled. Production enablement requires a separate explicit confirmation, stored with timestamp and account/environment identity. Risk decisions, monitor decisions, intent-before-send, submissions, configuration changes and kill actions use a SHA-256 chained ledger checked on every load. Unknown submission outcome triggers a kill and blocks new orders. Network/authentication/valuation failures are visible and do not select paper execution. Every order checks current balances, positions, open orders and quotes. Daily loss and peak-to-current drawdown monitor runs every 15 seconds without a browser. Existing open orders block new submissions rather than estimating reservations. Unknown held assets fail valuation closed. Capital/limits are in the selected venue quote currency; no implicit FX conversion is attempted.
5. The new panel in PaperTrading distinguishes saved virtual/live mode, displays a persistent live banner with danger accent, config/risk controls, password fields and trade-only/no-withdrawals guidance, per-venue cash/positions/orders and the reused equity chart using recorded observations. SVG icons and `--nx-*` variables are used. The original binary simulator is labeled separately.

## Persistence / operational limits

State and audit are atomically replaced in `<acpWorkspaceRoot>/trading-lab/state.json` (default `.nexus-workspaces/trading-lab/state.json`), mode 0600, directory mode 0700. Keep this directory on persistent storage. No Prisma changes or running database migrations were made. Serialization is per API process: **this storage is for a single API instance, not concurrent replicas**. The audit chain detects changed links but has no external signed anchor.

The kill switch is intentionally latched; no dashboard rearm workflow is implemented. Recovery/reconciliation of ambiguous orders requires operator work. An order status endpoint exists on each adapter but there is no complete reconciliation console. IBKR warning replies are never auto-confirmed; they fail closed and activate the submission uncertainty guard. IBKR position pages of 100 or more entries fail closed until pagination is implemented. Kraken derivatives/demo are not implemented. Exchange precision/lot-size failures remain explicit venue rejections; there is no automatic quantity rounding. Virtual fills require a crossing limit and use that limit price without fee/slippage modeling. The legacy Python binary ledger retains its existing fee/slippage model. No production orders, authenticated live connectivity tests, browser walkthrough, or real sandbox account integration were performed.

## Validation actually run

- `pnpm --filter @nexus/api test -- test/trading-lab.test.ts`: Vitest interpreted this as the full API suite: **69 files passed; 601 passed, 1 skipped (602)**, 143.61s. This preceded the final five regression tests.
- `pnpm --filter @nexus/api exec vitest run test/trading-lab.test.ts`: final targeted run **1 file, 21 tests passed**, 482ms. Covers signed requests with mocked HTTP, Kraken sandbox rejection, IBKR SSO/paper enforcement and refusal to auto-confirm warnings, sanitized errors, disabled defaults, production approval timestamp, order/position/manual guards, daily-loss and drawdown kill, cancellation, mode-switch cancellation, no fallback, intent replay, credential non-disclosure, uncertain submission kill, shared virtual risk path, visible cancellation failure and audit tamper detection.
- `pnpm --filter @nexus/api build`: latest run failed on an unrelated concurrent Career file: `src/services/career/autonomy-service.ts:117 TS6133 WORK_STATES is declared but its value is never read`. No Trading errors in this output. Earlier runs caught Career `actor` property errors while the other agent was editing them.
- `pnpm --filter @nexus/dashboard build`: **passed**, latest build 718ms.
- `pnpm --filter @nexus/dashboard test`: **24 files, 201 tests passed**, 5.08s.
- `pnpm --filter @nexus/dashboard typecheck`: fails in concurrent/pre-existing Career client, App section ID, Domotique and vcs-worktrees files. No errors remain in the touched Trading files; existing strict-index and unused-import errors in paper-trading were fixed while reusing its chart.
- `uv run pytest` in `services/mission-engine`: **136 passed, 4 skipped, 1 warning**, 4.87s. Warning is Starlette/httpx deprecation. Python sources unchanged.
- `pnpm exec prettier --write` followed by `--check` on the nine touched TS/TSX source/test files only: **All matched files use Prettier code style!**

No git-state-changing commands, dependencies, commits, database changes or production venue requests were performed.

## Exact files for coordinator

Created:

- `services/api/src/services/trading/venues.ts`
- `services/api/src/services/trading/lab.ts`
- `services/api/src/routes/v1/trading.ts`
- `services/api/test/trading-lab.test.ts`
- `apps/dashboard/src/lib/trading.ts`
- `apps/dashboard/src/ui/sections/trading-console.tsx`
- `docs/labs/lab2-trading.md`

Modified:

- `services/api/src/routes/v1/mission-control.ts` — imports/registers the lab-specific route plugin.
- `apps/dashboard/src/lib/api.ts` — adds tradingStatus/tradingAction methods only; this file is shared with the other agents.
- `apps/dashboard/src/ui/sections/paper-trading.tsx` — mounts console, passes recorded equity observations/currency to the chart, fixes strict array indexing/unused imports.

## Official references consulted

- [Binance Spot REST request security](https://developers.binance.com/en/docs/products/spot/rest-api)
- [Kraken authentication algorithm](https://support.kraken.com/au/articles/360029054811-what-is-the-authentication-algorithm-for-private-endpoints-)
- [Kraken demo environment is derivatives](https://support.kraken.com/articles/360024809011-api-testing-environment-derivatives)
- [IBKR authentication](https://www.interactivebrokers.com/docs/web-api/authentication/introduction)
- [IBKR gateway and paper login](https://www.interactivebrokers.com/campus/trading-lessons/launching-and-authenticating-the-gateway/)
