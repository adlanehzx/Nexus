# NEXUS web dashboard — Phase 3 specification: the Cadran design system

Scope: `apps/dashboard` and `packages/design`. This is the build specification for the identity chosen in Phase 1 (C · Cadran, pure) and the architecture in [`02-ux-architecture.md`](02-ux-architecture.md). It supersedes the Cadran values printed in `01-identity.md`, which were a proposal; a few were tightened here after an extended contrast check (§2.3).

Visual reference, rebuilt from these exact values: [`directions/c-cadran.html`](directions/c-cadran.html).

## 1. Rules

1. **Graphite and one lamp.** Neutral surfaces, bone text, and a single radium green for what is live, selected or focused. Every other colour is a state.
2. **The primary action is monochrome** (text colour on canvas, inverted). Colour is never spent on a button that is not a warning.
3. **Hard edges.** Radius 0 to 4 px. No pill, no circle.
4. **No shadow, no glow, no blur, no gradient.** Planes are separated by rules.
5. **Labels are monospace capitals; data is monospace; prose is sans.** Three voices, never mixed inside one element.
6. **State is text first.** Icon or shape, label, then colour. The lamp and the logo repeat the label; they never replace it.
7. **Motion is a step, not a glide.** Lamps switch; they do not fade.
8. **Tokens only.** A raw colour, size or duration in a component is a defect, enforced by test (§10.2).

---

## 2. Colour

### 2.1 Semantic tokens

Same names as today's `--nx-*` variables; new values; two additions (`--nx-line-control`, `--nx-focus`). "Worst ratio" is the lowest contrast measured against **all seven surfaces** of the theme (canvas, canvas-sunken, surface, raised, hover, active, overlay), which is stricter than the single-surface figures in Phase 1.

| Group | Variable | Dark | Light | Worst ratio, dark | Worst ratio, light | Target | Role |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| Surface | `--nx-canvas` | `#0C0D0C` | `#EFEFEA` | — | — | — | Page background |
| Surface | `--nx-canvas-sunken` | `#070807` | `#E5E5DF` | — | — | — | Wells: code, diffs, inputs |
| Surface | `--nx-surface` | `#121312` | `#F8F8F4` | — | — | — | Panels, sidebar |
| Surface | `--nx-surface-raised` | `#181A18` | `#FFFFFF` | — | — | — | Panel header strip, status bar |
| Surface | `--nx-surface-hover` | `#1F211F` | `#EAEAE4` | — | — | — | Hovered row or item |
| Surface | `--nx-surface-active` | `#282B28` | `#DFDFD8` | — | — | — | Pressed; selected fill |
| Surface | `--nx-surface-overlay` | `#1B1D1B` | `#FFFFFF` | — | — | — | Menus, dialogs, toasts |
| Line | `--nx-line` | `#262926` | `#D9D9D1` | — | — | — | Divider |
| Line | `--nx-line-strong` | `#383C38` | `#C2C2B8` | — | — | — | Panel edge, table header rule |
| Line | `--nx-line-control` | `#767B76` | `#787870` | 3.32 | 3.32 | 3:1 | **New.** Boundary of inputs and secondary buttons |
| Text | `--nx-text` | `#E8E9E3` | `#141513` | 11.73 | 13.68 | 7:1 | Primary text; fill of the primary button |
| Text | `--nx-text-muted` | `#A9ABA3` | `#4D4F49` | 6.17 | 6.20 | 4.5:1 | Labels, secondary text |
| Text | `--nx-text-faint` | `#93968E` | `#5C5E57` | 4.77 | 4.91 | 4.5:1 | Timestamps, placeholders, line numbers |
| Brand | `--nx-accent` | `#C6EE4F` | `#476100` | 10.74 | 5.27 | 4.5:1 | Focus, links, selection (text-grade) |
| Brand | `--nx-accent-hover` | `#D8F57E` | `#374C00` | 11.79 | 7.14 | 4.5:1 | Accent under the pointer |
| Brand | `--nx-signal` | `#C6EE4F` | `#5E8500` | 10.74 | 3.25 | 3:1 | Lamps, bars, rail (graphic only) |
| Brand | `--nx-focus` | `#C6EE4F` | `#476100` | 10.74 | 5.27 | 3:1 | **New.** Focus ring |
| Brand | `--nx-text-on-accent` | `#10140A` | `#FFFFFF` | 13.98 | 7.05 | 4.5:1 | Text on an accent fill (measured on accent and accent-hover) |
| Status | `--nx-ok` | `#4FD1A5` | `#056B56` | 7.50 | 4.83 | 4.5:1 | Completed, healthy |
| Status | `--nx-warn` | `#F2B544` | `#805200` | 7.82 | 5.02 | 4.5:1 | Pending approval, low quota, degraded |
| Status | `--nx-danger` | `#FF7A70` | `#AE241C` | 5.64 | 5.11 | 4.5:1 | Failure, destructive, emergency stop |
| Status | `--nx-info` | `#8CB8E0` | `#285E94` | 6.85 | 5.03 | 4.5:1 | Neutral information |
| Status | `--nx-neutral` | `#9B9E96` | `#55584F` | 5.27 | 5.42 | 4.5:1 | Queued, cancelled, unknown |
| Risk | `--nx-risk-safe` | `#4ED39A` | `#0B7247` | 8.57 | 4.95 | 4.5:1 | Unchanged from `tokens.ts`; measured on canvas, surface, raised, hover |
| Risk | `--nx-risk-low` | `#6FB5FF` | `#1A5CB8` | 7.51 | 5.32 | 4.5:1 | Unchanged from `tokens.ts`; measured on canvas, surface, raised, hover |
| Risk | `--nx-risk-medium` | `#F0B64E` | `#8A5A00` | 8.88 | 4.91 | 4.5:1 | Unchanged from `tokens.ts`; measured on canvas, surface, raised, hover |
| Risk | `--nx-risk-high` | `#FF9D57` | `#A44A06` | 7.88 | 4.88 | 4.5:1 | Unchanged from `tokens.ts`; measured on canvas, surface, raised, hover |
| Risk | `--nx-risk-critical` | `#FF6F7D` | `#B82436` | 6.04 | 5.20 | 4.5:1 | Unchanged from `tokens.ts`; measured on canvas, surface, raised, hover |

### 2.2 Derived tokens

Computed in CSS from the tokens above, so they cannot drift:

| Variable | Definition | Use |
| --- | --- | --- |
| `--nx-accent-muted` | `color-mix(in srgb, var(--nx-accent) 14%, transparent)` | Selected row, running step |
| `--nx-accent-line` | `color-mix(in srgb, var(--nx-accent) 40%, transparent)` | Border of an accent chip |
| `--nx-signal-muted` | `color-mix(in srgb, var(--nx-signal) 14%, var(--nx-surface))` | Fill of the "running" badge |
| `--nx-{ok,warn,danger,info,neutral}-bg` | status colour 13 % mixed into `--nx-surface`, opaque | Badge and diff-line fill |
| `--nx-{ok,warn,danger,info,neutral}-line` | status colour 32 % mixed into `--nx-surface`, opaque | Badge border |
| `--nx-scrim` | dark `rgb(7 8 7 / 72%)`, light `rgb(20 21 19 / 40%)` | Behind a dialog |
| `--nx-shadow-overlay`, `--nx-shadow-popover` | `none` | Kept as names so existing rules resolve |

The status fills are opaque on purpose: a badge keeps its measured contrast when it sits on a selected or hovered row.

### 2.3 What the check covers

268 pairs, none failing (script output recorded with this document's build):

- every text, brand and status colour against all seven surfaces, per theme;
- `--nx-signal`, `--nx-focus` and `--nx-line-control` at 3:1 against all seven surfaces;
- each status colour on its own fill, and primary text on every status fill (≥ 7:1);
- primary, muted and accent text on the selected-row tint over canvas, surface and raised;
- the inverted primary button (canvas on text: 15.9:1 dark, 15.9:1 light) and its hover (canvas on muted text);
- text on accent, and the five risk hues on canvas, surface, raised and hover.

Changes from the Phase 1 proposal, all to pass this stricter matrix: faint text lightened in dark (`#8C8F87` → `#93968E`) and darkened in light (`#62645D` → `#5C5E57`); control boundary strengthened (`#6A6F6A` → `#767B76`, `#83837A` → `#787870`); three light status colours darkened slightly; and in light theme `--nx-signal` separated from `--nx-accent`.

### 2.4 Usage rules

| Token | Use for | Never for |
| --- | --- | --- |
| `--nx-accent` | Focus ring, links, selected tab underline, the text of a "running" badge | Fills of buttons; body text |
| `--nx-signal` | Lamps, activity marks, progress segments, the selected rail | **Text.** In light theme it is 3.25:1 — a graphic colour only. |
| `--nx-text` on `--nx-canvas`, inverted | The one primary button of a view | More than one button per view |
| `--nx-warn` | Pending approval, quota under threshold, degraded service | Decoration |
| `--nx-danger` | Failure, destructive action, emergency stop | Negative numbers in tables (use a sign) |
| `--nx-ok` | Completed, healthy | "Selected" or "active" (that is accent) |
| `--nx-info` | Neutral information badges | Links (that is accent) |
| `--nx-risk-*` | Risk level of a tool call or approval, with the four-bar mark and the word | Anything else |
| `--nx-text-faint` | Timestamps, placeholders, line numbers | Anything the user must read to act |
| `--nx-line` / `--nx-line-strong` | Dividers; panel and table-header rules | The boundary of an input (use `--nx-line-control`) |

Charts are monochrome first: one series in `--nx-text-muted`, the emphasised or current one in `--nx-signal`. Up to four categories use `--nx-signal`, `--nx-info`, `--nx-neutral`, `--nx-text`, always with direct labels. Beyond four categories, use a table.

---

## 3. Typography

### 3.1 Families

| Token | Family | Files (WOFF2, Latin subset) | Licence |
| --- | --- | --- | --- |
| `--nx-font-sans`, `--nx-font-display` | IBM Plex Sans, variable weight | `ibm-plex-sans-latin-wght-normal.woff2` (≈ 46 kB), `…-italic.woff2` (loaded only when italic text is rendered) | SIL OFL 1.1 |
| `--nx-font-mono` | IBM Plex Mono | `ibm-plex-mono-latin-400`, `-500`, `-600` (≈ 15 kB each) | SIL OFL 1.1 |

Self-hosted in `apps/dashboard/src/assets/fonts/`, `font-display: swap`, fallbacks `ui-sans-serif, system-ui, sans-serif` and `ui-monospace, "SF Mono", Menlo, Consolas, monospace`. The licence text is added to `THIRD_PARTY_NOTICES.md`. Orbitron and Rajdhani files are deleted, together with `--nx-font-futuristic` and the `letter-spacing: 0.02em` on `body`.

Weights in use: 400, 500, 600. Nothing heavier.

### 3.2 Scale — seven sizes

| Token | Size | Was |
| --- | ---: | --- |
| `--nx-size-2xs` | 11 px | 11 |
| `--nx-size-xs` | 12 px | 12 |
| `--nx-size-sm` | 13 px | 13 |
| `--nx-size-md` | 14 px | 14 |
| `--nx-size-lg` | 18 px | 16 |
| `--nx-size-xl` | 22 px | 20 |
| `--nx-size-2xl` | 28 px | 26 |

`--nx-size-3xs` (10 px) and `--nx-size-3xl` (34 px) leave the scale. During the migration they stay defined as aliases of `2xs` and `2xl`, so nothing renders under 11 px from the first day; they are deleted in the cleanup package.

How the 29 sizes rendered today collapse:

| Rendered today (px) | Becomes |
| --- | --- |
| 9, 10, 10.4, 10.9, 11, 11.2, 11.5 | 11 |
| 12, 12.2, 12.5, 12.8 | 12 |
| 13, 13.1, 13.2, 13.6 | 13 |
| 14, 14.1, 14.4, 15.2 | 14 |
| 16, 16.8, 17.6, 19.2, 19.5 | 18 for headings; 14 where it was body text |
| 20, 21.6, 23.2 | 22 |
| 26, 34 | 28 |

### 3.3 Roles

Components use roles, not raw sizes. Each role is one custom property holding a `font` shorthand, used as `font: var(--nx-type-label)`.

| Role token | Family | Size / line | Weight | Tracking, case | Use |
| --- | --- | --- | --- | --- | --- |
| `--nx-type-display` | Sans | 28 / 34 | 500 | −0.012em | Login, empty conversation; at most once per screen |
| `--nx-type-kpi` | Mono | 22 / 26 | 500 | 0, tabular | A key figure |
| `--nx-type-title` | Sans | 18 / 24 | 600 | −0.005em | Settings page title, dialog body heading |
| `--nx-type-heading` | Sans | 14 / 20 | 600 | 0 | Row title, field group |
| `--nx-type-read` | Sans | 14 / 23 | 400 | 0 | Agent answers and user messages; measure ≤ 72ch |
| `--nx-type-body` | Sans | 13 / 20 | 400 | 0 | Interface text |
| `--nx-type-small` | Sans | 12 / 17 | 400 | 0 | Hints, secondary lines |
| `--nx-type-data` | Mono | 12 / 18 | 400 | 0, tabular | Numbers, ids, durations, paths, code |
| `--nx-type-label` | Mono | 11 / 14 | 500 | +0.08em, uppercase | Panel headers, column headers, field group labels, badges |

Rules: uppercase only through the label role, and never on more than about 32 characters. Page titles in the main header use the label role (an instrument names its panels; it does not headline them). French typography in copy: non-breaking space before `: ; ? ! %`, `4 min 12 s`, `18,4 k`, guillemets.

---

## 4. Space, shape, layout

### 4.1 Spacing

Unchanged: `--nx-space-0` … `--nx-space-12` = 0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 56, 72 px. Component padding uses 4–12; gaps between panels 12–16; section rhythm 24–32.

### 4.2 Radius

| Token | Value | Use |
| --- | ---: | --- |
| `--nx-radius-xs` | 0 | Badges, lamps, key caps, checkboxes, switches |
| `--nx-radius-sm` | 2 px | Buttons, inputs, cards |
| `--nx-radius-md` | 3 px | Dialogs, the composer |
| `--nx-radius-lg` | 4 px | The application frame; the largest radius anywhere |

`--nx-radius-xl` and `--nx-radius-pill` are deprecated. During the migration they resolve to 4 px and 0, so legacy pills square off immediately; they are deleted in the cleanup package. Nothing is round.

### 4.3 Borders

| Use | Rule |
| --- | --- |
| Divider inside a panel | 1 px `--nx-line` |
| Panel edge, table header, status bar | 1 px `--nx-line-strong` |
| Input, select, checkbox, switch, composer, secondary button | 1 px `--nx-line-control` (≥ 3:1) |
| Selected rail | 2 px `--nx-signal` on the inline-start edge (`--nx-rail`) |
| Focus | 2 px `--nx-focus` outline, 2 px offset; inside inputs, the border takes `--nx-focus` and the offset is 0 |
| Emphasis by state | The 1 px border takes the status line colour (approval card: `--nx-warn-line`) plus a 2 px rail in the status colour |

### 4.4 Elevation

There is none. Three planes are told apart by fill: `canvas-sunken` (wells: code, diffs, inputs), `surface` (panels), `surface-overlay` (menus, dialogs, toasts). An overlay adds a `--nx-line-control` border and, for dialogs, the scrim.

### 4.5 Layout and density

| Token | Value |
| --- | --- |
| `--nx-sidebar` | 240 px |
| `--nx-sidebar-collapsed` | 48 px |
| `--nx-inspector` (new) | 360 px |
| `--nx-header` | 38 px |
| `--nx-statusbar` (new) | 26 px |
| `--nx-content-max` | 1480 px |
| `--nx-reading-max` | 72ch |
| `--nx-rail` | 2 px |
| `--nx-control-height` (new) | 28 px |
| `--nx-control-height-sm` (new) | 24 px |
| `--nx-row-height` (new) | 30 px |
| `--nx-card-padding` (new) | `var(--nx-space-5)` = 12 px |
| `--nx-target-min` (new) | 24 px |

One density. The three density tokens (`control-height`, `row-height`, `card-padding`) are the only values a future "comfortable" mode would override. Z-index tokens are unchanged.

---

## 5. Motion

| Token | Value | Use |
| --- | --- | --- |
| `--nx-instant` | 0 ms | State changes of lamps, badges, selection |
| `--nx-fast` | 80 ms | Hover and press feedback |
| `--nx-normal` | 120 ms | Disclosure (details, menu) |
| `--nx-slow` | 180 ms | Overlay entry (dialog, drawer, palette) |
| `--nx-ease` | `cubic-bezier(0, 0, 0.2, 1)` | All of the above |
| `--nx-blink` (new) | `1s steps(1) infinite` | The activity lamp |

`--nx-ease-out` is kept as an alias of `--nx-ease` during the migration.

Rules:

- **Lamps switch in steps.** No opacity fade, no colour transition on a state change.
- **At most 1 Hz**, and at most one blinking element per live object (a mission, a quota, the logo).
- **Progress is segmented** (5 px segment, 2 px gap) and advances by steps.
- **Entries only.** An overlay may fade and move 4 px on entry; it disappears without an exit animation.
- **Nothing loops unless something is running.** No ambient animation on an idle screen.
- **All animation is CSS.** No `<canvas>`, no JavaScript timer driving a visual. That is what makes the next rule sufficient.

Reduced motion, in the base stylesheet:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation: none !important;
    transition-duration: 0ms !important;
    scroll-behavior: auto !important;
  }
}
```

With animations off, every state still differs by shape and label: the running step keeps its lamp and rail, the logo keeps its static frame for each state (§6.3).

---

## 6. The state-driven logo

### 6.1 Drawing

An N machined inside an instrument bezel, with one lamp. 32-unit grid, square caps, mitred joins. The N and bezel are `currentColor`; the lamp is `--nx-signal`.

```svg
<svg class="nx-logo" data-state="idle" viewBox="0 0 32 32" role="img" aria-label="NEXUS">
  <rect class="bezel" x="2.75" y="2.75" width="26.5" height="26.5" rx="2.5"/>
  <path class="n" d="M10.5 22.5v-12l10.5 12v-12"/>
  <path class="n-gap" d="M10.5 22.5v-12L14.17 14.69M17.33 18.31 21 22.5v-12"/>
  <path class="seg s1" d="M10.5 22.5v-12"/>
  <path class="seg s2" d="M10.5 10.5 21 22.5"/>
  <path class="seg s3" d="M21 22.5v-12"/>
  <rect class="lamp" x="23.6" y="5.4" width="2.8" height="2.8"/>
  <rect class="lamp-wide" x="20.8" y="5.4" width="5.6" height="2.8"/>
</svg>
```

Bezel stroke 1.5, N stroke 2.5. `.n-gap`, `.seg` and `.lamp-wide` are hidden in the idle state; states reveal them.

**Small cut**, for 20 px and under (sidebar avatar in a message, favicon): heavier strokes and an enlarged lamp seated in the open corner of the bezel, so the lamp is still about 3 px at 16 px.

```svg
<svg class="nx-logo sm" viewBox="0 0 32 32" aria-hidden="true">
  <path class="bezel" d="M19.5 3.5h-14a2 2 0 0 0-2 2v21a2 2 0 0 0 2 2h21a2 2 0 0 0 2-2V12.5"/>
  <path class="n" d="M10 23V11.5L20.5 23V14"/>
  <path class="n-gap" d="M10 23V11.5l3 3.3M17.5 19.7l3 3.3V14"/>
  <path class="seg s1" d="M10 23V11.5"/><path class="seg s2" d="M10 11.5 20.5 23"/><path class="seg s3" d="M20.5 23V14"/>
  <rect class="lamp" x="22.5" y="3" width="6.5" height="6.5"/>
</svg>
```

Bezel stroke 2, N stroke 3.

**Logotype:** NEXUS in IBM Plex Mono Medium, tracking +0.24em, same colour as the N. Lock-up: mark, a gap of one lamp-to-bezel distance × 4, then the word, optically centred. Clear space around the lock-up: the bezel's corner radius × 4. One-colour version: the lamp takes `currentColor`.

### 6.2 States

Inputs and priority are defined in `02-ux-architecture.md` §7.3. The state ids match the desktop application's existing vocabulary.

| State | Label (FR / EN) | Bezel | N | Lamp | Motion |
| --- | --- | --- | --- | --- | --- |
| `idle` | PRÊT / READY | solid | solid | square, `--nx-signal` | none |
| `planning` | PRÉPARATION / PREPARING | solid | solid | square, `--nx-signal` | lamp blinks, 1 Hz, steps |
| `executing` | EN COURS · n / RUNNING · n | solid | the three strokes light in turn in `--nx-signal` | square, `--nx-signal`, steady | 1.2 s cycle, 3 steps |
| `waiting` | ACCORD REQUIS · n / APPROVAL · n | solid | solid | **wide bar**, `--nx-warn` | two short dips every 2 s, steps |
| `error` | ÉCHEC / FAILED | solid | **diagonal broken** in the middle | square, `--nx-danger`, steady | none |
| `offline` | HORS LIGNE / OFFLINE | faint | faint | **hollow** square, faint outline | none |
| `paused` | ARRÊT ACTIF / STOPPED | **dashed**, `--nx-danger` | faint | **hollow** square, `--nx-danger` outline | none |
| `success` | TERMINÉ / DONE | solid | solid | square, `--nx-ok` | none; held 2 s, then `idle` |

Each state has a shape cue that survives the removal of colour: blink, travelling stroke, bar, broken diagonal, hollow lamp, dashed bezel. `idle` and `success` differ by colour only; `success` is a two-second confirmation whose text label ("TERMINÉ") is shown beside it.

### 6.3 Animation rules

```css
.nx-logo[data-state="planning"]  .lamp      { animation: nx-blink 1s steps(1) infinite; }
.nx-logo[data-state="executing"] .seg       { animation: nx-seg 1.2s steps(1) infinite; }
.nx-logo[data-state="executing"] .s2        { animation-delay: .4s; }
.nx-logo[data-state="executing"] .s3        { animation-delay: .8s; }
.nx-logo[data-state="waiting"]   .lamp-wide { animation: nx-double 2s steps(1) infinite; }
@keyframes nx-blink  { 50% { opacity: .2; } }
@keyframes nx-seg    { 0% { opacity: 1; } 33.4%, 100% { opacity: 0; } }
@keyframes nx-double { 0% { opacity: 1; } 70% { opacity: .2; } 78% { opacity: 1; } 86% { opacity: .2; } 94% { opacity: 1; } }
```

- Step timing only. The fastest element changes once per second; the `waiting` dips are two per two seconds. Nothing approaches the three-flashes-per-second limit.
- `error`, `offline`, `paused` never animate. A fault that blinks is an alarm, and alarms are the emergency stop's job.
- **Reduced motion:** all three animations stop. `planning` shows a steady lamp (same frame as `idle`), `executing` shows the diagonal lit, `waiting` shows the steady amber bar. `planning` and `idle` are then told apart by the label alone, which is acceptable because the label is always present.
- **One animated logo per view.** Only the sidebar instance follows the live state. The logo in messages, dialogs and the login screen is static (`idle`).
- State changes are immediate; there is no transition between states.

### 6.4 Accessibility

- The sidebar logo is decorative (`aria-hidden`); the state label next to it is a `role="status"` region and is the accessible carrier.
- State changes are announced once, through that region, in the interface language.
- The document title carries the pending-approval count: `(1) NEXUS`.

### 6.5 Favicon and files

| File | Content |
| --- | --- |
| `public/favicon.svg` | Small cut, `idle`. Ink colour switches with `prefers-color-scheme` inside the SVG; lamp `#C6EE4F` on dark, `#5E8500` on light. |
| `public/favicon-waiting.svg` | Small cut with the amber lamp. |
| `public/favicon-error.svg` | Small cut with the broken diagonal and red lamp. |
| `public/favicon.png` | 32 px fallback of the idle mark. |
| `public/nexus-icon.svg` | Replaced by the normal cut, idle. |

The page swaps the `<link rel="icon">` between the three SVGs when the state enters or leaves `waiting` / `error`. Favicons are never animated. These are the only places a Cadran colour is written as a literal, because an SVG file cannot read the page's custom properties.

### 6.6 Component

```ts
type NexusState = "idle" | "planning" | "executing" | "waiting" | "error" | "offline" | "paused" | "success";

interface NexusLogoProps {
  size?: number;                       // px, default 24
  state?: NexusState;                  // default "idle"
  cut?: "auto" | "normal" | "small";   // "auto": small when size <= 20
  label?: string;                      // sets role="img"; omit for decorative use
  className?: string;
}
```

`nexusState(telemetry): NexusState` lives in `lib/telemetry.ts` and is the single place the priority order is written.

---

## 7. Components

All components live in `apps/dashboard/src/ui/kit/`, one file per component with a co-located stylesheet (`Button.tsx`, `Button.css`). No barrel file: import by path. Every component takes `className`, forwards `ref` where it renders one element, and takes its text from props — the kit contains no user-facing strings except the few defaults noted, which use `tr()`.

Conventions: `tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info"`; `size = "md" | "sm"` (28 / 24 px).

### 7.1 Actions

| Component | Props | Variants and states | Notes |
| --- | --- | --- | --- |
| `Button` | `variant: "primary" \| "secondary" \| "ghost" \| "danger" \| "danger-solid"`, `size`, `icon?`, `kbd?`, `loading?`, `disabled?`, `type` | hover, active, focus, disabled, loading (label kept, lamp added, not re-activable) | One `primary` per view. `danger-solid` only inside a confirmation dialog. Default `type="button"`. |
| `IconButton` | `icon`, `label` (required), `variant: "secondary" \| "ghost"`, `size`, `pressed?` | as Button | `label` becomes `aria-label` and the tooltip. Minimum 24 × 24. |
| `Kbd` | `keys: string[]` | — | Renders text keys (`Ctrl`, `K`); maps `Ctrl` to `Cmd` on macOS. Arrow keys render the arrow icon from the icon set, not a Unicode arrow. |
| `Link` | `href` or `onClick`, `external?` | — | Accent, underlined on hover and focus. External links get an icon and `rel="noreferrer"`. |

### 7.2 Forms

| Component | Props | Notes |
| --- | --- | --- |
| `Field` | `label`, `hint?`, `error?`, `required?`, `children` | Wires `id`, `aria-describedby`, `aria-invalid`. A visible label is mandatory; there is no label-less mode. |
| `Input` | native input props, `mono?`, `prefix?`, `suffix?` | 28 px, `canvas-sunken` fill, `line-control` border. |
| `Textarea` | native props, `autoGrow?` | Same treatment. |
| `Select` | `options`, `value`, `onChange` | Native `<select>`, styled; no custom listbox. |
| `Checkbox` | `checked`, `onChange`, `label`, `indeterminate?` | 16 px square inside a ≥ 24 px label target. |
| `Switch` | `checked`, `onChange`, `label` | `role="switch"`. Square thumb. For settings that apply immediately. |
| `SegmentedControl` | `options`, `value`, `onChange`, `label` | Radio group semantics. For modes (Home operating mode, theme), never for navigation. |
| `FormSection` | `title`, `description?`, `footer?` | A settings panel: label-role title, one sentence, fields, optional Save row. |

### 7.3 Structure

| Component | Props | Notes |
| --- | --- | --- |
| `Panel` | `title?`, `actions?`, `tone?`, `padded?`, `as?` | The card. A 1 px border, an optional header strip with a label-role title. `tone` adds the status line and rail. |
| `PageHeader` | `title`, `state?`, `actions?` | The 38 px main header. Renders the `h1`. |
| `Tabs` | `tabs: {id, label, count?}[]`, `value`, `onChange`, `overflow?: "menu"` | Tablist semantics, arrow-key navigation, 2 px accent underline. More than six tabs collapse into a "More" menu. |
| `SidebarItem` | `icon?`, `label`, `current?`, `badge?`, `readout?`, `lamp?`, `onSelect` | `aria-current="page"` when current: outlined box plus lamp. `badge` is a count in the warning tone; `readout` is monospace text. |
| `ConditionStrip` | `tone`, `title`, `children`, `action?` | The one-line blocking condition under a header. `role="alert"` for danger, `status` otherwise. |
| `KeyValue` | `items: {label, value, mono?}[]`, `columns?` | Label-role keys over values (the "facts" grid of an approval). |
| `Divider`, `Stack`, `Row` | spacing tokens only | Layout primitives, so screens stop writing flex rules inline. |

### 7.4 Data

| Component | Props | Notes |
| --- | --- | --- |
| `Table` | `columns: {id, header, align?, mono?, width?, priority?}[]`, `rows`, `rowKey`, `selected?`, `onSelect?`, `caption`, `empty?`, `sort?`, `density?` | 30 px rows, label-role headers, numeric columns right-aligned monospace. Selected row: accent tint and rail, `aria-current`. Scrolls inside its own container; `priority` decides which columns drop first on narrow widths. Keyboard: arrows, Enter. |
| `Badge` | `tone`, `icon?`, `children` | Label-role text, opaque status fill, 1 px status line. |
| `Status` | `value: "running" \| "waiting" \| "queued" \| "succeeded" \| "failed" \| "cancelled" \| "unknown"`, `label?` | The one mapping from a backend status to icon + label + tone. Replaces `State` in `parts.tsx` and every raw `connected` / `authenticated` cell. Labels in FR and EN. |
| `RiskBadge` | `level: "SAFE" \| "LOW" \| "MEDIUM" \| "HIGH" \| "CRITICAL"` | Four-bar mark, the word, the fixed risk hue. |
| `Lamp` | `tone`, `blink?`, `hollow?` | 7 px square. Decorative; always next to text. |
| `Meter` | `value`, `max?`, `tone?`, `label`, `readout?` | The segmented bar. `role="progressbar"` for progress, `role="meter"` for quotas. Tone switches to warn or danger from thresholds passed by the caller. |
| `Stat` | `label`, `value`, `unit?`, `tone?`, `hint?` | A key figure in the kpi role. Replaces the four tile designs. Used sparingly: never a row of zeros. |
| `CodeBlock` | `code`, `language?`, `copy?`, `prompt?` | `canvas-sunken`, data role, optional copy button. |
| `DiffView` | `diff: string` (unified), `collapsed?`, `maxLines?` | Line numbers, a sign column (`+` / `−` in text colour), status fills. Header shows path and `+n −n`. |
| `Section` | `state: "loading" \| "ready" \| "empty" \| "error" \| "unconfigured"`, `onRetry?`, `children`, `empty?`, `error?` | The data-region wrapper from `parts.tsx`, extended to the five states of `02-ux-architecture.md` §6. |
| `EmptyState` | `icon`, `title`, `children?`, `action?` | Dashed frame, one icon, label-role title, one sentence, at most one action. |
| `Skeleton` | `rows?`, `widths?` | Static bars in `surface-active`. No shimmer. |

### 7.5 Overlays and feedback

| Component | Props | Notes |
| --- | --- | --- |
| `Dialog` | `open`, `onClose`, `title`, `size?`, `footer?`, `initialFocus?` | Native `<dialog>` with focus trap and restore, scrim, `Esc` to close. Replaces the two modal families. |
| `ConfirmDialog` | `open`, `title`, `children`, `confirmLabel`, `tone?: "danger" \| "neutral"`, `typed?: string`, `risk?`, `onConfirm: () => Promise<void>`, `onCancel` | Tiers 1 and 2 of the dangerous-action pattern. Focus starts on Cancel. With `typed`, the confirm button stays disabled until the input matches. Stays open and shows the error if `onConfirm` rejects. |
| `PromptDialog` | `open`, `title`, `label`, `validate?`, `onSubmit`, `onCancel` | Replaces `window.prompt`. |
| `Toast` / `useToast()` | `tone`, `message`, `action?: {label, onAction}`, `duration?` | One region, `role="status"` (`alert` for danger), bottom-right above the status bar, 6 s, pauses on hover and focus. Carries the Undo of tier-0 actions. |
| `Tooltip` | `content`, `children` | On hover and focus, 400 ms delay, never the only carrier of information. |
| `Menu` | `trigger`, `items` | Menu-button semantics. |
| `CommandPalette` | `open`, `onClose`, `groups` | Built from the route table and the action registry. |

### 7.6 Agent work

| Component | Props | Notes |
| --- | --- | --- |
| `MissionCard` | `title`, `agents: string[]`, `state`, `elapsedMs?`, `tokens?`, `steps`, `progress: {done, total}`, `children?` | Header with lamp, agents, elapsed time, tokens; `StepList`; segmented progress with the telegraphic status line; children are the diffs and artifacts. |
| `StepList` | `steps: {id, title, agent?, state, durationMs?, detail?}[]` | An ordered list. States: done (check), running (lamp, outlined row), queued (clock), failed (cross, danger), waiting (shield, warn). A step with `detail` expands to its tool calls. |
| `ToolCallRow` | `tool`, `action`, `risk`, `status`, `durationMs`, `error?` | One line of the log inside a step. |
| `ApprovalCard` | `title`, `risk`, `description`, `command?`, `facts`, `expiresAt`, `state: "pending" \| "approved" \| "rejected" \| "expired"`, `onDecide(decision)`, `runHref?` | Warn line and rail while pending. Approve is the primary button with `A`, Decline secondary with `R`; keys act only while the card has focus. Buttons disable while the request is in flight. Collapses to one line once resolved. The countdown is text and updates once per second without animation. |
| `Composer` | `value`, `onChange`, `onSubmit`, `agentPicker`, `queued?`, `disabledReason?` | Enabled during a mission; shows what a submitted message will do (send now, or queue). `Enter` sends, `Shift Enter` breaks the line. |
| `Message` | `role: "user" \| "nexus"`, `time`, `children`, `actions?` | The read role, 72ch measure. NEXUS messages carry the static small-cut logo. |

### 7.7 Shell

| Component | Props | Notes |
| --- | --- | --- |
| `Shell` | `sidebar`, `inspector?`, `children` | The four regions and their landmarks; the skip link. |
| `StatusBar` / `StatusItem` | `tone?`, `lamp?`, `onSelect?`, `children` | Monospace capitals, 26 px. Items with `onSelect` are buttons. |
| `EmergencyStop` | reads the telemetry store | Immediate stop; Resume opens a `ConfirmDialog`. |
| `Icon` | `name`, `size?: 16 \| 20 \| 24` | The one icon primitive. |

### 7.8 Icons

- One set, in `ui/icons.tsx`, redrawn on a 24 px grid: 1.5 px stroke, square caps, mitred joins, no fill, `currentColor`.
- Rendered at 16 px in controls and rows, 20 px in empty states, 24 px nowhere in dense interface.
- The 28 path strings in `App.tsx` (`NavIcon`) and the 35 inline `<svg>` in other files are replaced by `Icon`.
- An icon never stands alone as the meaning of a state or of a destructive action; it accompanies a label or carries an accessible name.
- Unicode arrows, bullets, check marks and multiplication signs used as icons are replaced. Separators become CSS (`gap` and a 1 px rule) or a real middle dot inside text.

---

## 8. Component tokens

The third tier. Short on purpose: a token exists here only when two components must agree.

| Variable | Value |
| --- | --- |
| `--nx-control-height`, `--nx-control-height-sm` | 28 px, 24 px |
| `--nx-row-height` | 30 px |
| `--nx-card-padding` | `var(--nx-space-5)` |
| `--nx-card-radius` | `var(--nx-radius-sm)` |
| `--nx-button-primary-bg`, `-fg`, `-bg-hover` | `var(--nx-text)`, `var(--nx-canvas)`, `var(--nx-text-muted)` |
| `--nx-focus-ring` | `2px solid var(--nx-focus)` |
| `--nx-icon-stroke`, `--nx-icon-cap`, `--nx-icon-join` | `1.5`, `square`, `miter` |
| `--nx-lamp-size` | 7 px |
| `--nx-meter-segment`, `--nx-meter-gap` | 5 px, 2 px |
| `--nx-type-*` | The nine roles of §3.3 |

---

## 9. `packages/design` and the shared `tokens.ts`

`packages/design/src/tokens.ts` is imported at runtime by the mobile application (`apps/mobile/theme/index.tsx`) and by the desktop application (`apps/desktop/src/lib/theme.ts`), and its generated `tokens.css` is imported by the desktop stylesheet. Neither is part of this redesign. So:

**Cadran is added beside "Signal", not in place of it.**

| File | Change |
| --- | --- |
| `src/tokens.ts` | **Values untouched.** The `Palette` interface gains two optional keys, `lineControl?` and `focus?`. Every existing export keeps its name and value, so mobile and desktop build and look exactly as before. |
| `src/cadran.ts` (new) | Exports `cadran`: `{ palettes, radii, fontSizes, font, motion, layout, components }`, using the same `Palette` type with the two new keys filled. The risk hues are imported from `tokens.ts`, not copied — they are shared with the server log vocabulary and must stay identical across identities. |
| `src/primitives.ts` (new) | Tier 1: the graphite ramp, the radium steps and the status hues as named raw values. Imported by `cadran.ts` only; not exported from the package index and never emitted as CSS. |
| `src/css.ts` | `renderTokensCss(identity)` takes the identity to render. Called with Signal it must produce today's file byte for byte. For Cadran it also emits the derived tokens (§2.2), the component tokens (§8) and a marked block of deprecated aliases (`--nx-size-3xs`, `--nx-size-3xl`, `--nx-radius-xl`, `--nx-radius-pill`, `--nx-weight-bold`, `--nx-ease-out`). |
| `scripts/generate-css.mjs` | Writes `tokens.css` (Signal, unchanged) and `cadran.css`. |
| `package.json` | Adds the exports `./cadran` and `./cadran.css`. |
| `test/tokens.test.ts` | Unchanged; it now also proves Signal did not move. |
| `test/cadran.test.ts` (new) | The generated `cadran.css` matches the committed file; both themes declare every key; and the 268-pair contrast matrix of §2.3 is encoded as assertions, so a future value change that breaks AA fails the build. |

The dashboard switches by changing one import in `ui/theme.css`: `@nexus/design/tokens.css` → `@nexus/design/cadran.css`. Because the variable names are the same, every rule that already uses `var(--nx-surface)` takes the Cadran value at once.

`statusTone`, `statusColor`, `riskColor` and `statusLabel` already take a palette argument; the dashboard passes the Cadran palette where it uses them in TypeScript.

**Retirement.** When mobile and desktop are redesigned, each switches its import to `cadran`; when the last one has, Signal's values are deleted and `cadran` becomes the default export. The token names never change, so that step is an import change per application, not a migration.

**Desktop caveat.** The desktop shell is a separate application with its own `theme.css` (852 lines) and its own state indicator. It keeps Signal and its current look. It will look different from the web dashboard until its own phase; that is the accepted cost of "web first".

---

## 10. Migration plan

### 10.1 Where we start

| Debt | Baseline |
| --- | ---: |
| Inline `style={{` | 1,346 |
| Hex colours in `.tsx` | 259 |
| `rgb()/rgba()` literals in `.tsx` | 28 |
| Native dialogs (`window.confirm` / `prompt`) | 16 |
| `var(--token, literal)` fallbacks | 352 |
| Token vocabularies | 3 (`--nx-*`, ≈ 35 legacy aliases, 20 `--sp-*`) |
| Global stylesheet | `theme.css`, 6,608 lines, shared by every screen |

### 10.2 The ratchet

`apps/dashboard/test/design-debt.test.ts` counts the first four rows above (and the hex and `rgba` literals in the stylesheets, recorded when the test is written) and fails if any count is higher than the number stored in the test. Each package lowers the stored numbers for what it removed, in the same change. The cleanup package sets them to zero.

From the cleanup package onwards the same test also pins the number of `box-shadow`, `text-shadow`, `backdrop-filter`, `filter` and `@keyframes` declarations in stylesheets at their final values, so effects cannot creep back.

One inline style form stays legal and is not counted: passing a dynamic value through a custom property, `style={{ "--nx-value": percent }}`, consumed by a stylesheet rule. That is how a meter gets its width.

### 10.3 Rules that make parallel work possible

1. **`theme.css` is frozen for everyone except the foundation and cleanup packages.** Screen packages do not edit it. They stop using its classes and write what the kit does not cover in a stylesheet co-located with their files. The cleanup package deletes the rules nobody references any more.
2. **Each file has exactly one owner per wave.** The lists below are exhaustive for `apps/dashboard/src`; a file that is not listed is not to be touched.
3. **Screen packages keep their entry points.** They do not rename or delete the files and exported components that `Sections.tsx` and the router import, and they do not change those components' props. Deleting dropped screens is the cleanup package's job.
4. **No package edits `lib/api.ts`, the locale dictionaries or `packages/design`** except the one that owns them. Screens use `tr()` for copy.
5. **No business logic.** A package may change what a component renders and how it is composed. It may not change what is fetched, sent or computed. The three behaviour questions in `02-ux-architecture.md` §12 are out of scope until the owner answers them.
6. **Done means:** no inline style (except the custom-property form), no colour or size literal, no native dialog, every string through `tr()` or the dictionary, both themes checked, a keyboard pass on the package's screens, `typecheck`, `lint` and `vitest` green, ratchet lowered.

### 10.4 Waves

```
Wave 0   F   Foundation                                   1 agent, serial
Wave 1   K1  Kit: actions and forms      ┐
         K2  Kit: structure, data,       │                4 agents in parallel
             overlays                    │
         K3  Icons and logo              │
         D   Data wiring                 ┘
Wave 2   S   Shell                       ┐
         C   Conversation                │
         A   Activity                    │
         U   Usage                       │
         P1  Settings: intelligence      │                11 agents in parallel
         P2  Settings: capabilities      │
         O   Onboarding                  │
         L1  Lab Career                  │
         L2  Lab Trading                 │
         L3  Lab OSINT                   │
         L4  Lab Home                    ┘
Wave 3   Z   Cleanup and verification                     1 agent, serial
```

A wave starts when the previous one is merged. Inside a wave, packages do not depend on each other: wave 2 packages build on the kit and the data layer from wave 1 and are mounted by the existing router until S replaces it, which works because rule 3 keeps their entry points stable.

### 10.5 Packages

Inline-style counts are today's, per package, and sum to 1,346.

#### Wave 0 — F · Foundation

Changes the look of the whole application without touching a screen file.

| | |
| --- | --- |
| **Owns** | `packages/design/**` · `apps/dashboard/src/assets/fonts/**` · `apps/dashboard/src/ui/theme.css` · `apps/dashboard/src/ui/color-themes.css` · `apps/dashboard/src/ui/styles/**` (new: `fonts.css`, `base.css`, `legacy-aliases.css`) · `apps/dashboard/src/lib/color-theme.ts` · `apps/dashboard/src/lib/theme-rgb.ts` · `apps/dashboard/src/lib/theme.ts` · `apps/dashboard/src/main.tsx` · `apps/dashboard/index.html` · `apps/dashboard/public/**` · `apps/dashboard/test/design-debt.test.ts` (new) · `THIRD_PARTY_NOTICES.md` |
| **Also edits, minimally, to keep the build green** | `ui/PreferencesPanel.tsx` (remove the accent-theme section only) · `test/preferences.test.ts` (remove the accent-theme cases) |
| **Does** | Adds Cadran to `packages/design` (§9). Ships IBM Plex, deletes Orbitron and Rajdhani. Points `theme.css` at `cadran.css`; deletes its `--nx-success` / `--nx-danger` overrides. Deletes the accent themes (`color-theme.ts`, `theme-rgb.ts`, the `data-color-theme` blocks); the alias block of `color-themes.css` moves to `styles/legacy-aliases.css` so old rules keep resolving. In `theme.css` only: removes glow shadows, `text-shadow`, `backdrop-filter`, decorative gradients and keyframes, and re-points `--sp-*` at `--nx-*`. Sets `lang` before first render. Adds the ratchet with today's baselines. |
| **Does not** | Touch any screen, restyle any component, or remove `theme.css` rules for classes still in use. |
| **Exit** | The application runs in Cadran colours and type with its old layout. Signal `tokens.css` is byte-identical. Mobile and desktop build unchanged. |

#### Wave 1

| Package | Owns | Does | Inline today |
| --- | --- | --- | ---: |
| **K1 · Kit: actions and forms** | `ui/kit/{Button,IconButton,Kbd,Link,Field,Input,Textarea,Select,Checkbox,Switch,SegmentedControl,FormSection}.{tsx,css}` · `ui/ThemeToggle.tsx` · `ui/i18n/LanguageSwitch.tsx` · `test/kit/forms.test.tsx` | §7.1, §7.2. Rebuilds the theme and language switches on `SegmentedControl`. | 0 |
| **K2 · Kit: structure, data, overlays** | `ui/kit/{Panel,PageHeader,Tabs,SidebarItem,ConditionStrip,KeyValue,Stack,Table,Badge,Status,RiskBadge,Lamp,Meter,Stat,CodeBlock,DiffView,Section,EmptyState,Skeleton,Dialog,ConfirmDialog,PromptDialog,Toast,Tooltip,Menu}.{tsx,css}` · `ui/parts.tsx` · `test/kit/data.test.tsx`, `test/kit/overlays.test.tsx` | §7.3 – §7.5. `parts.tsx` becomes a thin re-export of the kit equivalents (`Metric` → `Stat`, `State` → `Status`, `Bar` → `Meter`, `Modal` → `Dialog`…), so the 28 files importing it keep compiling until their package migrates them. | 4 |
| **K3 · Icons and logo** | `ui/icons.tsx` · `ui/kit/Icon.tsx` · `ui/NexusLogo.tsx` · `ui/kit/NexusLogo.css` · `test/kit/logo.test.tsx` | §6, §7.8. Redraws the icon set to one grid and stroke, keeping every exported name (35 files import it). Implements the eight logo states and both cuts. The favicon files themselves belong to F. | 6 |
| **D · Data wiring** | `lib/api.ts` · `lib/telemetry.ts` (new) · `lib/routes.ts` (new) · `lib/keybindings.ts` (new; the store and helpers moved from `ui/spatial/`, which stays in place until S deletes it) · `lib/format.ts` · `test/telemetry.test.ts`, `test/routes.test.ts`, `test/format.test.ts` | The additive wrappers of `02-ux-architecture.md` §12 (`confirmations`, `respondToConfirmation`). The telemetry store with its cadences, staleness and visibility rules, and `nexusState()`. The route table with parameters and the redirect map from every old hash. No user interface. | 0 |

K1 and K2 share nothing: no barrel file, one stylesheet per component.

#### Wave 2

| Package | Owns | Does | Inline today |
| --- | --- | --- | ---: |
| **S · Shell** | `ui/App.tsx` · `ui/shell/**` (new: `Shell`, `Sidebar`, `StatusBar`, `EmergencyStop`, `CommandPalette`, `Router`, `Login`, `SessionMenu`) · `ui/ConversationSidebar.tsx` · `ui/Sections.tsx` · `ui/PreferencesPanel.tsx` · `ui/KeybindingsPanel.tsx` · `ui/i18n/{context.tsx,index.ts,types.ts}` · `ui/i18n/locales/**` · **deletes** `ui/spatial/**` · `test/{spatial-os,keybindings,preferences,conversation-sidebar,session-persistence,agent-emergency-controls,i18n,dashboard-config}.test.ts` · `e2e/{responsive.e2e.ts,support.ts,seed.ts}` | The single shell of `02-ux-architecture.md` §1: sidebar, header, inspector slot, status bar, palette, shortcuts, responsive rules, focus management. Splits the 1,287-line `App.tsx`. Removes the Spatial shell, the shell-choice preference and the HUD header. Mounts every screen at its new route with the old hashes redirected. | 111 |
| **C · Conversation** | `ui/NexusChat.tsx` · `ui/ChatMessageContent.tsx` · `ui/conversation/**` (new: `MissionCard`, `StepList`, `ToolCallRow`, `ApprovalCard`, `Composer`, `Message`) · `lib/conversations.ts` · `test/{conversation-history,chat-engine-selection}.test.ts` · `e2e/{chat-chain,real-agent-chain}.e2e.ts` | §4 of the architecture: mission card with steps from the collaboration endpoint, tool log from runs, diffs, inline approvals, a composer that stays enabled. Removes the HUD strip and the typewriter title. Labels the stop control for what it does. | 9 |
| **A · Activity** | `ui/sections/{runs,tasks,logs,security,observability,overview,notifications,mission-engine,dag-debugger,run-comparison,vcs-worktrees}.tsx` · `ui/activity/**` (new) · `test/{phase2-supervision,task-executions,system-diagnostics}.test.ts` · `e2e/{missions,observability}.e2e.ts` | The Activity page and its nine tabs, built from the eleven existing screens. Comparison and the task graph become views inside it. The notification channel form is exported separately for P2's settings page. | 158 |
| **U · Usage** | `ui/sections/quota-forecast.tsx` · `lib/usage.ts` · `test/usage.test.ts` · `e2e/usage.e2e.ts` | One page, four tabs, `Meter` for quotas, charts per §2.4. | 58 |
| **P1 · Settings: intelligence** | `ui/Settings.tsx` · `ui/Agents.tsx` · `ui/Connections.tsx` · `ui/sections/providers.tsx` · `e2e/providers.e2e.ts` | Interface is S's; this is Providers (absorbing Connections), Agents, Models, Secrets, Backup. Four native dialogs replaced; backup restore becomes tier 2. | 106 |
| **P2 · Settings: capabilities and data** | `ui/sections/{mcp,mcp-oauth,tools,marketplace,devices,workers,browser,visual-control,memory,organizations}.tsx` · `lib/mcp.ts` · `test/{mcp-hub,device-pairing}.test.ts` · `e2e/{mcp,organizations}.e2e.ts` | Tools (servers, tools, extensions, tokens), Devices and workers, Browser and visual control, Memory, Organization. Five native dialogs replaced. | 145 |
| **O · Onboarding** | `ui/SetupWizard.tsx` · `lib/smoke-test.ts` · `test/{setup-wizard,smoke-test}.test.ts` | The setup wizard on the kit. Same steps. | 123 |
| **L1 · Lab Career** | `ui/CareerEducation/**` · `ui/career-education.css` · `lib/{career-api-client,career-education,lab1-client}.ts` · `test/{career-api-wiring,career-education,lab1-client}.test.ts` | The Lab template; 11 tabs to 6; its approval cards rebuilt on `ApprovalCard`; the email prompt becomes `PromptDialog`. Deletes its two stylesheets' literals. | 262 |
| **L2 · Lab Trading** | `ui/sections/{paper-trading,trading-console}.tsx` · `lib/{paper-trading,trading}.ts` · `test/paper-trading.test.ts` | The Lab template. The mode mark, the kill switch as a tier-3 control, real-money actions as tier 2. | 86 |
| **L3 · Lab OSINT** | `ui/OsintWorkspace.tsx` · `ui/OsintMissionsPanel.tsx` | The Lab template; the launch form in a dialog; labelled collectors and sources. | 15 |
| **L4 · Lab Home** | `ui/sections/{domotique,domotique-home,satellites}.tsx` · `test/{domotique-home,satellites}.test.ts` | The Lab template; the operating mode as a `SegmentedControl`; five native dialogs replaced. The two largest files in the application. | 243 |

Two notes on shared files in this wave:

- `ui/Futuristic3DCanvas.tsx`, `ui/Futuristic3DCard.tsx` and `ui/CyberRetypeTitle.tsx` are imported by S, C, A, P1, O and L1. Each package removes its own imports; nobody deletes the files. Z does.
- `ui/sections/communication-graph.tsx` is the dropped screen. Nobody owns it in this wave; S simply does not route to it.

#### Wave 3 — Z · Cleanup and verification

| | |
| --- | --- |
| **Owns** | Everything, serially, after wave 2 is merged. |
| **Does** | Deletes `Futuristic3DCanvas.tsx`, `Futuristic3DCard.tsx`, `CyberRetypeTitle.tsx`, `sections/communication-graph.tsx` (16 + 4 inline styles) and `styles/legacy-aliases.css`. Purges from `theme.css` every rule whose selector is no longer referenced (by script, reviewed), then splits what is left into `styles/`. Removes the deprecated alias block from `cadran.css` and the 352 literal fallbacks. Sets the ratchet to zero. Re-captures the Phase 0 screenshots in both themes and re-runs the contrast probe and the keyboard walk on every screen. Updates the end-to-end tests and `docs/`. |
| **Exit** | Ratchet at zero. One token vocabulary. No rule in `theme.css` without a user. Every screen captured in dark and light. |

### 10.6 Order of visible change

| After | The user sees |
| --- | --- |
| Wave 0 | Cadran colours and IBM Plex everywhere, the old layout, no glow, no accent themes. |
| Wave 1 | Nothing new: the kit exists but nothing uses it yet, apart from the icons and the logo. |
| Wave 2 | The single shell, the new conversation, and every screen on the kit — arriving package by package. |
| Wave 3 | No visible change; the debt is gone. |

---

## 11. Risks

| Risk | Why it is real | Mitigation |
| --- | --- | --- |
| **Reading fatigue** | 13 px interface text and capital labels; a conversation is long reading. This was Cadran's stated weakness in Phase 1. | The read role (14 / 23, 72ch) for all message text; capitals capped at short labels; layout required to hold at 200 % zoom; density isolated in three tokens so a comfortable mode can follow. Check with real long answers before wave 2 closes. |
| **Sliding back to a HUD** | Cadran is the direction nearest to today's look, and the codebase has a habit of adding effects. | Rules 4 and 7 of §1 are enforced: the ratchet counts shadows, blurs and keyframes in stylesheets once Z has set them, and no animation may be driven from JavaScript. |
| **The light theme as second citizen** | Dark is the reference; the radium green becomes an olive in light. | `--nx-signal` is kept luminous in light and separated from `--nx-accent`; the contrast matrix is a test; every package's "done" includes a light-theme pass; Z captures both themes for every screen. |
| **Wave 0 intermediate state** | Cadran tokens on old layouts will look rough for a while: sharp cards with old spacing, uppercase Plex where Orbitron was. | Accepted and short-lived. Do not ship wave 0 to users alone; treat waves 0 – 2 as one release. |
| **`theme.css` during wave 2** | 6,608 shared lines; a frozen file can still be depended on in surprising ways. | Nobody edits it in wave 2; screens move off its classes; Z purges by reference count, with review, not by hand. |
| **Eleven parallel packages** | Merge order and shared types. | Exhaustive file ownership (§10.5), stable entry points (rule 3), no barrel files, `lib/api.ts` and locales single-owner. |
| **Approvals depend on wiring not yet in the dashboard** | The confirmation endpoints exist server-side but the dashboard has never called them. | Package D lands first and is tested alone; C degrades to "open in Activity" if a confirmation cannot be matched to the open conversation. |
| **The stop control** | Today's label promises a cancellation that does not happen. | Relabelled to what it does until the owner decides on wiring a real cancel. |
| **Three identities at once** | Web in Cadran, desktop and mobile in Signal until their phases. | Stated and accepted (§9). Token names are stable, so their switch is an import change. |
| **Existing tests encode the old shell** | `spatial-os.test.ts`, `keybindings.test.ts`, `preferences.test.ts`, the responsive end-to-end test. | Owned by S, which deletes or rewrites them in the same change that removes what they test. |
