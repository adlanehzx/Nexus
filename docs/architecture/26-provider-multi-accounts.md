# NEXUS Architecture — 26. Multi-Account Provider Management

## 1. Context and Goals

NEXUS leverages local CLI agents connected to the user's existing personal subscriptions
(ChatGPT Plus for Codex, Claude Pro for Claude Code, Google AI Pro for Antigravity), without relying on
metered third-party API keys.

To satisfy intensive workloads and handle rolling quota constraints, NEXUS administers **multiple
accounts and identities per provider**:

- `antigravity-personal` / `antigravity-secondary`;
- `claude-primary` / `claude-backup`;
- `codex-primary` / `codex-dev`.

Each configured identity maintains:

1. A dedicated **system profile** and **isolated CLI session** directory;
2. Monitored **authentication status**;
3. Tracked **observed quotas** (5-hour window, weekly window, exhaustion state);
4. Automated and manual **cooldown timers**;
5. Arbitration **priority weight** (1 = highest priority);
6. Historical **reliability score** and success rate (0.00 to 1.00).

---

## 2. Strict CLI Session Isolation

Command-line tools (Claude Code, Antigravity `agy`, Codex CLI) default to storing session tokens and
caches in home directories (`~/.claude`, `~/.config/agy`, etc.).

To ensure strict separation and prevent cross-identity session contamination:

- Each identity is assigned an isolated session folder:
  ```
  ~/.nexus/agents/sessions/<account-id>/
  ```
- Directories are created with restricted file permissions (`0700`, readable only by the host user).
- During ACP process invocation (`@nexus/agent`), appropriate environment variables are injected into
  the spawned subprocess:
  - `CLAUDE_CONFIG_DIR` for Claude Code;
  - `ANTIGRAVITY_CONFIG_DIR` / `GEMINI_CLI_HOME` for Antigravity;
  - `CODEX_CONFIG_DIR` for Codex;
  - `XDG_CONFIG_HOME` as standard fallback.
- Session credentials and keyring entries are **never shared** across multiple accounts.

---

## 3. Data Model and Account States

Provider accounts are typed via Zod schemas:

```typescript
export interface ProviderAccount {
  id: string; // e.g. "claude-backup", slug [a-z0-9_-]
  provider: "claude" | "antigravity" | "codex" | string;
  name: string; // Human-friendly display label
  profileKey: string; // Associated ACP profile
  sessionDir: string; // Absolute path to isolated CLI profile
  env: Record<string, string>; // Identity-specific environment variables
  authStatus: "authenticated" | "unauthenticated" | "expired" | "unknown";
  lastCheckedAt: string | null;
  quotas: {
    remaining5hPercent: number | null;
    remainingWeekPercent: number | null;
    resets5hAt: string | null;
    resetsWeekAt: string | null;
    exhausted: boolean;
  };
  cooldown: {
    active: boolean;
    until: string | null; // ISO expiration timestamp
    reason: string | null;
  };
  priority: number; // 1 = highest scheduling priority
  reliability: {
    score: number; // 0.00 to 1.00
    totalRuns: number;
    successCount: number;
    failureCount: number;
    consecutiveFailures: number;
    lastErrorCategory: string | null;
    lastErrorAt: string | null;
  };
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

---

## 4. Cooldown Policies and Reliability Tracking

### 4.1 Automated Cooldowns

When an agent run fails, the classified error category triggers targeted mitigations:

- **`rate_limited`** (HTTP 429 or CLI rate limit signals):
  - Automated cooldown of **60 seconds**.
  - Reason: _"Rate limit detected by CLI"_.
- **`quota_exhausted`** (5-hour window or quota ceiling exceeded):
  - Sets `quotas.exhausted = true`.
  - Automated cooldown of **300 seconds** (5 minutes) or until quota reset time.
  - Excludes the identity from automated selection in favor of available backups.
- **`auth_required`** (Expired session token or credential revocation):
  - Sets `authStatus = "expired"`.
  - Automated cooldown of **600 seconds** (10 minutes) to avoid repeated failure loops.

### 4.2 Reliability Scoring

Reliability scores update dynamically:
$$\text{Score} = \frac{\text{successCount}}{\text{totalRuns}}$$

Accounts experiencing consecutive failures are temporarily downgraded during selection, guiding the
orchestrator toward the most stable accounts for critical tasks.

---

## 5. Intelligent Selection Algorithm (`selectAccount`)

For a specified provider (`claude`, `antigravity`, or `codex`):

1. **Filter Viable Candidates**:
   - Inactive cooldown (`cooldown.active === false` or timestamp in past);
   - Available quota (`quotas.exhausted === false`);
   - Valid authentication (`authStatus !== "expired"` and `authStatus !== "unauthenticated"`).
2. **Sort Order**:
   - **Ascending Priority**: `priority = 1` evaluated before `priority = 2`;
   - **Descending Reliability Score**: `0.98` evaluated before `0.85`;
   - **Ascending Consecutive Failures**: `0` evaluated before `1`.
3. **Graceful Fallback**:
   - If all accounts are cooling down or exhausted, the algorithm selects the account closest to
     cooldown expiration to minimize overall execution latency.

---

## 6. Security and Privacy Guarantees

- **Zero Secrets in Dashboard or API**: Session tokens, cookies, and sensitive environment keys
  remain strictly within local session directories (`~/.nexus/agents/sessions/<id>`) using `0700` permissions.
- **Access Control**: Administrative routes under `/api/v1/orchestrator/accounts/*` require `requireAdmin` role.
- **Atomic Local Persistence**: Saved into `var/config/provider-accounts.json` using atomic temporary file
  writes and renames. Session directories are excluded from Git tracking.
