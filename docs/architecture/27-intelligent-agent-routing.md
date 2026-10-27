# NEXUS Architecture — 27. Intelligent Agent Routing & Feedback Learning

## 1. Context and Goals

NEXUS previously relied on static priority lists configured in runtime settings (`research_priority`,
`review_priority`, `synthesis_priority`) to dispatch ACP tasks to agents (`claude`, `antigravity`, `codex`).

The **multi-criteria intelligent routing engine** replaces static preferences with a dynamic arbitration
engine combining:

1. **Semantic and Lexical Task Classification** (`code`, `research`, `review`, `browser`, `synthesis`, `general`);
2. **Strict Required Capability Detection** (e.g. real Chromium navigation via `browser-harness`);
3. **Agent Connection and Health Status** (valid session, zero active cooldown);
4. **Remaining Rolling Quotas** (5-hour and weekly subscription windows);
5. **Historical Quality and Success Metrics** (persistent feedback learning loop);
6. **Context Length Feasibility** matched to model token limits;
7. **Automated Dynamic Fallback Chains** ordered by descending affinity score.

---

## 2. Taxonomy and Task Classification

The classifier evaluates task prompts through weighted lexical token matching and intent analysis:

| Category    | Primary Lexical Signals                                               | Default Benchmark Profile                       |
| ----------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| `browser`   | Navigation keywords, chromium, clicks, input forms, web scraping      | `codex`, `claude` (equipped with local harness) |
| `code`      | Source files (.ts, .py, etc.), refactoring, builds, git, vitest tests | `codex` (92), `claude` (90), `antigravity` (85) |
| `research`  | Codebase audits, architecture design, documentation, exploration      | `antigravity` (95), `claude` (90), `codex` (80) |
| `review`    | Critique, security auditing, error and regression detection           | `claude` (95), `codex` (85), `antigravity` (80) |
| `synthesis` | Executive summaries, final synthesis, conclusions, reports            | `claude` (95), `antigravity` (85), `codex` (80) |
| `general`   | Versatile unspecialized tasks                                         | `claude` (85), `antigravity` (85), `codex` (85) |

---

## 3. Multi-Criteria Scoring Algorithm

For each available agent candidate, the aggregate score $S_{total} \in [0, 100]$ is computed as:

$$S_{total} = w_1 S_{compat} + w_2 S_{auth} + w_3 S_{quota} + w_4 S_{health} + w_5 S_{quality} + w_6 S_{perf} + w_7 S_{context}$$

Using standardized weighting coefficients:

- $w_1 = 0.30$: **Task Compatibility** (base affinity adjusted by learned historical category success rate);
- $w_2 = 0.20$: **Authentication** ($100$ if session active, $0$ if expired or missing);
- $w_3 = 0.15$: **Quota Availability** (percentage of remaining 5h/weekly reserve, $0$ if exhausted);
- $w_4 = 0.15$: **Health & Cooldown** ($100$ nominal, $0$ if active cooldown or repeated errors);
- $w_5 = 0.10$: **Observed Output Quality** (success rate through NEXUS quality control: `pass` vs `revise`);
- $w_6 = 0.05$: **Latency Performance** (adjusted by historical resolution duration);
- $w_7 = 0.05$: **Context Capacity** (model token window vs. task prompt size).

### Strict Eligibility Filter

If an agent is cooling down, its quota is exhausted, or it lacks local browser harness support when
required by the task, it is marked `isAvailable = false` and sorted behind available agents with an
explicit exclusion reason.

---

## 4. Feedback Learning Loop

Execution telemetry persists into `~/.nexus/agents/routing/agent-routing-stats.json`:

```typescript
export interface AgentCategoryPerformance {
  runs: number;
  successes: number;
  failures: number;
  qualitySum: number;
  totalDurationMs: number;
}

export interface AgentPerformanceStats {
  key: string;
  categories: Record<TaskCategory, AgentCategoryPerformance>;
  consecutiveFailures: number;
  lastUsedAt: string | null;
  lastOutcome: "success" | "failure" | "revised" | null;
}
```

Upon task completion in the Mission Engine:

1. `recordOutcome(key, category, outcome, durationMs, qualityVerdict)` updates counters atomically.
2. If an agent experiences consecutive failures, a temporary cooldown is triggered.
3. The compatibility score $S_{compat}$ self-adjusts by $\pm 15$ points based on empirical history.

---

## 5. Orchestrator Integration & REST APIs

1. **DAG Generation Recommendations (`AcpOrchestrator`)**:
   - When generating mission DAGs, the orchestrator injects routing recommendations into the planner prompt.
   - If heuristic or deterministic fallbacks engage (`fallbackPlan`), `agentRouter.bestProfileFor`
     selects the top-performing profile for each task.
2. **Dynamic Fallback Chains**:
   - For every task, `router.fallbackOrderFor(profile, profiles, instruction)` computes optimal fallback
     sequences in case of runtime errors or quota exhaustion.
3. **REST Endpoints (`/api/v1/orchestrator/routing/*`)**:
   - `GET /orchestrator/routing/matrix`: Exposes the real-time affinity matrix with scores, auth status, and history.
   - `POST /orchestrator/routing/evaluate`: Evaluates an arbitrary task instruction and returns ranked recommendations.
   - `POST /orchestrator/routing/reset`: Resets empirical learning statistics (admin only).
4. **Dashboard Interface (`Agents.tsx`)**:
   - Matrix table showing affinities by task category;
   - Interactive routing evaluation simulator allowing immediate prompt testing;
   - Protected reset action with confirmation prompt.

## 6. Free-tier fallback

FreeLLM is the final optional model fallback after subscription-backed ACP agents and local engines.
The runtime currently supports NVIDIA NIM through its official OpenAI-compatible endpoint, plus
explicitly opt-in anonymous Kilo and OVH routes. NVIDIA credentials live only in the encrypted NEXUS
vault. Runtime JSON stores a `vault://` reference, never the credential.

This route is disabled by default. NVIDIA Developer Program access is suitable for prototyping,
research, development, and evaluation; NEXUS does not label it as free production capacity. Missing
or exhausted quotas are treated as unavailable and never as unlimited.
