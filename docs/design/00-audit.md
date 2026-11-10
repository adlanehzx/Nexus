# NEXUS web dashboard — Phase 0 audit

Scope: `apps/dashboard` (React + Vite), as served at `http://localhost:8080` on 2026-11-10, at commit `cb0d5cc` (conversation list merged into the main sidebar, PR #39). Mobile and desktop shells are out of scope. No application code was changed.

## How this audit was done, and its limits

| Source | What it gave | Limits |
| --- | --- | --- |
| Static analysis of `apps/dashboard/src` (grep + a counting script) | Debt numbers in section 3 | Counts are occurrences in source, comments stripped. A colour inside a `var(--x, #fff)` fallback is counted as a hard-coded colour. |
| One headless Chromium session (Playwright 1.64, 1440×900, locale `fr-FR`), one login | 39 screenshots in [`screenshots/`](screenshots/), plus a per-screen DOM probe: text contrast, running animations, glow/blur counts, hit-target sizes, inline-styled nodes | See below. |
| Reading the shell and the heaviest screens (`App.tsx`, `NexusChat.tsx`, `PreferencesPanel.tsx`, `parts.tsx`, `theme.css`, `color-themes.css`, `tokens.ts`) | Navigation model, shared components, token usage | The 2,000-line Lab files were sampled, not read line by line. |

Things this audit did **not** verify, stated so nobody assumes otherwise:

- **A conversation with messages was not captured.** Only the empty chat state is in the screenshots; the running-mission, error and long-answer states were assessed from `NexusChat.tsx`, not seen rendered.
- **The setup wizard was not captured** (it only appears on an uninitialised instance). Its numbers come from source.
- **15 screens were looked at as images**; the other classic screens (devices, MCP, browser, memory, notifications, secrets, backup, shortcuts, engine, usage costs/tokens) were assessed from the DOM probe and source only. The inventory marks which is which.
- **The contrast probe is approximate.** It resolves solid backgrounds only; text over a gradient is reported separately as "unresolved" and is not counted as a failure. It therefore under-reports — the unreadable light-theme login card, for instance, is on a gradient and was caught by eye, not by the probe.
- No screen reader pass, no real-user testing, no performance profiling.

---

## 1. Summary

The foundation is better than the surface suggests. `packages/design/src/tokens.ts` ("NEXUS Signal") is a sound, documented token set: a six-step surface ramp, one accent, one liveness colour, status triplets, and text colours that all clear WCAG AA on their own surfaces (measured: body text 16:1, muted 6.2–7.7:1, faint 5.1–6.4:1). The spacing, radius and type scales exist and are generated to CSS.

The problem is that most of the interface does not go through it. A cyberpunk layer was added on top (Orbitron and Rajdhani, glow, a 3D canvas, a typewriter effect on every page title, seven neon accent themes), and the screens were then built largely with inline styles and literal values. In numbers:

- **1,346** inline `style={{…}}` objects in 56 files; **917** literal padding/margin/gap values and **454** literal `fontSize` declarations inside them.
- **259** hard-coded hex colours in `.tsx` (35 distinct) and **44** distinct hex values in the three global stylesheets, whose header comment says a raw colour there "is a bug".
- **Three parallel token vocabularies**: `--nx-*` (187 generated variables), about 35 legacy aliases (`--text`, `--accent`, `--color-muted`, `--radius`…), and 20 `--sp-*` variables for the Spatial shell that are dark-only literals.
- **29 distinct rendered font sizes** across the classic screens, from 9 px to 34 px, against a 9-step scale.
- **Two complete application shells** (Classic and "Spatial OS") with different navigation, fonts and tokens. **15 screens are reachable only from the Spatial shell.**

For an agent platform, the largest UX gap is the conversation itself: a running mission is rendered as one progress bar and a counter. There is no step list, no per-agent state, no log, no diff, and no approval inside the conversation — the things Codex and Claude Code are built around.

There is good news on the hard rules: **no Unicode emoji were found** in the dashboard source, and icons are already SVG. The remaining non-SVG glyphs are arrows, bullets and one multiplication sign (section 3.5).

---

## 2. Inventory

### 2.1 Shell and shared components

| Element | File | Purpose | Problems |
| --- | --- | --- | --- |
| Classic shell | `ui/App.tsx` (1,287 lines) | Sidebar, page header, section router (hash-based) | The sidebar swaps its whole content between four "modes" (supervision / lab / usage / settings); see section 4. The header repeats on every screen and carries three decorative status widgets. |
| Spatial shell | `ui/spatial/*` (13 files, 870-line stylesheet) | Tiling window manager with five "spaces", a command palette, a minimap | A second product inside the first. Own variables (`--sp-*`), own fonts (`system-ui`), dark only. Top bar text overlaps at 1440 px (`50-spatial-dark.png`). |
| Page header | `App.tsx` | Eyebrow, title, description, global actions | Title is retyped letter by letter on every navigation (`CyberRetypeTitle`). "CŒUR : NOMINAL", "SYNC 100%" and the animated "neural bus" bars are hard-coded strings, not telemetry. Emergency stop, refresh and sign-out have the same size and sit side by side. |
| Conversation list | `ui/ConversationSidebar.tsx` | List, search, rename, delete | Works and is keyboard reachable. Only shown in "supervision" mode, so it disappears as soon as a Lab, Usage or Settings is opened. |
| Navigation icons | `App.tsx` `NavIcon` | 28 inline path strings | Duplicates `ui/icons.tsx` (83 icons) with a different stroke width (1.7 vs 1.8). |
| Icon set | `ui/icons.tsx` | 83 stroke icons | 35 more `<svg>` are written inline in 15 other files, with seven different stroke widths (1 to 3). |
| Logo | `ui/NexusLogo.tsx` | N mark | Falls back to a literal `#02E9E9`; the chat avatar and welcome mark use the letter "N" in a box instead of the logo. |
| Primitives | `ui/parts.tsx` | `Metric`, `State`, `Bar`, `Table`, `Empty`, `Section`, `Modal`, `ConfirmModal`, `PromptModal` | Under-used. There is no `Button`, `Input`, `Select`, `Checkbox`, `Tabs`, `Card`, `Badge` or `Tooltip` component: each screen composes class names and inline styles by hand. `ConfirmModal` exists, yet 15 call sites use `window.confirm` / `window.prompt`. |
| Theme switch | `ui/ThemeToggle.tsx`, `lib/theme.ts` | Light / system / dark | Sound. Only shown on the login screen and in Preferences. |
| Accent themes | `lib/color-theme.ts`, `color-themes.css` | Seven accent palettes | Six of the seven are neon by intent ("Matrix Green", "Neon Violet", "Cyber Crimson"). Each carries a `accentGlow` value. To be retired or reduced in the new identity. |
| 3D background | `ui/Futuristic3DCanvas.tsx`, `Futuristic3DCard.tsx` | Animated polyhedron on login, overview, career | Decorative; in the overview it sits behind status chips and lowers their legibility. |
| i18n | `ui/i18n/*` | FR/EN | Two systems side by side: a dictionary (`t("…")`, 19 call sites, 215 EN keys vs 204 FR keys) and inline pairs (`tr("en", "fr")`, 2,647 call sites), plus 36 `locale === "fr"` ternaries. |

### 2.2 Screens

"Seen" = inspected as a screenshot. "Probe" = DOM probe and source only. Inline = `style={{` count in the main file. The last three columns come from the live probe in dark theme.

| Screen (route) | Main file | Purpose and main tasks | Basis | Inline | Inline-styled nodes | Small targets (<24 px) | UX problems and inconsistencies |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| Login | `App.tsx` | Sign in; switch language/theme; start setup | Seen | 3 | 5 | 2 | **Light theme is unreadable**: the card keeps its dark gradient while the text switches to dark ink (`00-login-light.png`). Placeholder made of bullet characters. |
| Setup wizard | `SetupWizard.tsx` (1,836) | First-run install | Source | 123 | — | — | Second-heaviest inline-style file; 40 non-SVG glyphs. Not captured. |
| Chat (`#/chat`) | `NexusChat.tsx` (1,148) | Give a mission, follow it, read the answer | Seen (empty state) | 9 | 23 | 0 | Mission progress is one bar and a counter. No steps, agents, logs, diffs or approvals in the thread. Composer is disabled while a mission runs, so the user cannot queue or redirect. Decorative strip "LIAISON NEURALE NEXUS // RÉPARTITEUR COGNITIF". 11 infinite animations run on an idle screen. Copy button is French-only with a literal `#00ff88`. |
| Overview (`#/overview`, alias `#/tasks`) | `sections/overview.tsx` | Health at a glance | Seen | 7 | 45 | 0 | Hero repeats two of the eight tiles below it. Eight tiles of zeros with equal weight; nothing says what needs attention. Detail column mixes English and French ("no paired workers"). `#/tasks` silently shows this screen. |
| Career & Education | `CareerEducation/*` (14 files) | Track opportunities, compare, prepare applications, approve actions | Seen | 262 total | 77 | 4 | Hero and cards stay dark in light theme: text at 1.16:1. Seven-plus tabs clipped at 1440 px with no overflow affordance. `window.prompt` asks for an email address. Own stylesheet with 49 hex values. |
| Trading Lab | `sections/paper-trading.tsx` (1,772), `trading-console.tsx` | Paper portfolios, simulated orders, risk, kill switch | Seen | 86 | 122 | 17 | Native unstyled `fieldset`, `select` and checkboxes. **The control that enables real-money mode is an ordinary inline checkbox**, and the kill switch is a small outline button. In light theme the NAV and P&L figures render at 1.33–2.19:1. Stray debug string "reachable". 82 hard-coded hex values, the most of any file. |
| OSINT | `OsintWorkspace.tsx` (1,469), `OsintMissionsPanel.tsx` | Launch and follow investigations, manage evidence | Seen | 15 | 40 | 14 | Marketing-style hero on a work screen. Long form with native fieldsets; options shown as raw identifiers (`rdap`, `crt`). |
| Domotique & Satellites | `sections/domotique-home.tsx` (2,782), `domotique.tsx` (2,090) | Rooms and devices, scenes, ESP32 satellites, Fire TV remote | Seen | 243 | 44 | 0 | Mode switches, tabs, filters and the primary action all use the same filled-cyan chip, so they cannot be told apart. Title shown three times. Unstyled native input. The two heaviest files in the app. |
| Usage overview (`#/quota-forecast`) | `sections/quota-forecast.tsx` (1,131) | Tokens, runs, cost per period | Seen | 58 | 15 | 0 | Title duplicated under the header. Glowing gradient bars. KPI tile colours are hard-coded. |
| Limits & resets | same | Remaining quota per provider | Seen | — | 28 | 0 | Table is cut at the right edge with no scroll hint. Raw value "authenticated". This is the most useful screen for daily work and is three clicks from the chat. |
| Costs, Tokens | same | Cost and token breakdowns | Probe | — | 39 / 21 | 0 | Four pages for one topic; could be one page with tabs. |
| Preferences & themes | `PreferencesPanel.tsx` (952) | Shell choice, theme, language, accent | Seen | 68 | 109 | 0 | **Shows "Spatial OS — active" while the Classic shell is running**: it defaults to `spatial` when nothing is stored, `App.tsx` defaults to `classic`. All headings in uppercase Orbitron. |
| Shortcuts | `KeybindingsPanel.tsx` | Rebind keys | Probe | 20 | 158 | 0 | Highest inline-styled node count of the settings pages. |
| Secrets, Backup, Engine | `Settings.tsx` (1,222) | Keys, export/restore, model routing | Probe | 15 | 7 / 7 / 14 | 0–4 | Destructive "delete secret" confirmed with `window.confirm`. |
| Providers & CLIs | `sections/providers.tsx` (1,239) | Detect CLIs, see drivers | Seen | 51 | 193 | 0 | Same information twice (host table, then driver cards). Raw value "connected". |
| Agents & profiles | `Agents.tsx` (1,492) | Configure, test, disable agents | Seen | 39 | 76 | 0 | Agent names in wide uppercase Orbitron. "Disable" has the same weight as "Configure" and "Test". Three `window.confirm`. |
| Devices & network | `sections/devices.tsx` | Pair machines | Probe | 19 | 5 | 0 | — |
| MCP servers | `sections/mcp.tsx`, `mcp-oauth.tsx` | Add servers, OAuth | Probe | 65 | 120 | 0 | — |
| Browser | `sections/browser.tsx` | Controlled Chromium sessions | Probe | 38 | 39 | 1 | 17 hard-coded hex values. |
| Memory | `sections/memory.tsx` | Durable context | Probe | — | 7 | 1 | `window.confirm` on delete. |
| Notifications | `sections/notifications.tsx` | Events needing attention | Probe | 10 | 5 | 0 | Filed under Settings; nothing in the shell shows an unread count. |
| Missions & schedules (`#/mission-control`) | `sections/mission-engine.tsx` (1,003) | Schedule and follow autonomous missions | Seen | 46 | 189 | 0 | Filed under **Settings**. 2,227 DOM nodes and 186 glowing elements on one page. Schedule form has placeholders but no labels. Stray "reachable". |
| Spatial-only screens | `sections/{tasks,runs,tools,workers,security,logs,dag-debugger,run-comparison,marketplace,visual-control,communication-graph,observability,organizations,vcs-worktrees}.tsx`, `Connections.tsx` | Task queue, run traces and pending confirmations, logs, security audit, and so on | Not captured | 135 total | — | — | **Unreachable from the Classic shell.** `runs.tsx` holds "execution traces and pending confirmations", which is the core of an agent product. |

### 2.3 Recurring visual inconsistencies

- **Title case and typeface.** Page titles are mixed-case Orbitron, section headings are uppercase Orbitron with wide tracking, table headers are uppercase Orbitron, body is Rajdhani with `letter-spacing: 0.02em`, data is monospace. Rajdhani is a condensed display face; at 13 px with accents it is tiring to read in French. Orbitron has no lowercase distinction strong enough for long titles ("Que souhaitez-vous accomplir ?" renders as a banner).
- **The fonts named in the tokens are never loaded.** `tokens.ts` declares `Inter var` and `JetBrains Mono`; there is no `@font-face` for either. Only Orbitron and Rajdhani ship. Monospace text therefore depends on what the visitor has installed.
- **Three ways to say "selected"**: a 2 px rail (sidebar), a filled cyan chip (Domotique), a cyan outline with glow (Preferences cards).
- **Status values are shown raw** in several tables: `connected`, `authenticated`, `reachable`, `simulation-seule`, `domain`.
- **KPI tiles** exist in at least four designs (overview, usage, trading, career hero), each with its own padding, label size and accent treatment.
- **Hero banners** on work screens (overview, career, OSINT, domotique) push the first actionable control below the fold at 900 px height.

---

## 3. Design debt, quantified

### 3.1 Inline styles

1,346 `style={{…}}` objects across 56 `.tsx` files, plus 50 `style={variable}`. The stylesheet-based `className=` is used 2,373 times, so roughly one styled element in three bypasses CSS.

| File | Inline styles |
| --- | ---: |
| `sections/domotique-home.tsx` | 129 |
| `SetupWizard.tsx` | 123 |
| `sections/domotique.tsx` | 114 |
| `sections/paper-trading.tsx` | 79 |
| `PreferencesPanel.tsx` | 68 |
| `sections/quota-forecast.tsx` | 58 |
| `sections/mcp-oauth.tsx` | 55 |
| `sections/providers.tsx` | 51 |
| `CareerEducation/OpportunityInbox.tsx` | 48 |
| `sections/mission-engine.tsx` | 46 |
| `CareerEducation/ContactsOutcomesAnalytics.tsx` | 42 |
| `CareerEducation/ApprovalCards.tsx` | 39 |
| `Agents.tsx` | 39 |
| `sections/browser.tsx` | 38 |
| `sections/vcs-worktrees.tsx` | 31 |
| 41 other files | 386 |

The ten heaviest files hold 57 % of the total. Career & Education as a whole (14 files) holds 262.

Inside those objects: 917 literal `padding` / `margin` / `gap` values, 454 `fontSize` declarations (30 distinct values; `0.75rem` ×99, `0.85rem` ×77, `0.8rem` ×60, `0.95rem` ×35), 89 literal `borderRadius` values.

### 3.2 Colours

| Where | Count | Notes |
| --- | ---: | --- |
| Hex colours in `.tsx` | 259 occurrences, 35 distinct | `#10b981` ×42, `#ef4444` ×28, `#00e5ff` ×19, `#00e676` ×17, `#a855f7` ×13. These are Tailwind and Material defaults, not NEXUS tokens. |
| `rgb()/rgba()` literals in `.tsx` | 28 | |
| Hex in the three global stylesheets (7,543 lines) | 44 distinct | `theme.css` 137 occurrences, `career-education.css` 49. |
| `rgba()` literals in all five stylesheets | 272 | `career-education.css` 114, `theme.css` 111, `omarchy-spatial.css` 47. |
| `var(--token, literal)` fallbacks | 352 | Each one is a second source of truth; several were written for a dark canvas and are what breaks the light theme. |
| Files with the most hex | | `paper-trading.tsx` 82, `PreferencesPanel.tsx` 39, `color-theme.ts` 35, `providers.tsx` 17, `mission-engine.tsx` 17, `browser.tsx` 17. |

`theme.css` itself redefines `--nx-success: #10b981` and `--nx-danger: #ef4444` at the top, overriding the generated `--nx-danger` (`#ff7b86` dark, `#b82436` light) with a single value for both themes. On white, `#ef4444` is 3.76:1 and `#10b981` is 2.54:1 — both below AA for text.

### 3.3 Token vocabularies

| Family | Defined in | Count | Status |
| --- | --- | ---: | --- |
| `--nx-*` | `packages/design/tokens.css` (generated) | 187 | The intended single source. |
| `--nx-*` added locally | `theme.css`, `color-themes.css` | ≈ 12 | `--nx-font-display`, `--nx-font-futuristic`, `--nx-success`, `--nx-accent-surface`, `--nx-theme-*`… not in `tokens.ts`. |
| Legacy aliases | `theme.css` l. 4420–4450, `color-themes.css` | ≈ 35 | `--text`, `--muted`, `--accent`, `--border`, `--radius`, `--ok`, `--down`, `--color-*`, `--surface-2`… Several are misleading: `--gradient` maps to the warning colour, `--color-accent` maps to `signal`, not `accent`. |
| `--sp-*` | `spatial/omarchy-spatial.css` | 20 | Dark-only literals; the Spatial shell ignores the light theme. |
| Used but never defined | | 4 | `--nx-text-strong` ×3, `--nx-radius-full` ×2, `--nx-surface-sunken`, `--token`. They silently resolve to their fallback or to nothing. |

### 3.4 Type, spacing, radius

- **Font sizes**: 47 distinct `font-size` values in CSS, 30 in inline styles, **29 distinct sizes actually rendered** on the classic screens (9, 10, 10.4, 10.9, 11, 11.2, 11.5, 12, 12.2, 12.5, 12.8, 13, 13.1, 13.2, 13.6, 14, 14.1, 14.4, 15.2, 16, 16.8, 17.6, 19.2, 19.5, 20, 21.6, 23.2, 26, 34 px) against a nine-step token scale. Text at 9–10 px is used for labels.
- **Radius**: 35 distinct `border-radius` values in CSS against six tokens. The same intent appears as `4px`, `var(--nx-radius-xs)`, `var(--nx-radius-xs, 4px)` and `var(--sp-radius-sm)`. The fallback pattern also disagrees with itself: `var(--nx-radius-lg, 14px)`, `var(--nx-radius-lg, 12px)` and `var(--nx-radius-lg, 10px)` all exist.
- **Uppercase and tracking**: 38 `text-transform: uppercase` rules and 65 `letter-spacing` rules.
- **Effects** in the five stylesheets: 86 `box-shadow` (59 in `theme.css`), 34 `backdrop-filter` (17 in `theme.css`), 26 gradients, 12 `@keyframes`, 10 infinite animations, 18 `!important`. The file header of `theme.css` states that "shadows exist only where something genuinely floats".

### 3.5 Duplicated components

Counted as distinct top-level class families in CSS:

| Pattern | Variants | Examples |
| --- | ---: | --- |
| Button | 28 | `.button`, `.composer-send-btn`, `.kelly-submit-btn`, `.t3-composer-pill-btn`, `.spatial-hud-btn`, `.chat-earlier-btn`, `.equity-filter-btn`… |
| Card / panel / tile | 40 | |
| Badge / chip / pill / tag | 44 | `.badge`, `.status-badge`, `.state-pill`, `.agent-status-badge`, `.quota-metric-badge`, `.lab1-chip`, `.staleness-pill`… |
| Tabs | 5 | `.career-tabs-bar`, `.osint-tabs`, `.setup-wizard-tabs`, `.lab1-subtabs`, plus the settings sub-navigation |
| Modal / drawer | 4 | `.nexus-modal-*`, `.career-modal-*`, `.career-drawer-*`, `.spatial-palette-*` |
| Table | 4 | `.nexus-table`, `.chat-table`, `.comparison-table`, `.lab1-table` |

691 distinct class names in total. The two figures supplied with the brief (16 button and 25 card variants) used a stricter match; the conclusion is the same either way.

### 3.6 Emoji and non-SVG glyphs

- **Unicode emoji: 0** in `.tsx`, `.ts` and `.css` (ranges U+1F000–1FAFF, U+2600–27BF, U+2B00–2BFF checked).
- **Glyphs used as icons or separators**: `•` ×32 (separators and password placeholders), `→` ×8, `↑` ×1, `↓` ×1, `×` ×1, plus two `&middot;` and one `&bull;` entities. The arrows and the multiplication sign should become SVG icons; separators should become CSS.
- `…` ×83 is punctuation in loading labels and is fine.
- The letter "N" in a box stands in for the logo in two places in the chat.
- Not verifiable from source: emoji arriving in data (agent names, model output).

### 3.7 Contrast

Token level (computed from `tokens.ts`): all text colours pass AA on all surfaces. Two gaps:

- `line` and `lineStrong` are 1.25:1 and 1.72:1 against the surface in both themes. Form fields are therefore identified by their fill only, which is below the 3:1 that WCAG 1.4.11 asks of a control boundary.
- `signal` in light theme is 4.44:1 on the canvas and 4.28:1 on a hovered row — just under AA when used as text, which it is (eyebrows, active tabs).

Screen level (probe, solid backgrounds only):

| Screen | Failing text nodes, dark | Failing, light | Worst case |
| --- | ---: | ---: | --- |
| Trading Lab | 2 | **24** | NAV and P&L figures at 1.33:1 and 2.19:1 in light |
| Career & Education | 0 | 2 (+16 unresolved on gradient) | Match score at 1.16:1 in light |
| Login | 2 | 2 | Whole card unreadable in light (gradient, seen by eye) |
| Spatial shell | 14 | 15 | Breadcrumb separators 1.6:1; no light theme |
| Devices | 4 | — | Disabled primary buttons at 2.88:1 |
| Agents | 3 | — | Same |
| Chat | 1 | 1 | Disabled "Send" at 2.2:1 |

The pattern behind most of these: components that hard-code a dark background keep it in light theme while their text follows the theme. Disabled controls are exempt from AA, but a primary button that is illegible until the form is valid is still a usability problem.

### 3.8 Motion

- 8 to 12 infinite animations run on every authenticated screen, including an idle one (pulsing rings, "audio bars", blinking cursor).
- `prefers-reduced-motion` is handled once, globally, by forcing durations to 0.01 ms. That stops CSS animation but not the `<canvas>` background or the JavaScript typewriter title, which are not covered by it.

---

## 4. Navigation and information architecture

### 4.1 What exists

```
Classic shell
├─ Supervision mode   Chat · Overview · conversation list
├─ Lab mode           Domotique · Trading · OSINT · Career          (dock icon 1)
├─ Usage mode         Overview · Limits · Costs · Tokens             (dock icon 2)
└─ Settings mode      4 groups, 13 pages                             (dock icon 3)
      ├─ Interface      Preferences · Shortcuts · Secrets · Backup
      ├─ AI             Providers · Agents · Engines
      ├─ Capabilities   Devices · MCP · Browser
      └─ Data           Memory · Notifications · Missions & schedules

Spatial shell (Ctrl+K, Ctrl+Shift+O, or Preferences)
└─ 5 spaces, command palette, and 15 screens that exist nowhere else
```

### 4.2 Critique

1. **The sidebar is modal.** Opening a Lab, Usage or Settings replaces the entire sidebar, including the conversation list. The way back is a "Supervisor" button, so every excursion costs two clicks and loses the user's place. The three dock icons have no labels (tooltip only) and the first one opens the Trading Lab rather than a list of Labs.
2. **Two shells, two mental models.** The Spatial shell is a different product: other navigation, other fonts, other tokens, no light theme. Ctrl+K in the Classic shell does not open a palette; it switches shell. Fifteen screens — tasks, runs, logs, security, observability, worktrees among them — only exist there.
3. **Operational screens are filed under Settings.** Missions and schedules, Notifications, Memory, Agents and Browser are things the user works with, not preferences.
4. **Agent activity has no home.** There is no place in the Classic shell that answers "what is running, what is waiting for me, what failed". The overview shows counts; the list behind the counts (`runs.tsx`, `tasks.tsx`) is unreachable. `#/tasks` and the Alt+3 shortcut land on the overview.
5. **Approvals are scattered.** They exist per Lab (`CareerEducation/ApprovalCards.tsx`) and in the unreachable Runs screen, and never in the conversation that triggered them. Nothing in the shell shows how many are pending.
6. **Usage is four pages for one question** ("how much do I have left?"), and the answer is not visible while working.
7. **The global header costs 90–110 px on every screen** for a title that the sidebar already states, a description, and decorative status.
8. **Responsive.** Below 900 px the sub-navigation of Lab, Usage and Settings modes is hidden (`.sidebar .nav-group:not(.expanded):not(.nav-primary)`), leaving no way to move between Labs (`41-trading-820-dark.png`).
9. **URLs** are hash routes without parameters: a conversation, a mission or a portfolio cannot be linked or restored on reload, apart from the chat location.
10. **Language.** `index.html` declares `lang="en"` and the attribute is corrected after mount. Page metadata falls back to English text, except two entries that are French only.

### 4.3 Direction for Phase 2 (proposal, to be validated)

One persistent sidebar, no modes:

```
NEXUS
  Search or run a command            Ctrl K
  Conversations                      (the list lives here, always)
  Activity          2                runs, tasks, approvals, schedules, notifications
  Labs
    Career · Trading · OSINT · Home
  ───────────
  Usage             98 % left        one page, tabs inside
  Settings                           preferences, providers, agents, MCP, devices, secrets, backup
```

The conversation becomes the place where tasks, logs, diffs and approvals appear; "Activity" is the same information across all conversations. The Spatial shell is either retired or kept as an optional layout of the same screens, on the same tokens — a decision for the owner (see the questions in `01-identity.md`).

---

## 5. Top 10 UX problems, ranked by impact

Impact = how much it blocks the core job (give agents work, follow it, decide, trust the result) × how many screens it touches.

| # | Problem | Evidence | Why it ranks here |
| --- | --- | --- | --- |
| 1 | **A running mission is opaque.** One progress bar and "n/m tasks"; no steps, no per-agent state, no log, no diff. The composer locks while it runs. | `NexusChat.tsx` `MissionReply` | This is the product's main loop, and the reference tools (Codex, Claude Code) are defined by making it legible. |
| 2 | **Approvals are not where the work is.** No approval in the conversation, no global pending count; the screen that lists them is unreachable in the Classic shell. | `runs.tsx` unrouted; `ApprovalCards.tsx` Lab-only | Human-in-the-loop is the safety model. If the request is hard to find, agents stall or users stop reading what they approve. |
| 3 | **Two shells and a modal sidebar.** 15 screens exist only in the Spatial shell; every Lab, Usage or Settings visit swaps the sidebar and hides the conversations. | Section 4 | Users cannot build a stable map of the product; half of it is hidden behind a keyboard shortcut. |
| 4 | **Light theme is broken on several screens.** Login card, Career hero and cards, Trading figures. | `00-login-light.png`, `03-…-light.png`, `04-…-light.png`; 24 failing nodes on Trading | Light + dark is a hard rule; today light is not usable for sign-in. |
| 5 | **Decoration presented as telemetry.** "CORE: NOMINAL", "SYNC 100%", "neural bus" bars and "ONLINE // STANDBY" are constants. The overview meanwhile reports "degraded". | `App.tsx` header, `NexusChat.tsx` | A supervision tool that shows a green "nominal" next to a degraded service teaches users to ignore its status indicators. |
| 6 | **Dangerous controls look ordinary.** Enabling real-money trading is an inline checkbox in an unstyled fieldset; the kill switch is a small outline button; "Disable agent" matches "Test"; destructive actions use `window.confirm` (15 call sites). | `04-trading-lab-light.png`, `16-agents-dark.png` | Low frequency, highest cost when it goes wrong. |
| 7 | **Legibility of the base typography.** Condensed Rajdhani at 13 px with added tracking for body, uppercase Orbitron for headings, 29 rendered sizes, labels at 9–10 px. | Sections 2.3 and 3.4 | Affects every screen and every minute of use; it is also the main source of the "cyberpunk" feel the owner wants to leave. |
| 8 | **No shared form and control components.** Native unstyled selects, checkboxes and fieldsets next to custom ones; placeholders used as labels; 28 button and 44 badge variants. | Trading, OSINT, Domotique, Missions | Inconsistent behaviour, missing labels for assistive technology, and the root cause of the inline-style debt. |
| 9 | **Constant motion and heavy effects.** 8–12 infinite animations per screen, typewriter title on every navigation, 3D canvas, 86 shadows and 34 backdrop blurs; reduced-motion does not stop the canvas or the typewriter. | Section 3.8 | Distracts from changing data, costs battery, and fails users who ask for reduced motion. |
| 10 | **Mixed and raw language.** FR and EN on the same screen, backend enums shown as-is, two i18n mechanisms, 11 keys missing in FR. | Overview, Providers, Limits; section 2.1 | Lower severity per instance, but it is on most screens and undermines the premium feel. |

Close behind: tables cut off without a scroll hint; hero banners above work content; usage information too far from the conversation; Lab sub-navigation disappearing under 900 px.

---

## 6. Accessibility notes

What is already right: a global `:focus-visible` outline (2 px accent, offset 2 px) that the keyboard walk confirmed on sidebar and list buttons; the composer shows focus through `:focus-within`; 162 `aria-label` and 130 `role` attributes; no unlabeled icon button was found on the screens probed; only 5 click handlers on non-interactive elements; `aria-live` on the chat feed; `role="progressbar"` on mission progress; a three-state theme switch.

What needs work:

- Light-theme contrast failures (section 3.7) and control boundaries below 3:1.
- 9 `outline: none` rules in CSS to review one by one.
- Placeholder-only fields (missions schedule form, OSINT, "new room").
- 14–17 targets under 24 px on Trading and OSINT; 18 in the Spatial shell.
- Status conveyed by a coloured dot plus a raw word; fine in principle, but the word is sometimes untranslated.
- Tooltip-only labels on the three dock buttons (they do have `aria-label`).
- Motion: see 3.8.
- `lang` attribute wrong until React mounts.
- Tab order on the chat screen starts in the composer, then walks the sidebar; there is no skip link and no landmark labels beyond `nav`.

---

## 7. What to keep

- `packages/design` as the single source, its generator, and the test that keeps `tokens.css` in sync. The names are good; Phase 1 keeps them and changes values.
- The principles written at the top of `tokens.ts` and `theme.css`: surfaces as a ramp, one accent for interaction, a separate liveness colour, status never by hue alone, monospace tabular figures. The redesign enforces them rather than replacing them.
- The 2 px rail as the "selected / live" mark.
- The three-state theme preference and the no-persistent-storage rule.
- The SVG icon set as a base (to be redrawn on one grid and one stroke).
- `Section`, `Table`, `Empty`, `Modal` in `parts.tsx` as the seed of the component layer.
- The unified sidebar with conversations from PR #39 — the right direction, to be extended to the other modes.

---

## Appendix — screenshots

All in [`screenshots/`](screenshots/), 1440×900 unless stated, French locale.

| File | Screen |
| --- | --- |
| `00-login-{dark,light}.png` | Login |
| `01-chat-{dark,light}.png` | Chat, empty state |
| `02-overview-{dark,light}.png` | Overview |
| `03-career-education-{dark,light}.png` | Career & Education |
| `04-trading-lab-{dark,light}.png` | Trading Lab |
| `05-osint-{dark,light}.png` | OSINT |
| `06-domotique-{dark,light}.png` | Domotique & Satellites |
| `07-quota-forecast-{dark,light}.png` | Usage overview |
| `08-usage-limits-dark.png`, `09-usage-costs-dark.png`, `10-usage-tokens-dark.png` | Usage sub-pages |
| `11-settings-preferences-{dark,light}.png` | Preferences & themes |
| `12-settings-shortcuts-dark.png`, `13-settings-secrets-dark.png`, `14-settings-backup-dark.png` | Settings |
| `15-providers-dark.png`, `16-agents-dark.png`, `17-settings-engine-dark.png` | AI settings |
| `18-devices-dark.png`, `19-mcp-dark.png`, `20-browser-dark.png` | Capabilities |
| `21-memory-dark.png`, `22-notifications-dark.png`, `23-mission-control-dark.png` | Data & automation |
| `40-chat-820-dark.png`, `41-trading-820-dark.png` | 820 px wide |
| `50-spatial-{dark,light}.png`, `51-spatial-palette-dark.png` | Spatial shell and its command palette |
| `60-chat-focus-dark.png` | Chat after 14 Tab presses |
