# NEXUS web dashboard — Phase 2: UX architecture

Scope: `apps/dashboard` only. This document specifies structure and behaviour; `03-design-system.md` specifies appearance and the migration. Nothing here changes business logic: every screen keeps the API calls it makes today, and where the design needs data the dashboard does not yet read, the endpoint is named and the wiring is listed in section 12.

Visual reference: [`directions/c-cadran.html`](directions/c-cadran.html).

## 0. Decisions

### Taken by the owner

| # | Decision |
| --- | --- |
| 1 | Direction **C · Cadran**, pure. Dark is the reference theme; light exists and passes WCAG AA. |
| 2 | **Spatial OS is removed.** One shell. Each Spatial-only screen is folded or dropped (section 3). |
| 3 | **The seven accent themes are removed.** One identity, two themes (light, dark). |
| 4 | **Orbitron and Rajdhani are removed everywhere**, logotype included. |

### Taken here, on the questions left open

| Question | Decision | Reasoning |
| --- | --- | --- |
| Density | **One density, Cadran compact** (28 px controls, 30 px rows, 13 px interface text). Agent answers use a separate reading size (14 / 23 px, 72-character measure). No user setting at launch. | A second density doubles the visual test surface while 1,346 inline styles are still being removed. The three density values are isolated as component tokens, so a "comfortable" set can be added later as three overrides. Until then, browser zoom is the accommodation, and the layout is required to hold at 200 % (section 11). |
| Default theme | Preference stays three-state — **system / light / dark — and defaults to system**. | Dark is the *reference* (designed and reviewed first), not a forced default. The dashboard forbids persistent browser storage (`test/exposure.test.ts`), so an explicit choice lasts one tab session; a "dark" default would make light-theme users re-select on every visit, while "system" needs no storage at all. |
| Voice | **Telegraphic for state, plain sentences for decisions.** Status lines and labels: capitals, facts, middle dots (`EN COURS · 2 agents · étape 3/5`). Anything the user must decide on or recover from — approvals, confirmation dialogs, error remedies — is a complete sentence. NEXUS does not say "je" in the interface. | Terse status is what makes Cadran read as an instrument; terse *consent* text is how people approve things they did not understand. The split keeps the character and removes the risk. What the model writes in a conversation is content, not interface copy, and is not constrained by this. |
| Form of address | **Vouvoiement** in French; buttons in the infinitive ("Approuver", "Relancer"). English: imperative verbs, sentence case. | Matches the existing French copy; no reason to change register. |
| Mobile and desktop timing | **Web first; mobile and desktop keep today's "Signal" tokens until their own redesign.** The Cadran values ship beside the current ones in `packages/design` (see `03-design-system.md` §9). | `tokens.ts` is imported directly by `apps/mobile/theme/index.tsx` and `apps/desktop/src/lib/theme.ts`. Replacing values in place would restyle two applications nobody has redesigned or tested. |
| Live updates | **Polling, as today**, through one shared telemetry store. The WebSocket channel in `@nexus/client-core` is not adopted in this phase. | The dashboard already polls (`/api/v1/pause` every 15 s, mission tracking). One store with one cadence removes the duplicated timers without introducing a new transport and its failure modes during a visual migration. |
| Command palette | **`Ctrl K` / `Cmd K` opens a palette in the one shell.** | Today the shortcut switches shell. The palette is the keyboard-first entry point Codex and Claude Code users expect. |
| i18n mechanism | **Unchanged.** `tr("en", "fr")` stays for screen copy; the dictionary is used for shell and component strings only. | 2,647 call sites; converting them is not a visual change and would collide with every work package. |
| Emergency stop | **Always visible in the status bar; stopping is immediate, resuming asks for confirmation.** | Stopping is the fail-safe direction and must never wait for a dialog. Resuming re-enables autonomous actions and deserves one. |

---

## 1. Shell

One shell, four regions. No modes: nothing in the sidebar is ever replaced by something else.

```
┌───────────────┬──────────────────────────────────────────┬──────────────────┐
│ SIDEBAR 240   │ MAIN                                     │ INSPECTOR 360    │
│               │  header 38: title · state · actions      │ (contextual,     │
│ logo + state  │                                          │  collapsible)    │
│ search Ctrl K │  content                                 │                  │
│ + new conv.   │   conversation feed + composer           │ mission activity │
│               │   or section / lab / settings page       │ run detail       │
│ Activity   2  │                                          │ diff viewer      │
│ Usage    43 % │                                          │                  │
│ LABS          │                                          │                  │
│  Career       │                                          │                  │
│  Trading      │                                          │                  │
│  OSINT        │                                          │                  │
│  Home         │                                          │                  │
│ CONVERSATIONS │                                          │                  │
│  (scrolls)    │                                          │                  │
│ Settings      │                                          │                  │
├───────────────┴──────────────────────────────────────────┴──────────────────┤
│ STATUS BAR 26: link · services · agents · approvals · quota   EMERGENCY STOP│
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Sidebar (240 px)

Top to bottom:

1. **Brand row.** State-driven logo (`03-design-system.md` §6) and the wordmark. Clicking it opens a new conversation.
2. **Search / command field.** Opens the palette (`Ctrl K`).
3. **New conversation** button (`Alt N`).
4. **Sections.**
   - **Activity** — badge = number of pending approvals; the badge is absent at zero.
   - **Usage** — readout = lowest remaining 5-hour quota across accounts (`43 %`), in the warning tone under the alert threshold.
5. **Labs**, flat: Career, Trading, OSINT, Home. Trading carries a `virtuel` / `réel` tag taken from the trading configuration, so the mode is visible before the page is opened.
6. **Conversations**, the only scrolling region: grouped by day, search, rename, delete, load more (today's `ConversationSidebar`, restyled). A conversation with a mission in flight shows the activity lamp; one waiting for approval shows the approval mark.
7. **Settings**, pinned at the bottom. The session menu (language, theme, sign out) opens from here and from the palette.

Why this order: the fixed entries are few and must not move; the conversation list is long and takes the remaining height. This is the layout of the reference tools.

### 1.2 Main

- **Header (38 px):** the title of what is open, its state, and at most two actions that apply to it. No eyebrow, no description, no decoration. The page title is the document's `h1`.
- **Content:** a conversation, or a page. Pages start with their content; there are no hero banners.

### 1.3 Inspector (360 px, optional)

A contextual right-hand panel, closed by default on pages that have nothing to put in it, toggled with `Ctrl .`. In a conversation it holds the mission's activity table, quotas and last error; in Activity it holds the detail of the selected run or task; in a diff it holds the file list.

### 1.4 Status bar (26 px)

Full width, always present, monospace capitals. It is the only place global state is shown, and every item on it is measured (section 7). The emergency stop is at its right end.

### 1.5 Routes

Hash routes are kept (no server change) and gain parameters, so a conversation, a run or a settings page can be linked and survives a reload.

```
#/                       new conversation
#/c/:conversationId      conversation
#/activity/:tab?/:id?    runs | tasks | approvals | schedules | notifications | logs | audit | system | repos
#/usage/:tab?            limits | overview | costs | tokens
#/labs/career/:tab?      #/labs/trading/:tab?      #/labs/osint/:tab?      #/labs/home/:tab?
#/settings/:page         interface | shortcuts | providers | agents | models | tools | devices |
                         browser | memory | notifications | secrets | backup | organization
```

Every old hash redirects (section 2), with `history.replaceState`, so bookmarks and the existing end-to-end tests keep working.

---

## 2. Navigation map

Every route the Classic shell serves today, and where it goes.

| Today | Screen | New home | Notes |
| --- | --- | --- | --- |
| login (no hash) | Login | Login | Restyled. Language and theme switches kept. 3D background removed. |
| setup (no hash) | Setup wizard | Setup wizard | Restyled; same steps. |
| `#/chat` | Chat | `#/` and `#/c/:id` | Becomes the home of the product. |
| `#/overview` | Overview | `#/activity/system` | Counts move to the status bar and to tab badges; the health table and recent activity become the System tab. The hero is removed. |
| `#/tasks` | (alias of Overview) | `#/activity/tasks` | Now shows the task list it names. |
| `#/career-education` | Career & Education | `#/labs/career` | 11 tabs regrouped into 6 (section 5.2). |
| `#/trading-lab` | Trading Lab | `#/labs/trading` | |
| `#/osint` | OSINT | `#/labs/osint` | |
| `#/domotique`, `#/satellites` | Home & Satellites | `#/labs/home`, `#/labs/home/satellites` | |
| `#/quota-forecast` | Usage overview | `#/usage/overview` | |
| `#/usage-limits` | Limits & resets | `#/usage` (default tab `limits`) | Becomes the default: it answers "how much is left". |
| `#/usage-costs` | Costs | `#/usage/costs` | |
| `#/usage-tokens` | Tokens | `#/usage/tokens` | |
| `#/settings`, `#/settings-preferences` | Preferences & themes | `#/settings/interface` | Shell choice and accent themes removed; theme, language remain. |
| `#/settings-shortcuts` | Keybindings | `#/settings/shortcuts` | Spatial actions removed from the list. |
| `#/settings-secrets` | API keys & secrets | `#/settings/secrets` | |
| `#/settings-backup` | Backup & restore | `#/settings/backup` | |
| `#/providers` | Providers & CLIs | `#/settings/providers` | Absorbs Connections. |
| `#/agents` | Agents & profiles | `#/settings/agents` | |
| `#/settings-engine` | LLM engines & routing | `#/settings/models` | |
| `#/devices` | Devices & network | `#/settings/devices` | Gains a Workers tab. |
| `#/mcp` | MCP servers & tools | `#/settings/tools` | Tabs: Servers, Tools, Extensions, Access tokens. |
| `#/browser` | Web browser | `#/settings/browser` | Gains the visual-control section. |
| `#/memory` | Semantic memory | `#/settings/memory` | |
| `#/notifications` | Notifications | `#/activity/notifications` (list) and `#/settings/notifications` (channels) | The inbox is operational; the channel configuration is a setting. Same component, split at the existing boundary between the list and the configuration form. |
| `#/mission-control` | Missions & schedules | `#/activity/schedules` | Leaves Settings. |

Settings is one page with a second-level list inside the main area (13 entries in four groups: Interface, Intelligence, Capabilities, Data). The sidebar does not change when Settings is open.

---

## 3. The 15 Spatial-only screens

All fifteen call real endpoints (checked in `services/api/src/routes/v1/dashboard.ts` and neighbours), so none is dropped for lack of data.

| # | Screen | File | Decision | New home |
| --- | --- | --- | --- | --- |
| 1 | Agent runs | `sections/runs.tsx` | **Folded** | `#/activity/runs` — the default Activity tab. Selecting a run opens its trace in the inspector. Also the source of the tool-call log shown inside conversations. |
| 2 | Tasks | `sections/tasks.tsx` | **Folded** | `#/activity/tasks`, detail at `#/activity/tasks/:id`. |
| 3 | DAG debugger | `sections/dag-debugger.tsx` | **Folded** | A "Graph" tab inside a task's detail, not a destination. Rendered as an indented step list with dependency marks. Step pause/resume controls are shown disabled with the server's own message, since the API reports step suspension as not implemented. |
| 4 | Run comparison | `sections/run-comparison.tsx` | **Folded** | An action on the runs table: select two rows, "Compare" (`#/activity/runs?compare=a,b`), result in the inspector. |
| 5 | Logs | `sections/logs.tsx` | **Folded** | `#/activity/logs`. |
| 6 | Security | `sections/security.tsx` | **Folded** | `#/activity/audit`. It is an audit trail, read in the same way as logs. |
| 7 | Observability | `sections/observability.tsx` | **Folded** | `#/activity/system`, under the health table: totals, error rates, latency per agent. |
| 8 | Workers | `sections/workers.tsx` | **Folded** | A tab of `#/settings/devices`. Workers are the execution side of paired devices. |
| 9 | Tools | `sections/tools.tsx` | **Folded** | "Tools" tab of `#/settings/tools`. |
| 10 | Marketplace | `sections/marketplace.tsx` | **Folded** | "Extensions" tab of `#/settings/tools`. Plugins are tools with an install step. |
| 11 | Visual control | `sections/visual-control.tsx` | **Folded** | A section of `#/settings/browser`. While a visual-control session is active, the status bar shows it and links there, so its pause control is one click from anywhere. |
| 12 | Organizations | `sections/organizations.tsx` | **Folded** | `#/settings/organization`. |
| 13 | VCS & worktrees | `sections/vcs-worktrees.tsx` | **Folded, in two parts** | The worktree list and pull-request links become `#/activity/repos`. The checkpoint diff viewer becomes the shared `DiffView` component, used here and in conversations. |
| 14 | Connections | `Connections.tsx` | **Merged, screen dropped** | Its three functions (list, detect, test local CLIs) duplicate "Detect installed CLIs" on Providers. One list on `#/settings/providers`. |
| 15 | Agent communication graph | `sections/communication-graph.tsx` | **Dropped** | A node-link picture of who called whom, derived from the same run list as Activity. It answers no task the runs table and the System tab do not already answer, and a custom graph renderer is the kind of surface this redesign removes. The endpoint is untouched; the file is deleted in the cleanup package. |

Removed with the shell itself: the infinite canvas, tiled windows, the five "spaces", the minimap, the assist/manual toggle, and their key bindings. Kept from it: the idea of a command palette (rebuilt in the single shell) and `keybindingStore` (moved out of `ui/spatial/`).

---

## 4. Core flow: conversation → mission → approval

This is the product's main loop and the largest change.

### 4.1 What the user sees

```
You        Check that each MCP server only asks for the permissions it needs...

NEXUS      3 of 6 MCP servers declare overly broad scopes. Fixing the configuration...

+ MISSION . MCP PERMISSIONS AUDIT --------- claude . opus --- 02:14 . 18.4k tokens +
| [done]    Read the configuration of the 6 MCP servers                      0:21 |
| [done]    Compare declared and used scopes                                 0:48 |
| [running] Fix excessive scopes                                             1:05 |
| [queued]  Re-run the integration tests                                          |
| [queued]  Write the summary                                                     |
| RUNNING . step 3/5                                     [######....] 40 %        |
| > config/mcp/github.json                                             +1 -1      |
+---------------------------------------------------------------------------------+
+ APPROVAL REQUIRED ------------ HIGH RISK ---------------- expires in 04:32 +
| codex is asking to push a branch to the remote repository.                 |
| $ git push origin fix/mcp-scopes                                           |
| [Approve  A]  [Decline  R]                               View the run      |
+----------------------------------------------------------------------------+
```

1. **Send.** The composer stays enabled while a mission runs. A message sent during a mission is queued and shown as queued; it is delivered when the mission reaches a terminal state. (Today the textarea is disabled.)
2. **Mission card.** Appears as soon as the orchestrator returns a mission. Header: title, agent profiles, elapsed time, token count, a control to stop following. Body: the step list, one row per orchestrated task with its state. Footer: progress as a segmented bar plus the counter.
3. **Log and diff, in place.** Each step expands to the tool calls behind it (tool, action, risk level, status, duration, error). File changes appear as collapsible diffs under the card.
4. **Approval card.** When a run is waiting for confirmation, a card appears in the thread at the point where the work stopped: the action, the exact command or description, the risk level, the tool, the expiry countdown. `A` approves and `R` declines when the card has focus; `Alt A` moves focus to the oldest pending approval from anywhere.
5. **Outcome.** The card collapses to one line (`APPROVED · 14:07`), the mission continues or ends, the final answer is rendered in the reading column with a copy control.

The same approval is also listed in **Activity → Approvals** and counted in the sidebar badge and the status bar. Answering it in one place resolves it everywhere.

### 4.2 Where each piece of data comes from

| Element | Source (existing) | Read by the dashboard today? |
| --- | --- | --- |
| Mission created | `POST /api/v1/orchestrator/messages` → `OrchestratedMission` | Yes (`sendToNexus`) |
| Mission state, counter | `GET /api/v1/orchestrator/missions/:id` (`state`, `completedTasks`, `totalTasks`, `profiles`, `response`, `error`) | Yes (`nexusMission`, polled by `ConversationHistory.pollTracked`) |
| Step list | `GET /api/v1/orchestrator/missions/:id/collaboration` → `tasks[]` (`taskKey`, `profileKey`, `state`, `structuredOutput.summary`) | Method exists (`missionCollaboration`), not used by the chat |
| Files produced | `GET /api/v1/orchestrator/missions/:id/artifacts` | Method exists (`missionArtifacts`), not used by the chat |
| Tool-call log, tokens, model, errors | `GET /api/v1/dashboard/runs?limit=100`, filtered on `conversationId` / `missionExternalKey` → `tools[]`, `errors[]`, `metrics` | Used by the Runs screen only |
| Diff | `GET /api/v1/checkpoints/:threadId` and the checkpoint diff endpoint → unified diff, files changed, insertions, deletions | Used by the Worktrees screen only |
| Pending approvals | `GET /api/v1/confirmations` → `id`, `taskId` (the run id), `capability`, `action`, `description`, `riskLevel`, `expiresAt` | **No.** Route exists in `services/api/src/routes/v1/tasks.ts`; no `DashboardApi` method yet |
| Answer an approval | `POST /api/v1/confirmations/:id/respond` `{ decision: "approved" \| "rejected" }` | **No.** `@nexus/client-core` already has `respondToConfirmation` |
| Count waiting | `GET /api/v1/dashboard/overview` → `agentRuns.waitingForConfirmation` | Yes |

### 4.3 What the data does not support, and what the design does about it

Stated plainly so the build does not paper over it:

- **Per-step duration and per-step token counts** are not in the collaboration payload. The step row shows state, title and agent; a duration appears only when a run can be matched to the step. The mission header's totals come from the runs' `metrics` and are always available.
- **Linking a diff to a conversation** depends on the checkpoint `threadId` matching the conversation; this has to be verified in the build. If it does not, diffs stay in Activity → Repositories and the mission card links to them instead of embedding them.
- **"Always allow for this mission"** has no endpoint the dashboard can call. The approval card therefore offers Approve and Decline only. The earlier mock showed that third button; it has been removed from the reference page.
- **Stopping a mission.** The control in the composer today is labelled "Arrêter l'orchestration" but calls `ConversationHistory.stopTracked()`, which only stops the page from following the mission; the agents keep working. Until a cancel call is wired, the control is labelled for what it does — "Ne plus suivre" / "Stop following" — and the mission stays visible as running in Activity. Wiring a real cancel (`POST /api/v1/agent-core/runs/:runId/cancel` exists server-side) is listed in section 12 as a decision for the owner, because it changes what the button does.
- **Streaming.** Answers arrive whole when the mission ends. The design shows progress through the step list, not through streamed text, and makes no use of a typing effect.

### 4.4 Activity

The same information across all conversations. One page, tabs, each a table with the inspector for detail:

| Tab | Content | Source |
| --- | --- | --- |
| Runs (default) | Agent runs: mission, agent, model, state, duration, tokens, tool calls. Select two to compare. Replay from the detail. | `/dashboard/runs`, `/dashboard/runs/compare`, `/dashboard/runs/:id/replay` |
| Tasks | Device and ACP tasks with steps and executions; cancel; graph. | `/dashboard/tasks`, `/tasks/:id/executions`, `/tasks/:id/cancel`, `/dashboard/dag/:id` |
| Approvals | Everything waiting for the user, oldest first: agent confirmations, career confirmations, satellite enrolments. Each row answers in place or links to its Lab. | `/confirmations`, `/career/confirmations`, satellite enrolments |
| Schedules | Autonomous schedules: create, pause, resume, run history. | `/dashboard/mission-control` and its actions |
| Notifications | The inbox; mark as read. | `/dashboard/notifications` |
| Logs | Platform logs with level and search. | `/dashboard/logs` |
| Audit | Security events. | `/dashboard/security` |
| System | Service health table, error rates, latency per agent, recent activity. | `/dashboard/overview`, `/dashboard/observability` |
| Repositories | Worktrees, checkpoints, linked pull requests. | `/worktrees`, `/checkpoints/:threadId`, source-control links |

---

## 5. Other flows

### 5.1 Lab page template

All four Labs use one structure, so learning one teaches the others:

1. **Header (main header row):** Lab name, one real state mark, at most one primary action.
2. **Condition strip (only when needed):** one line stating a blocking condition and its remedy — "Home Assistant non connecté · Configurer". Uses the warning or danger tone, never a decorative banner.
3. **Tabs:** one level, in the content area, at most six, with a "More" menu for overflow.
4. **Content:** panels and tables from the component set. Figures in monospace. No hero, no KPI row that repeats what the table below says.
5. **Approvals for this Lab** are shown where they arise *and* in Activity → Approvals.

### 5.2 Per Lab

| Lab | Tabs | Changes of behaviour-facing structure |
| --- | --- | --- |
| **Career** | Opportunities · Applications · Documents · Calendar · Network · Setup | 11 tabs become 6. Opportunities = Discovery + Comparison (comparison is a mode of the same list). Applications = Kanban + Approvals for this Lab. Network = Contacts & analytics + LinkedIn. Setup = Goals & profile, Settings & feeds, Education pathways, Autonomy. The email `window.prompt` becomes a dialog with a labelled field. |
| **Trading** | Portfolios · Markets · Orders · Risk | The mode (`virtuel` / `réel`) is a permanent mark in the header and in the sidebar. Switching to real money is a tier-3 action (section 8), on the Risk tab, never an inline checkbox. The kill switch is a permanent danger button in the Lab header and acts immediately. The stray "reachable" string becomes a labelled state. |
| **OSINT** | Missions · Enrichment · Evidence · Graph · Monitoring · Reports | The existing seven views (`search`, `active`, `enrichment`, `evidence`, `graph`, `monitoring`, `reports`); `search` and `active` share one Missions tab, as a filter. The launch form moves into a dialog opened by "New mission"; collectors and sources get labels instead of raw identifiers. |
| **Home** | Rooms · Scenes · Satellites · Home Assistant · Fleet · Remote | The existing six. The operating mode (active, silent, night, intercom) is a segmented control in the header, visually distinct from tabs and from filters. Five `window.confirm` calls become confirmation dialogs. |

### 5.3 Settings

One page, a grouped list on the left of the main area, the selected page on the right. Each settings page is a stack of panels: a title, one sentence, the fields, and a footer with Save when the panel is not auto-saved. Dangerous settings sit in a "Danger zone" panel at the bottom of their page with their tier's confirmation.

### 5.4 Usage

One page, four tabs: **Limits** (default: per account, remaining 5-hour and weekly quota as segmented meters, reset times, alert threshold), **Overview** (period selector, totals, tokens per period, by model), **Costs**, **Tokens**. The page title is not repeated in the content. The sidebar readout and the status bar show the lowest remaining quota at all times, so most visits to this page become unnecessary.

---

## 6. States

Every data region uses one of five states, rendered by the same component (`03-design-system.md` §7, `EmptyState` and `Section`). Copy follows the voice rule: state in capitals, then a sentence when the user has to act.

| State | When | What is shown | Example (FR / EN) |
| --- | --- | --- | --- |
| **Loading** | First fetch of a region | Skeleton rows matching the final layout, static. After 400 ms a text label appears; no spinner alone. | `CHARGEMENT · exécutions` / `LOADING · runs` |
| **Refreshing** | Poll or manual refresh with data already shown | Data stays; a 1 px progress line under the region header. Nothing jumps. | — |
| **Empty** | Request succeeded, zero items | One icon, one line, at most one action. Never an illustration. | `AUCUNE EXÉCUTION. Les missions lancées depuis une conversation apparaîtront ici.` / `NO RUNS. Missions started from a conversation will appear here.` |
| **Error** | Request failed | What failed, the server's message when it is safe to show (the API already separates `userMessage`), and Retry. The rest of the page stays usable. | `ÉCHEC · chargement des quotas. Le service usage n'a pas répondu (délai 10 s).` `[Réessayer]` |
| **Not configured** | The feature needs setup | The condition and the one action that fixes it. | `HOME ASSISTANT NON CONNECTÉ. Les appareils apparaîtront une fois la connexion établie.` `[Configurer]` |

Global conditions, shown in the status bar and, when they block work, as a single strip under the main header:

| Condition | Detection | Behaviour |
| --- | --- | --- |
| **Offline** | `navigator.onLine === false`, or two consecutive failed polls | Status bar: `HORS LIGNE · dernière synchro 14:02`. Data stays on screen, marked stale. Actions that write are disabled with a reason; the composer keeps the draft. Polls back off (15 s → 30 s → 60 s) and resume on reconnect. |
| **Session expired** | The session manager's `onSignedOut` | The login screen, with the reason. Drafts in memory are kept for the tab. |
| **Emergency stop active** | `GET /api/v1/pause` → `paused` | A danger strip under the header with the reason and the time; the logo takes its paused form; "Reprendre" asks for confirmation. |
| **Degraded service** | Any `overview.health[]` at `degraded` or `down` | Status bar item in the warning or danger tone, linking to Activity → System. No banner unless the API itself is down. |

---

## 7. Telemetry: what replaces the fake indicators

### 7.1 Removed

| Today | Why it goes |
| --- | --- |
| `CŒUR : NOMINAL` | A constant string in `App.tsx`. |
| `SYNC 100%` | A constant string. |
| "Neural bus activity" bars | A CSS animation with no input. |
| `LIAISON NEURALE NEXUS // RÉPARTITEUR COGNITIF`, `EN LIGNE // EN ATTENTE` | Constant strings in `NexusChat.tsx`. |
| Radar pulse ring, "live" pulse dot | Animations with no input. `API en direct` is replaced by the link item below, which can actually go red. |
| Overview hero chips | Duplicates of the tiles beneath them. |

### 7.2 The status bar

Left to right. Each item is text plus a lamp; the lamp's colour is never the only signal.

| Item | Shows | Source | Refresh |
| --- | --- | --- | --- |
| **Link** | `EN LIGNE` · `HORS LIGNE · dernière synchro hh:mm` · `SESSION EXPIRÉE` | Success or failure of the shared poll; `navigator.onLine`; `SessionManager.onSignedOut` | Every poll |
| **Services** | `SERVICES 5/6` and the name of the worst one when not all are `ok` | `GET /api/v1/dashboard/overview` → `health[]` (`name`, `level`, `detail`) | 15 s |
| **Agents** | `AGENTS 2 EN COURS` or `AGENTS AU REPOS` | `overview.agentRuns.running`, `overview.tasks.running` | 15 s; 5 s while a mission is tracked in the open conversation |
| **Approvals** | `ACCORDS 1` (hidden at zero) — click opens the oldest | `overview.agentRuns.waitingForConfirmation`, then `GET /api/v1/confirmations` for the list | 15 s; 5 s while any is pending |
| **Alerts** | `ALERTES 2` (hidden at zero) | `overview.notifications.unread` | 15 s |
| **Quota** | `QUOTA MIN 43 % · antigravity · réinit. 4 h 59` | `GET /api/v1/usage/quotas` → lowest `remaining5hPercent`, its `provider`, `resets5hAt`; `exhausted` forces the danger tone | 60 s |
| **Visual control** | `CONTRÔLE VISUEL ACTIF` (only while a session is active) | `GET /api/v1/dashboard/visual-control/status` | 15 s, only when the last value was active or the Browser page is open |
| **Emergency stop** (right) | `ARRÊT D'URGENCE` button, or `ARRÊT ACTIF · depuis 14:02 · Reprendre` | `GET /api/v1/pause` → `paused`, `reason`, `since`; `POST /api/v1/pause` | 15 s |

Rules:

- One store (`lib/telemetry.ts`) owns the timers. The status bar, the sidebar badges, the logo and the page title all read from it; nothing else polls these endpoints.
- Polling stops while the tab is hidden (`document.visibilityState`) and resumes with an immediate fetch.
- Each value carries the time it was obtained. A value older than three intervals is shown as stale (`—`) instead of as its last known number.
- The document title mirrors the two things worth a glance from another tab: `(1) NEXUS` when an approval is pending.
- Nothing is animated to suggest activity. The activity lamp blinks only while `agentRuns.running > 0` or a tracked mission is in flight.

### 7.3 State of the logo

The logo's lamp is driven by the same store. Its states, their priority and their drawing are in `03-design-system.md` §6. The state names follow the vocabulary the desktop application already uses for its own indicator (`apps/desktop/src/ui/visual-state.ts`: `idle`, `planning`, `executing`, `waiting`, `error`, `offline`), so the two can share one function later; `paused` and `success` are added.

| State | Shown to the user as | Condition (first match wins) |
| --- | --- | --- |
| `paused` | ARRÊT ACTIF | `pause.paused` |
| `offline` | HORS LIGNE | the link item is offline, or the session has expired |
| `error` | ÉCHEC | any `health[].level === "down"`, or the open conversation's last mission ended in `failed` and has not been viewed |
| `waiting` | ACCORD REQUIS | at least one pending confirmation |
| `executing` | EN COURS | `agentRuns.running > 0`, or a tracked mission in flight |
| `planning` | PRÉPARATION | a message has been sent and no mission state has come back yet |
| `success` | TERMINÉ | for 2 s after a tracked mission reaches `succeeded` |
| `idle` | PRÊT | otherwise |

`planning` is the state the brief calls "thinking". It is named for what is known — a request is out and no plan has come back — because the interface has no view of the model's reasoning and does not pretend to.

---

## 8. Dangerous actions

`window.confirm`, `window.prompt` and `window.alert` are removed (16 call sites). Four tiers replace them. The tier is chosen by what is at stake, not by which screen the action is on.

| Tier | For | Pattern |
| --- | --- | --- |
| **0 · Reversible** | Mark as read, archive, pause a schedule, toggle a plugin | No dialog. The action happens; a toast confirms it with **Annuler** for 6 s where an inverse call exists. |
| **1 · Destructive, contained** | Delete a conversation, room, scene, routine, memory entry, secret, MCP server; revoke a device, token or plugin; disable an agent; disconnect an integration; replay a run | `ConfirmDialog`. Title names the object ("Supprimer la scène « Soirée » ?"). One sentence states the consequence and whether it can be undone. The confirm button carries the verb and the danger tone; **focus starts on Cancel**; `Esc` cancels; `Enter` confirms only when the confirm button has focus. |
| **2 · High impact or outside effect** | Restore a backup; enable real-money trading; submit a real order; change trading credentials; delete an organization | `ConfirmDialog` with **typed confirmation**: the user types the object's name or a fixed word (`RÉEL` / `LIVE`). The dialog shows the risk level, exactly what will happen, and what cannot be undone. The confirm button is disabled until the text matches. |
| **3 · Safety control** | Emergency stop; trading kill switch; visual-control pause | **No dialog in the safe direction**: one activation, immediate, always visible, never disabled by a loading state. The result is announced in the status bar and by a toast. The reverse direction (resume) is tier 1. |

A text request (`window.prompt`, used once for an email address) becomes `PromptDialog`: a labelled field, validation, the same focus rules.

Mapping of today's call sites:

| File | Action | Tier |
| --- | --- | --- |
| `Settings.tsx:1202` | Delete a secret | 1 |
| `Agents.tsx:139`, `:251`, `:405` | Remove or disable an agent or profile | 1 |
| `CareerEducation/index.tsx:173` | Ask for an email address | `PromptDialog` |
| `sections/mcp.tsx:491` | Remove an MCP server | 1 |
| `sections/mcp-oauth.tsx:143` | Disconnect an OAuth provider | 1 |
| `sections/marketplace.tsx:158` | Revoke a plugin | 1 |
| `sections/memory.tsx:135` | Forget a memory | 1 |
| `sections/devices.tsx:731` | Revoke a device | 1 |
| `sections/runs.tsx:20` | Replay a run (tools disabled) | 1, neutral tone — it has no outside effect |
| `sections/domotique-home.tsx:411`, `:1012`, `:1306`, `:2163`, `:2552` | Unlink or delete Home Assistant items, rooms, scenes, routines | 1 |
| `App.tsx` header | Emergency stop / resume | 3 / 1 |
| `sections/trading-console.tsx` | Kill switch; enable production; credentials; submit order | 3; 2; 2; 2 when the mode is real, 0 when virtual |
| `Settings.tsx` backup tab | Restore and apply | 2 |

Rules that apply to every tier:

- A dangerous control never looks like its neighbours: danger tone, an icon, and separation from routine actions.
- The dialog states the object by name. "Are you sure?" is not acceptable copy.
- While the request is in flight the confirm button shows progress and cannot be activated twice.
- On failure the dialog stays open and shows the error; it never closes on an action that did not happen.

---

## 9. Keyboard and command palette

### 9.1 Palette (`Ctrl K` / `Cmd K`)

A dialog with one field and a result list. Typing filters; `↑ ↓` move; `Enter` runs; `Esc` closes and returns focus to where it was.

Result groups, in this order:

1. **Pending** — approvals waiting, as the first results when any exist.
2. **Go to** — every route in section 1.5, including each settings page and each Lab tab.
3. **Conversations** — by title (the list already loaded; server search stays in the sidebar field).
4. **Actions** — New conversation, Emergency stop / Resume, Toggle theme, Switch language, Detect installed CLIs, Refresh, Sign out.

Each result shows its shortcut when it has one. The palette is built from the route table and a registry of actions, so a new page appears in it without extra work.

### 9.2 Shortcuts

Displayed as text keys (`Ctrl`, `Alt`, `Maj`); `Cmd` replaces `Ctrl` on macOS. All remain rebindable in Settings → Shortcuts through the existing `keybindingStore`.

| Keys | Action |
| --- | --- |
| `Ctrl K` | Command palette |
| `Alt N` | New conversation |
| `/` | Focus the composer (when not typing) |
| `Enter` / `Maj Enter` | Send / new line |
| `Alt 1` | Conversations (focus the list) |
| `Alt 2` | Activity |
| `Alt 3` | Usage |
| `Alt 4` … `Alt 7` | Career, Trading, OSINT, Home |
| `Ctrl ,` | Settings |
| `Ctrl B` | Collapse or expand the sidebar |
| `Ctrl .` | Toggle the inspector |
| `Alt A` | Go to the oldest pending approval |
| `A` / `R` | Approve / decline (focus on an approval card) |
| `↑ ↓` or `K J` | Move in a list or table |
| `Enter` | Open the selected row |
| `Esc` | Close the overlay, else leave the detail, else blur the field |
| `?` | Shortcut sheet (when not typing) |

Removed: `Ctrl 1`–`5` (spaces), `Ctrl 0`, `Ctrl =`, `Ctrl -`, `Ctrl Maj O`, window focus and tiling keys. `Alt 1`–`7` are remapped; they previously included three targets that were unreachable or aliased.

The emergency stop has no single-key shortcut on purpose: it is one click in the status bar and three keystrokes through the palette, and an accidental stop interrupts every mission.

### 9.3 Focus

- A visible focus ring on every interactive element (2 px, `--nx-focus`, 2 px offset), including the composer and search fields, which today rely on their container.
- A "Skip to content" link as the first focusable element. Landmarks: `nav` (sidebar), `main`, `complementary` (inspector), `contentinfo` (status bar), each labelled.
- Dialogs trap focus and restore it on close. Tab order follows reading order: sidebar, main, inspector, status bar.
- On route change, focus moves to the page's `h1` and the title is announced; the conversation feed stays an `aria-live="polite"` region, and state changes of a mission are announced once ("Accord requis", "Mission terminée").

---

## 10. Responsive behaviour

The dashboard is a desktop web application; these rules make it usable in a narrow window and at high zoom. They are not the mobile design.

| Width | Sidebar | Inspector | Status bar | Tables |
| --- | --- | --- | --- | --- |
| ≥ 1280 px | 240 px, labels | 360 px, docked when open | All items | Full |
| 960 – 1279 px | 240 px | Overlay drawer from the right | All items; quota shortened to `43 %` | Full, horizontal scroll inside the table's own container when needed |
| 720 – 959 px | 48 px rail of icons; every icon keeps its accessible name and a tooltip; `Ctrl B` expands it as an overlay | Overlay drawer | Link, agents, approvals, stop | First column sticky; low-priority columns hidden behind the row's detail |
| < 720 px | Hidden; a menu button in the main header opens it as a drawer | Full-screen sheet | Lamp, approvals, stop | Rows become stacked records for the main tables (runs, tasks, quotas); others scroll horizontally |

Rules:

- Navigation never disappears. (Today, Lab, Usage and Settings sub-navigation is hidden under 900 px.)
- No horizontal scrolling of the page at any width down to 360 px; only tables and code blocks scroll, inside their own box, with a visible edge fade and keyboard access.
- The composer stays pinned to the bottom of the conversation at every width.
- The emergency stop and the approvals count are present at every width.
- Text is never clipped without a way to read it: truncated cells expose the full value on focus and hover, and in the row detail.

---

## 11. Accessibility requirements

Targets, to be verified in the build, not claims about it:

- WCAG 2.1 AA. Text ≥ 4.5:1, control boundaries and focus ≥ 3:1 (token level: `03-design-system.md` §2).
- Usable at 200 % zoom and at 320 CSS px wide without loss of content or function (1.4.4, 1.4.10) — this is what stands in for a density setting.
- Every state has a text label; colour, lamp and logo are redundant with it.
- Minimum target 24 × 24 px; primary and danger controls ≥ 28 px high.
- `prefers-reduced-motion: reduce` stops every blink and transition; because all animation is CSS (no canvas, no JavaScript timers driving visuals), the media query is sufficient this time.
- Every field has a visible label; placeholders are examples only.
- `lang` is set on `<html>` before first render, from the same source as the language preference.
- No flashing above 1 Hz anywhere (the fastest element is the 1 Hz lamp).

---

## 12. What the build needs that is not in the dashboard client yet

Wiring only; no server change. Listed so it is planned, and so it is visible where the design depends on it.

| Need | Exists server-side | Work |
| --- | --- | --- |
| List pending confirmations | `GET /api/v1/confirmations` | Add `DashboardApi.confirmations()` |
| Answer a confirmation | `POST /api/v1/confirmations/:id/respond` | Add `DashboardApi.respondToConfirmation()` (or call the `@nexus/client-core` method) |
| Mission steps in the conversation | `…/missions/:id/collaboration`, `…/artifacts` | Call the existing methods from the conversation |
| Tool log in the conversation | `/dashboard/runs` | Reuse the existing method with a filter |
| One telemetry store | — | New `lib/telemetry.ts`, replacing the `setInterval` in `App.tsx` |
| Route table with parameters and redirects | — | New `lib/routes.ts` |

Decisions that are **not** design decisions and are left to the owner:

1. **Should "stop" cancel the mission?** A cancel route exists (`POST /api/v1/agent-core/runs/:runId/cancel`, and task cancel). Wiring it changes behaviour. Until decided, the control is labelled "Stop following".
2. **Should approvals offer "always allow for this mission"?** It needs a grant endpoint the dashboard can call. Not designed in until it exists.
3. **Does a checkpoint thread correspond to a conversation?** Decides whether diffs are embedded in the mission card or linked.
