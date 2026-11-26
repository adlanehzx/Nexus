# NEXUS — Phase 1: visual identity proposals

> **Decision (Phase 2).** The owner chose **C · Cadran, pure** — not the hybrid recommended below. Spatial OS, the seven accent themes, Orbitron and Rajdhani are removed. This document is kept as the record of the three proposals. The final Cadran values, which differ slightly from the ones printed here, are in [`03-design-system.md`](03-design-system.md); the structure is in [`02-ux-architecture.md`](02-ux-architecture.md); [`directions/c-cadran.html`](directions/c-cadran.html) has been rebuilt as the visual reference.

Three directions for the web dashboard, all inside the same brief: futuristic, but sober — precise, legible, confident, almost no glow. The name NEXUS stays; the logo is redrawn in each direction.

Each direction has a self-contained page (no network access needed, fonts embedded) that renders the logo, both palettes, the type scale, the icons, the components, a sample application shell and the motion. Open them in a browser and use the theme and language switches in the top bar:

| | Direction | Page | Temperature | Designed first for |
| --- | --- | --- | --- | --- |
| A | **Méridien** | [`directions/a-meridien.html`](directions/a-meridien.html) | Cool, technical | Dark and light equally |
| B | **Vélin** | [`directions/b-velin.html`](directions/b-velin.html) | Warm, editorial | Light |
| C | **Cadran** | [`directions/c-cadran.html`](directions/c-cadran.html) | Neutral dark, instrument panel | Dark |

The sample shell is the same scenario in all three (a security audit of MCP permissions, with one running task and one pending approval), so the pages can be compared side by side. Its data is illustrative.

Read with [`00-audit.md`](00-audit.md): the shell in these pages already applies the navigation proposed there (one persistent sidebar, an Activity entry, approvals inside the conversation).

---

## 1. What all three share

These are not options; they are the brief and the audit turned into rules.

**Colour**

- One brand hue per direction, used for what can be acted on, what is selected and what is live. Everything else is neutral or a status colour.
- The brand hue is never one of the risk hues. The server-side risk scale is green / blue / amber / orange / red (`SAFE` … `CRITICAL`) and stays as it is in `tokens.ts`, so the three brand hues were chosen in the gaps: cyan-azure, ultramarine, yellow-green.
- No glow. No `text-shadow`. `box-shadow` only on layers that float (menu, command palette, dialog), and not at all in Cadran.
- Status is never colour alone: icon or shape + label + colour.
- Every pair below was checked by script against WCAG 2.1: 4.5:1 for text, 7:1 for primary text, 3:1 for control boundaries, focus rings and graphic marks. 67 checks per theme, 402 in total, none failing. The tables give the measured ratios.
- The three rendered pages were then probed in a headless browser, in both themes: 512 to 515 visible text nodes per page, none under 4.5:1; no network request; no horizontal scroll at 390 px. The probe resolves solid backgrounds only, and it measures these pages, not the future application.

**Type**

- No text under 11 px. No uppercase display face. Uppercase is limited to short labels, and only in B and C.
- Numbers, identifiers, durations, paths and code are monospace with tabular figures (already a rule in `tokens.ts`, now actually loaded: today's `JetBrains Mono` is declared but not shipped).
- All fonts are under the SIL Open Font License 1.1 and are self-hosted as WOFF2 (the dashboard's CSP forbids third-party origins). Latin subset with French diacritics and ligatures (œ, é, ç, guillemets).
- French typography is respected in microcopy: non-breaking space before `: ; ? ! %`, `4 min 12 s`, `18,4 k`.

**Icons**

- SVG only, one 24 px grid, `currentColor`, one stroke width per direction, no fills, no two-tone. Sizes 16 and 20 px in the interface.
- No Unicode glyph stands in for an icon (arrows, checks, crosses, bullets). No emoji anywhere, including in empty states and toasts.
- Every icon-only button has an accessible name; icons next to a label are `aria-hidden`.

**Layout and spacing**

- The existing 4 px spacing scale (`--nx-space-0` … `--nx-space-12`) is kept unchanged in all three. Only density tokens differ (control height, row height, card padding).
- Content first: no hero banners on work screens, no page header repeating the sidebar.

**Motion**

- Motion signals a change of state; nothing moves to decorate. At most one continuous animation per live item (the activity indicator).
- `prefers-reduced-motion: reduce` removes every continuous animation and reduces transitions to an opacity change; state is always readable without motion because the label is always present.
- No typewriter effect, no canvas background, no parallax, no animated gradient.

**UX model (from Codex and Claude Code)**

- The conversation is the workspace. A mission renders as a task card with named steps, the agent, elapsed time and token count; logs and diffs open in place.
- An approval is a card in the thread, with the exact command or diff, the risk level, the scope, and keyboard shortcuts. A global count lives in the sidebar.
- Keyboard first: a command palette on `Ctrl K` in the one shell, visible shortcut hints on primary actions, a visible focus ring everywhere.
- Honest status only. Nothing on screen claims a state that is not measured.

**Voice**

- Vouvoiement in French. Sentence case. Buttons are verbs ("Approuver", "Relancer"), never "OK".
- States are named for what they are: "En cours", "En attente d'accord", "Échec". No invented jargon ("neural bus", "cognitive dispatcher") for real system states.
- An error says what failed, why if known, and what can be done next.
- Numbers carry units.

---

## 2. Direction A — Méridien

> Cool, technical, precise. NEXUS as a measuring instrument.

**Rationale.** A grid, one-pixel rules, a single cool hue. The science-fiction character comes from precision — tabular figures, numbered markers, strict alignment — instead of light effects. It is the closest of the three to Codex: neutral, dense, fast to scan, equally at home in light and dark. It is also an evolution of the existing "NEXUS Signal" tokens (same cool ramp, same scales), which makes it the cheapest to migrate to.

References: *Oblivion* (GMUNK's interfaces), *The Expanse*, orbital charts, Linear, Codex.

**Logo.** An N whose diagonal is interrupted by a node — the nexus, the point where paths meet. Monoline, round caps, the node in the brand hue. Wordmark: NEXUS in Geist Semibold, tracked +160.

```svg
<svg viewBox="0 0 32 32" role="img" aria-label="NEXUS">
  <path d="M8 25V7l5.34 6.01M18.66 18.99 24 25V7" fill="none" stroke="currentColor"
        stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="16" cy="16" r="2.2" fill="var(--nx-accent)"/>
</svg>
```

Minimum size 16 px (the node stays visible); clear space = the node's diameter × 2; one-colour version = node in `currentColor`.

**Palette.** Brand hue "ion", a desaturated cyan-azure (hue ≈ 199°).

| Role | CSS variable | Light | Dark | Ratio light | Ratio dark | Measured against | Target |
| --- | --- | --- | --- | ---: | ---: | --- | ---: |
| Surfaces | `--nx-canvas` | `#F3F5F8` | `#0B0E13` | — | — | — | — |
| Surfaces | `--nx-canvas-sunken` | `#E9EDF2` | `#07090D` | — | — | — | — |
| Surfaces | `--nx-surface` | `#FFFFFF` | `#11151C` | — | — | — | — |
| Surfaces | `--nx-surface-raised` | `#FFFFFF` | `#161B24` | — | — | — | — |
| Surfaces | `--nx-surface-hover` | `#EEF1F6` | `#1B212C` | — | — | — | — |
| Surfaces | `--nx-surface-active` | `#E3E8F0` | `#222A37` | — | — | — | — |
| Surfaces | `--nx-surface-overlay` | `#FFFFFF` | `#181E28` | — | — | — | — |
| Lines | `--nx-line` | `#DDE2EA` | `#222A36` | — | — | — | — |
| Lines | `--nx-line-strong` | `#C4CCD8` | `#323C4C` | — | — | — | — |
| Control boundary | `--nx-line-control` | `#7C8798` | `#5F6B7E` | 3.64 | 3.39 | `--nx-surface` | 3:1 |
| Text | `--nx-text` | `#10151D` | `#E6EAF2` | 18.31 | 15.17 | `--nx-surface` | 7:1 |
| Text | `--nx-text-muted` | `#4A5568` | `#A3ADBD` | 7.53 | 8.08 | `--nx-surface` | 4.5:1 |
| Text | `--nx-text-faint` | `#5B6779` | `#8792A5` | 5.74 | 5.82 | `--nx-surface` | 4.5:1 |
| Brand | `--nx-accent` | `#0B6490` | `#74C0E3` | 6.48 | 9.05 | `--nx-surface` | 4.5:1 |
| Brand | `--nx-accent-hover` | `#084F73` | `#93D0EC` | 8.84 | 10.87 | `--nx-surface` | 4.5:1 |
| Brand | `--nx-signal` | `#0B6490` | `#74C0E3` | 6.48 | 9.05 | `--nx-surface` | 4.5:1 |
| Brand | `--nx-text-on-accent` | `#FFFFFF` | `#06131B` | 6.48 | 9.31 | `--nx-accent` | 4.5:1 |
| Focus | `--nx-focus` | `#0B6490` | `#93D0EC` | 6.48 | 10.87 | `--nx-surface` | 3:1 |
| Status | `--nx-ok` | `#0B7048` | `#5FCF9A` | 6.13 | 9.48 | `--nx-surface` | 4.5:1 |
| Status | `--nx-warn` | `#855600` | `#E9B755` | 6.31 | 9.90 | `--nx-surface` | 4.5:1 |
| Status | `--nx-danger` | `#B4233A` | `#F5808A` | 6.48 | 7.26 | `--nx-surface` | 4.5:1 |
| Status | `--nx-info` | `#2F55A0` | `#9DB4E0` | 7.17 | 8.75 | `--nx-surface` | 4.5:1 |
| Status | `--nx-neutral` | `#515D70` | `#98A3B5` | 6.67 | 7.18 | `--nx-surface` | 4.5:1 |

Worst case across canvas, surface, raised and hovered surfaces — light: faint text 5.07, accent 5.73, weakest status colour 5.41, weakest status colour on its own 13 % tint 5.05; dark: faint text 5.14, accent 7.99, weakest status colour 6.34, weakest status colour on its own 13 % tint 5.87. All ≥ 4.5:1.

Derived, not stored: `--nx-accent-muted` = accent at 14 % over the surface; `--nx-accent-line` = accent at 40 %; `--nx-{status}-bg` and `--nx-{status}-line` = status colour at 13 % and 32 % mixed into the surface as an opaque colour, so a badge keeps its contrast when it sits on a selected or hovered row. Risk hues `--nx-risk-*` are unchanged from `tokens.ts`; on this direction's surface and canvas they measure 5.40:1 or more in light and 6.81:1 or more in dark.

**Typography.** Geist for everything, Geist Mono for data (both SIL OFL 1.1, Vercel).

| Role | Family | Size / line | Weight | Tracking |
| --- | --- | --- | --- | --- |
| Display | Geist | 32 / 38 | 600 | −0.022em |
| Title | Geist | 20 / 28 | 600 | −0.012em |
| Heading | Geist | 15 / 22 | 600 | 0 |
| Body (interface) | Geist | 14 / 22 | 400 | 0 |
| Body (reading, agent answers) | Geist | 15 / 25 | 400 | 0 |
| Small | Geist | 12.5 / 18 | 400 | 0 |
| Label | Geist | 12 / 16 | 500 | 0, sentence case |
| Data | Geist Mono | 12.5 / 20 | 400–500 | 0, tabular |

**Icons.** 24 px grid, 1.5 px stroke, round caps and joins.

**Shape and elevation.** Radius 4 / 6 / 8 / 12 px. Controls 32 px high, table rows 36 px, card padding 16 px. No shadow in the page: depth is the surface ramp plus one-pixel rules. Selected item: 2 px rail in the brand hue plus `surface-active`.

**Motion.** 120 ms (immediate feedback), 180 ms (state change), 260 ms (overlay), `cubic-bezier(0.2, 0.8, 0.2, 1)`. Activity indicator: an 8 px dot whose opacity breathes over 1.6 s.

**Voice.** Factual and measured: units, durations, counters.

| Situation | FR | EN |
| --- | --- | --- |
| Empty conversation | Décrivez la mission. NEXUS répartit le travail entre vos agents. | Describe the mission. NEXUS splits the work across your agents. |
| Running | 2 agents au travail · étape 3 sur 5 | 2 agents working · step 3 of 5 |
| Approval | Approbation requise — codex demande à pousser une branche vers le dépôt distant. | Approval required — codex is asking to push a branch to the remote repository. |
| Error | Échec de l'étape 4 : délai dépassé (120 s). | Step 4 failed: timed out (120 s). |
| Success | Mission terminée en 4 min 12 s. | Mission completed in 4 min 12 s. |
| Destructive | Supprimer la conversation ? Cette action est définitive. | Delete this conversation? This cannot be undone. |

**Strengths.** Lowest risk and effort; works for all four Labs, including dense trading and usage tables; both themes equal; ages well.
**Weaknesses.** The least distinctive at first glance — the identity rests on the logo, the ion hue and typographic discipline. Without that discipline it becomes a generic developer tool.

---

## 3. Direction B — Vélin

> Warm, editorial, composed. The logbook of a laboratory from the future.

**Rationale.** Warm paper, deep ink, and one ultramarine for everything that can be acted on. The conversation reads like a document: serif titles, a narrow reading column, data in monospace. It is the most human of the three and the only one designed for the light theme first. Its science fiction is the quiet kind — *Arrival*, *Her*, the white interiors of *2001*.

References: *Arrival*, *Her*, laboratory notebooks, scientific journals, Claude Code's reading comfort.

**Logo.** A high-contrast N — hairline stems, heavy diagonal, in the Didone manner — followed by a full stop in ultramarine: a monogram, a colophon. Wordmark: NEXUS in Newsreader Medium, tracked +90.

```svg
<svg viewBox="0 0 32 32" role="img" aria-label="NEXUS">
  <rect x="5" y="6" width="1.5" height="20" fill="currentColor"/>
  <rect x="20.1" y="6" width="1.5" height="20" fill="currentColor"/>
  <path d="M5 6h4.4l12.2 20h-4.4z" fill="currentColor"/>
  <circle cx="26.6" cy="23.8" r="2.2" fill="var(--nx-accent)"/>
</svg>
```

Minimum size 20 px (below that the hairline stems are thickened to 2 px in a dedicated small cut); the full stop is dropped in the favicon.

**Palette.** Brand hue "outremer", an ultramarine (hue ≈ 235°) on warm neutrals.

| Role | CSS variable | Light | Dark | Ratio light | Ratio dark | Measured against | Target |
| --- | --- | --- | --- | ---: | ---: | --- | ---: |
| Surfaces | `--nx-canvas` | `#F4F1EA` | `#141311` | — | — | — | — |
| Surfaces | `--nx-canvas-sunken` | `#EBE7DD` | `#0F0E0C` | — | — | — | — |
| Surfaces | `--nx-surface` | `#FBF9F4` | `#1B1A17` | — | — | — | — |
| Surfaces | `--nx-surface-raised` | `#FFFFFF` | `#22201C` | — | — | — | — |
| Surfaces | `--nx-surface-hover` | `#EFEBE2` | `#2A2823` | — | — | — | — |
| Surfaces | `--nx-surface-active` | `#E6E1D5` | `#33302A` | — | — | — | — |
| Surfaces | `--nx-surface-overlay` | `#FFFFFF` | `#262420` | — | — | — | — |
| Lines | `--nx-line` | `#E0DBCF` | `#2E2B26` | — | — | — | — |
| Lines | `--nx-line-strong` | `#CBC4B4` | `#403C35` | — | — | — | — |
| Control boundary | `--nx-line-control` | `#8A8371` | `#7A7468` | 3.59 | 3.75 | `--nx-surface` | 3:1 |
| Text | `--nx-text` | `#1B1915` | `#EDE9E0` | 16.68 | 14.36 | `--nx-surface` | 7:1 |
| Text | `--nx-text-muted` | `#55504A` | `#B0A99B` | 7.58 | 7.45 | `--nx-surface` | 4.5:1 |
| Text | `--nx-text-faint` | `#69635A` | `#979081` | 5.65 | 5.49 | `--nx-surface` | 4.5:1 |
| Brand | `--nx-accent` | `#3A46C9` | `#A3ABFF` | 6.88 | 8.14 | `--nx-surface` | 4.5:1 |
| Brand | `--nx-accent-hover` | `#2C36A8` | `#BFC5FF` | 9.07 | 10.48 | `--nx-surface` | 4.5:1 |
| Brand | `--nx-signal` | `#3A46C9` | `#A3ABFF` | 6.88 | 8.14 | `--nx-surface` | 4.5:1 |
| Brand | `--nx-text-on-accent` | `#FFFFFF` | `#101233` | 7.24 | 8.50 | `--nx-accent` | 4.5:1 |
| Focus | `--nx-focus` | `#3A46C9` | `#BFC5FF` | 6.88 | 10.48 | `--nx-surface` | 3:1 |
| Status | `--nx-ok` | `#1F6B45` | `#7CCB9B` | 6.15 | 9.01 | `--nx-surface` | 4.5:1 |
| Status | `--nx-warn` | `#7F5200` | `#E6B865` | 6.42 | 9.45 | `--nx-surface` | 4.5:1 |
| Status | `--nx-danger` | `#AE2B2B` | `#F08A80` | 6.28 | 7.17 | `--nx-surface` | 4.5:1 |
| Status | `--nx-info` | `#2F5F8F` | `#9DB6D9` | 6.33 | 8.39 | `--nx-surface` | 4.5:1 |
| Status | `--nx-neutral` | `#5C564C` | `#A8A193` | 6.90 | 6.78 | `--nx-surface` | 4.5:1 |

Worst case across canvas, surface, raised and hovered surfaces — light: faint text 5.00, accent 6.09, weakest status colour 5.44, weakest status colour on its own 13 % tint 5.09; dark: faint text 4.64, accent 6.89, weakest status colour 5.74, weakest status colour on its own 13 % tint 5.45. All ≥ 4.5:1.

Derived, not stored: `--nx-accent-muted` = accent at 14 % over the surface; `--nx-accent-line` = accent at 40 %; `--nx-{status}-bg` and `--nx-{status}-line` = status colour at 13 % and 32 % mixed into the surface as an opaque colour, so a badge keeps its contrast when it sits on a selected or hovered row. Risk hues `--nx-risk-*` are unchanged from `tokens.ts`; on this direction's surface and canvas they measure 5.23:1 or more in light and 6.48:1 or more in dark.

**Typography.** Newsreader for titles (SIL OFL 1.1, Production Type), Instrument Sans for the interface (SIL OFL 1.1, Instrument), JetBrains Mono for data (SIL OFL 1.1, JetBrains).

| Role | Family | Size / line | Weight | Tracking |
| --- | --- | --- | --- | --- |
| Display | Newsreader | 40 / 44 | 500 | −0.018em |
| Title | Newsreader | 25 / 31 | 500 | −0.01em |
| Heading | Instrument Sans | 16 / 24 | 600 | 0 |
| Body (interface) | Instrument Sans | 15 / 24 | 400 | 0 |
| Body (reading, agent answers) | Instrument Sans | 16 / 27 | 400 | 0 |
| Small | Instrument Sans | 13 / 19 | 400 | 0 |
| Label | Instrument Sans | 11.5 / 16 | 600 | +0.08em, uppercase |
| Data | JetBrains Mono | 13 / 21 | 400–500 | 0, tabular |

Three families instead of two: about 190 kB of WOFF2 against 55 kB for A and 90 kB for C.

**Icons.** 24 px grid, 1.35 px stroke, round caps; an icon always accompanies a label, it never replaces one.

**Shape and elevation.** Radius 3 / 5 / 8 / 14 px. Controls 36 px, table rows 42 px, card padding 20 px — the most generous of the three. In light theme, white cards on ivory with a one-pixel cast shadow; in dark theme, no shadow, only the ramp. Selected item: filled `surface-active`, no rail.

**Motion.** 160 / 240 / 340 ms, `cubic-bezier(0.25, 0.1, 0.25, 1)` — a slower tempo, close to reading. Activity indicator: a ring that widens slowly around the dot (2.4 s). Generated text appears by block, not letter by letter.

**Voice.** Calm and direct, first person: NEXUS says what it is doing and what it needs.

| Situation | FR | EN |
| --- | --- | --- |
| Empty conversation | Sur quoi travaillons-nous aujourd'hui ? | What are we working on today? |
| Running | Je coordonne deux agents — troisième étape sur cinq. | I am coordinating two agents — step three of five. |
| Approval | J'ai besoin de votre accord — codex souhaite pousser une branche vers le dépôt distant. Rien ne part sans votre accord. | I need your approval — codex would like to push a branch to the remote repository. Nothing leaves without your approval. |
| Error | La quatrième étape a échoué : le délai de 120 s est dépassé. Je peux la relancer. | Step four failed: the 120 s time limit was exceeded. I can run it again. |
| Success | C'est terminé — 4 min 12 s. | All done — 4 min 12 s. |
| Destructive | Supprimer cette conversation ? Elle ne pourra pas être récupérée. | Delete this conversation? It cannot be recovered. |

**Strengths.** The best reading experience for long agent answers; the most distinctive and the most "premium" in light theme; far from today's cyberpunk.
**Weaknesses.** The least obviously "science fiction". Lowest density: fewer table rows per screen, which costs on Trading and Usage. A warm paper canvas with a serif is a look other AI products already use, Claude among them; the ultramarine and the monogram are what keep it apart. Heaviest font payload.

---

## 4. Direction C — Cadran

> Dark, dense, instrumental. A flight deck, not a nightclub.

**Rationale.** Neutral graphite, labels in monospace capitals, hard corners, and a single lamp — a radium yellow-green — for what is live or selected. The primary action is monochrome (ink on bone); colour is reserved for state. It is the densest of the three and the one with the most science-fiction character, obtained without a single glow.

References: the Nostromo in *Alien*, Airbus glass cockpits, Braun, Teenage Engineering, terminals.

**Logo.** An N machined inside an instrument bezel, with one indicator lamp. Square caps, mitred joins. Wordmark: NEXUS in IBM Plex Mono Medium, tracked +240.

```svg
<svg viewBox="0 0 32 32" role="img" aria-label="NEXUS">
  <rect x="2.75" y="2.75" width="26.5" height="26.5" rx="2.5" fill="none"
        stroke="currentColor" stroke-width="1.5"/>
  <path d="M10.5 22.5v-12l10.5 12v-12" fill="none" stroke="currentColor"
        stroke-width="2.5" stroke-linecap="square" stroke-linejoin="miter"/>
  <rect x="23.6" y="5.4" width="2.8" height="2.8" fill="var(--nx-accent)"/>
</svg>
```

Minimum size 16 px; at 16 px the lamp is dropped. The lamp may show a state in the application (off / on / blinking while agents run) — the one place the logo is allowed to move.

**Palette.** Brand hue "radium", a yellow-green (hue ≈ 75°) on neutral graphite.

| Role | CSS variable | Light | Dark | Ratio light | Ratio dark | Measured against | Target |
| --- | --- | --- | --- | ---: | ---: | --- | ---: |
| Surfaces | `--nx-canvas` | `#EFEFEA` | `#0C0D0C` | — | — | — | — |
| Surfaces | `--nx-canvas-sunken` | `#E5E5DF` | `#070807` | — | — | — | — |
| Surfaces | `--nx-surface` | `#F8F8F4` | `#121312` | — | — | — | — |
| Surfaces | `--nx-surface-raised` | `#FFFFFF` | `#181A18` | — | — | — | — |
| Surfaces | `--nx-surface-hover` | `#EAEAE4` | `#1F211F` | — | — | — | — |
| Surfaces | `--nx-surface-active` | `#DFDFD8` | `#282B28` | — | — | — | — |
| Surfaces | `--nx-surface-overlay` | `#FFFFFF` | `#1B1D1B` | — | — | — | — |
| Lines | `--nx-line` | `#D9D9D1` | `#262926` | — | — | — | — |
| Lines | `--nx-line-strong` | `#C2C2B8` | `#383C38` | — | — | — | — |
| Control boundary | `--nx-line-control` | `#83837A` | `#6A6F6A` | 3.59 | 3.63 | `--nx-surface` | 3:1 |
| Text | `--nx-text` | `#141513` | `#E8E9E3` | 17.21 | 15.25 | `--nx-surface` | 7:1 |
| Text | `--nx-text-muted` | `#4D4F49` | `#A9ABA3` | 7.80 | 8.02 | `--nx-surface` | 4.5:1 |
| Text | `--nx-text-faint` | `#62645D` | `#8C8F87` | 5.64 | 5.67 | `--nx-surface` | 4.5:1 |
| Brand | `--nx-accent` | `#476100` | `#C6EE4F` | 6.62 | 13.96 | `--nx-surface` | 4.5:1 |
| Brand | `--nx-accent-hover` | `#374C00` | `#D8F57E` | 8.98 | 15.33 | `--nx-surface` | 4.5:1 |
| Brand | `--nx-signal` | `#476100` | `#C6EE4F` | 6.62 | 13.96 | `--nx-surface` | 4.5:1 |
| Brand | `--nx-text-on-accent` | `#FFFFFF` | `#10140A` | 7.05 | 13.98 | `--nx-accent` | 4.5:1 |
| Focus | `--nx-focus` | `#476100` | `#C6EE4F` | 6.62 | 13.96 | `--nx-surface` | 3:1 |
| Status | `--nx-ok` | `#06705A` | `#4FD1A5` | 5.68 | 9.75 | `--nx-surface` | 4.5:1 |
| Status | `--nx-warn` | `#855600` | `#F2B544` | 5.93 | 10.17 | `--nx-surface` | 4.5:1 |
| Status | `--nx-danger` | `#B3261E` | `#FF7A70` | 6.14 | 7.33 | `--nx-surface` | 4.5:1 |
| Status | `--nx-info` | `#285E94` | `#8CB8E0` | 6.32 | 8.91 | `--nx-surface` | 4.5:1 |
| Status | `--nx-neutral` | `#55584F` | `#9B9E96` | 6.81 | 6.85 | `--nx-surface` | 4.5:1 |

Worst case across canvas, surface, raised and hovered surfaces — light: faint text 4.97, accent 5.84, weakest status colour 5.01, weakest status colour on its own 13 % tint 4.71; dark: faint text 4.94, accent 12.15, weakest status colour 5.96, weakest status colour on its own 13 % tint 5.66. All ≥ 4.5:1.

Derived, not stored: `--nx-accent-muted` = accent at 14 % over the surface; `--nx-accent-line` = accent at 40 %; `--nx-{status}-bg` and `--nx-{status}-line` = status colour at 13 % and 32 % mixed into the surface as an opaque colour, so a badge keeps its contrast when it sits on a selected or hovered row. Risk hues `--nx-risk-*` are unchanged from `tokens.ts`; on this direction's surface and canvas they measure 5.11:1 or more in light and 6.94:1 or more in dark.

In this direction the primary button is not filled with the brand hue: it is `text` on `canvas` inverted (measured 15.9:1 in both themes). The radium is kept for focus, selection, links and the activity lamp.

**Typography.** IBM Plex Sans and IBM Plex Mono (SIL OFL 1.1, IBM).

| Role | Family | Size / line | Weight | Tracking |
| --- | --- | --- | --- | --- |
| Display | IBM Plex Sans | 28 / 34 | 500 | −0.012em |
| Title | IBM Plex Sans | 18 / 24 | 600 | −0.005em |
| Heading | IBM Plex Sans | 14 / 20 | 600 | 0 |
| Body (interface) | IBM Plex Sans | 13 / 20 | 400 | 0 |
| Body (reading, agent answers) | IBM Plex Sans | 14 / 23 | 400 | 0 |
| Small | IBM Plex Sans | 12 / 17 | 400 | 0 |
| Label | IBM Plex Mono | 11 / 14 | 500 | +0.08em, uppercase |
| Data | IBM Plex Mono | 12 / 18 | 400–500 | 0, tabular |

**Icons.** 24 px grid, 1.5 px stroke, square caps and mitred joins: panel pictograms, not illustrations.

**Shape and elevation.** Radius 0 / 2 / 3 / 4 px. Controls 28 px, table rows 30 px, card padding 12 px. No shadow anywhere; planes are separated by firm rules and a panel header strip. Selected item: a square lamp plus a strong rule.

**Motion.** 80 / 120 / 180 ms, `cubic-bezier(0, 0, 0.2, 1)`. Lamps change in steps, without fading. Activity indicator: a square lamp blinking at 1 Hz. Progress bars are segmented.

**Voice.** Telegraphic: state in capitals, then the facts, separated by middle dots.

| Situation | FR | EN |
| --- | --- | --- |
| Empty conversation | PRÊT. Saisir une mission. | READY. Enter a mission. |
| Running | EN COURS · 2 agents · étape 3/5 | RUNNING · 2 agents · step 3/5 |
| Approval | ACCORD REQUIS · codex · push d'une branche vers le dépôt distant. | APPROVAL REQUIRED · codex · push a branch to the remote repository. |
| Error | ÉCHEC · étape 4 · délai de 120 s dépassé | FAILED · step 4 · 120 s timeout exceeded |
| Success | TERMINÉ · 4 min 12 s | DONE · 4 min 12 s |
| Destructive | Supprimer la conversation ? Irréversible. | Delete conversation? Irreversible. |

**Strengths.** Strongest identity; highest density (about 20 % more rows than A, 40 % more than B); excellent for monitoring; very little colour to maintain.
**Weaknesses.** 13 px body and capital labels are tiring for long reading, which is what a conversation is. The light theme works and passes AA but is clearly the second citizen. Yellow-green is polarising, and in light theme it becomes an olive. Closest of the three to today's look — the risk of sliding back to a HUD is real.

---

## 5. Side by side

| | A · Méridien | B · Vélin | C · Cadran |
| --- | --- | --- | --- |
| First impression | Precise, quiet | Warm, literate | Technical, dense |
| "Science fiction" read at a glance | Medium | Low | High |
| Reading long answers | Good | Best | Fair |
| Dense tables and monitoring | Good | Fair | Best |
| Light theme | Equal to dark | Best | Acceptable |
| Dark theme | Equal to light | Good | Best |
| Distance from today's cyberpunk | Far | Farthest | Nearest |
| Migration effort from current tokens | Lowest (same ramp temperature, same scales) | Medium (type scale and density change) | Medium (radius and density change) |
| Font payload (WOFF2, Latin) | ≈ 53 kB, 2 files | ≈ 193 kB, 4 files | ≈ 91 kB, 4 files |
| Main risk | Looking generic | Looking like other AI products; density | Fatigue; drifting back to HUD |

---

## 6. Recommendation

**Take A · Méridien as the system, and borrow two things.**

Why A:

1. **It fits the whole product, not one screen.** NEXUS is a conversation, four very different Labs, usage tables and a large settings area. A is the only direction that is comfortable in all of them: B is at its best in the conversation and weakest in tables, C is the reverse.
2. **It matches the stated references.** Codex and Claude Code are calm, neutral, dense, keyboard-led. A is that register; B and C are each a step away from it in opposite directions.
3. **Both themes are first-class**, which is a hard rule. B and C each have a favourite.
4. **It is the cheapest and safest migration.** Same ramp temperature and the same spacing, radius and size scales as today's `tokens.ts`; Phase 3 can start by changing values, and the mobile app that shares the tokens is disturbed least.
5. **It leaves room.** A neutral base can take more character later; a strongly flavoured one is hard to calm down.

What to borrow:

- **From Vélin: the reading column.** Agent answers set at 15–16 px with a 25–27 px line and a 72-character measure, generated text appearing by block. This is typography, not palette, and transfers as is.
- **From Cadran: the instrument vocabulary for live data.** Monospace capital labels on quota gauges and task counters, segmented progress, the step-change lamp. Used only on monitoring surfaces (Activity, Usage, Trading), it gives A the science-fiction accent it otherwise lacks.

What I am less sure of: whether A is distinctive enough for the owner's taste. If the answer to question 3 below is "people should see science fiction immediately", C is the better base and should borrow A's body size and Vélin's reading column. If the product is mostly used in daylight for reading, B deserves a serious look.

### Questions the owner needs to answer

1. **Where and when is NEXUS mostly used** — at night on a dark screen, in daylight, or both equally? (C is dark-first, B light-first, A neutral.)
2. **What takes most of the time**: reading what agents wrote, or watching numbers and states? (B favours the first, C the second.)
3. **How much science fiction should a newcomer see in the first five seconds**, from 1 (a calm professional tool) to 5 (unmistakably a spaceship)? A is about 2, B about 1, C about 4. Today's interface is a 5.
4. **Brand hue**: stay in the cyan family, calmer (A); move to ultramarine (B); or radium yellow-green (C)? Is any of these ruled out?
5. **Accent themes**: the seven user-selectable accents (Matrix Green, Neon Violet…) contradict a single identity. Remove them, or keep one alternative (a monochrome "graphite")?
6. **Spatial OS**: retire it, keep it as an optional window layout of the same screens on the same tokens, or keep it as a separate shell? This changes the Phase 2 scope considerably.
7. **Orbitron and Rajdhani**: agreed to drop both completely, wordmark included?
8. **Density**: one density, or a user setting (comfortable / compact)? A user setting is affordable with the component tokens in section 7.
9. **Voice**: does NEXUS speak in the first person ("Je coordonne deux agents"), impersonally ("2 agents au travail"), or telegraphically? And vouvoiement confirmed?
10. **Mobile and desktop**: will they follow the same identity, and when? `tokens.ts` is shared with the mobile app, so this decides whether the new palette replaces the old one or lives beside it for a while.
11. **Mixing**: is the hybrid recommended above acceptable, or should the identity be one direction, pure?

---

## 7. Token architecture

### 7.1 Principle

Three tiers. A component may only reference the tier directly above it.

```
Tier 1 · primitives      raw values, named for what they are      slate-900, ion-400, space-4
        ↓ referenced by
Tier 2 · semantic        named for their role, theme-dependent    --nx-surface, --nx-text-muted, --nx-accent
        ↓ referenced by
Tier 3 · component       named for a component part               --nx-button-primary-bg, --nx-row-height
```

- **Tier 1 lives in TypeScript only** and is not emitted as CSS variables. If `--nx-slate-900` does not exist in the browser, no screen can use it by mistake. This is the strict reading of the sentence already at the top of `tokens.ts`: it is "the only place in the monorepo where a raw colour … is allowed to exist".
- **Tier 2 is today's `Palette` interface and `--nx-*` variables, with the same names.** This is the important decision: Phase 3 changes values first and renames nothing, so every rule that already uses `var(--nx-surface)` follows the new identity on day one.
- **Tier 3 is new**, small, and where the three directions differ in structure rather than in colour (for example Cadran's monochrome primary button).

### 7.2 Tier 1 — primitives (new, `packages/design/src/primitives.ts`)

```ts
export const primitives = {
  color: {
    slate:  { 0: "#FFFFFF", 50: "#F3F5F8", 100: "#E9EDF2", /* … */ 900: "#11151C", 950: "#0B0E13", 1000: "#07090D" },
    ion:    { 300: "#93D0EC", 400: "#74C0E3", 700: "#0B6490", 800: "#084F73" },
    green:  { 400: "#5FCF9A", 700: "#0B7048" },
    amber:  { 400: "#E9B755", 700: "#855600" },
    red:    { 400: "#F5808A", 700: "#B4233A" },
    blue:   { 400: "#9DB4E0", 700: "#2F55A0" },
    risk:   { /* unchanged, shared with the server log vocabulary */ },
  },
  space:  { /* today's `spacing`, unchanged */ },
  radius: { /* today's `radii`, values per direction */ },
  size:   { /* today's `fontSizes` */ },
  font:   { sans: "Geist", mono: "Geist Mono", display: "Geist" },
  duration: { instant: 90, fast: 120, normal: 180, slow: 260 },
} as const;
```

(Values shown for direction A.)

### 7.3 Tier 2 — semantic (existing names; three additions, some removals)

| `Palette` key (`tokens.ts`) | CSS variable | Change |
| --- | --- | --- |
| `canvas`, `canvasSunken` | `--nx-canvas`, `--nx-canvas-sunken` | Value only |
| `surface`, `surfaceRaised`, `surfaceHover`, `surfaceActive`, `surfaceOverlay` | `--nx-surface…` | Value only |
| `scrim` | `--nx-scrim` | Value only |
| `line`, `lineStrong` | `--nx-line`, `--nx-line-strong` | Value only; become solid colours |
| **`lineControl`** | **`--nx-line-control`** | **New.** Boundary of inputs, checkboxes and switches, ≥ 3:1 on every surface (WCAG 1.4.11). Today no line token reaches 3:1. |
| `text`, `textMuted`, `textFaint`, `textOnAccent` | `--nx-text…` | Value only |
| `accent`, `accentHover`, `accentMuted`, `accentLine` | `--nx-accent…` | Value only; `muted` and `line` derived with `color-mix` from `accent` |
| `signal`, `signalMuted` | `--nx-signal…` | Kept as a separate role. In all three directions it has the same value as `accent`; the role is expressed by shape and motion. Keeping the token lets a later version separate them without touching components. |
| **`focus`** | **`--nx-focus`** | **New.** Focus-ring colour, ≥ 3:1 on every surface. |
| `ok`, `warn`, `danger`, `info`, `neutral` (`fg`, `bg`, `line`) | `--nx-ok`, `--nx-ok-bg`, `--nx-ok-line`, … | Value only. `info` moves away from the accent hue so that "informational" and "clickable" stop sharing a colour (today `#78b4ff` vs `#5b9dff`). |
| `risk.*` | `--nx-risk-*` | Unchanged |
| `shadowOverlay`, `shadowPopover` | `--nx-shadow-*` | Value only (`none` in Cadran) |
| `font.sans`, `font.mono` | `--nx-font-sans`, `--nx-font-mono` | Value only |
| **`font.display`** | **`--nx-font-display`** | **Moves into `tokens.ts`.** Today it is defined in `theme.css` as Orbitron. |
| `font.size.*`, `weight.*`, `leading.*`, `tracking.*` | `--nx-size-*`, … | Names unchanged; `3xs` (10 px) is removed from use and then from the scale |
| `space.*`, `radius.*` | `--nx-space-*`, `--nx-radius-*` | Space unchanged; radius values per direction |
| `motion.*` | `--nx-instant`, `--nx-fast`, `--nx-normal`, `--nx-slow`, `--nx-ease`, `--nx-ease-out` | Value only |
| `layout.*`, `zIndex.*` | `--nx-sidebar`, `--nx-z-*`, … | `--nx-header` is retired with the page header |

Variables to remove, with their replacement (all are local additions outside `tokens.ts` or aliases):

| Remove | Replace with |
| --- | --- |
| `--nx-success` (literal `#10b981` in `theme.css`) | `--nx-ok` |
| `--nx-danger` override (literal `#ef4444` in `theme.css`) | the generated `--nx-danger` |
| `--nx-font-futuristic` | `--nx-font-sans` |
| `--nx-font-heading` | `--nx-font-display` |
| `--nx-accent-surface` | `--nx-accent-muted` |
| `--nx-text-primary`, `--text` | `--nx-text` |
| `--nx-text-subtle` | `--nx-text-faint` |
| `--nx-text-strong` (never defined) | `--nx-text` |
| `--nx-muted`, `--muted`, `--muted-text`, `--color-muted` | `--nx-text-muted` |
| `--nx-surface-sunken` (never defined), `--code-bg`, `--elevated-background` | `--nx-canvas-sunken` |
| `--surface-2`, `--color-bg-subtle` | `--nx-surface-hover` |
| `--surface-3` | `--nx-surface-active` |
| `--border`, `--border-color`, `--border-subtle` | `--nx-line` |
| `--accent`, `--bright-accent`, `--soft-accent` | `--nx-accent`, `--nx-accent-hover`, `--nx-accent-muted` |
| `--accent-color`, `--color-accent`, `--color-brand-cyan` | `--nx-accent` (they point at `signal` today; same value after the change) |
| `--ok`, `--success`, `--color-success` | `--nx-ok` |
| `--warn`, `--warning`, `--color-warning`, `--gradient` | `--nx-warn` |
| `--danger`, `--down`, `--color-error`, `--color-danger` | `--nx-danger` |
| `--radius`, `--nx-radius-full` (never defined) | `--nx-radius-sm`, `--nx-radius-pill` |
| `--nx-theme-accent-*`, `--nx-theme-signal-*`, `data-color-theme` | removed with the accent themes (pending question 5) |
| `--sp-bg-deep`, `--sp-bg-canvas` | `--nx-canvas-sunken`, `--nx-canvas` |
| `--sp-bg-panel`, `--sp-bg-panel-elevated`, `--sp-bg-header` | `--nx-surface`, `--nx-surface-raised`, `--nx-surface-raised` |
| `--sp-border-subtle`, `--sp-border-hover` | `--nx-line`, `--nx-line-strong` |
| `--sp-border-focus`, `--sp-border-focus-glow` | `--nx-focus`; the glow is dropped |
| `--sp-accent`, `--sp-accent-dim`, `--sp-accent-active` | `--nx-accent`, `--nx-accent-muted`, `--nx-accent-hover` |
| `--sp-text-main`, `--sp-text-muted`, `--sp-text-dim` | `--nx-text`, `--nx-text-muted`, `--nx-text-faint` |
| `--sp-font-sans`, `--sp-font-mono`, `--sp-radius`, `--sp-radius-sm` | `--nx-font-sans`, `--nx-font-mono`, `--nx-radius-md`, `--nx-radius-xs` |

### 7.4 Tier 3 — component (new, `packages/design/src/components.ts`, emitted after tier 2)

Kept deliberately short; a token is added here only when two components must agree or when directions differ.

| Variable | A · Méridien | B · Vélin | C · Cadran |
| --- | --- | --- | --- |
| `--nx-control-height` | `32px` | `36px` | `28px` |
| `--nx-row-height` | `36px` | `42px` | `30px` |
| `--nx-card-padding` | `var(--nx-space-6)` | `var(--nx-space-7)` | `var(--nx-space-5)` |
| `--nx-card-radius` | `var(--nx-radius-md)` | `var(--nx-radius-lg)` | `var(--nx-radius-sm)` |
| `--nx-card-shadow` | `none` | 1 px cast shadow (light only) | `none` |
| `--nx-button-primary-bg` | `var(--nx-accent)` | `var(--nx-accent)` | `var(--nx-text)` |
| `--nx-button-primary-fg` | `var(--nx-text-on-accent)` | `var(--nx-text-on-accent)` | `var(--nx-canvas)` |
| `--nx-button-primary-bg-hover` | `var(--nx-accent-hover)` | `var(--nx-accent-hover)` | `var(--nx-text-muted)` |
| `--nx-focus-ring` | `2px solid var(--nx-focus)` | same | same |
| `--nx-label-font`, `--nx-label-transform`, `--nx-label-tracking` | sans, none, 0 | sans, uppercase, 0.08em | mono, uppercase, 0.08em |
| `--nx-icon-stroke`, `--nx-icon-cap`, `--nx-icon-join` | 1.5, round, round | 1.35, round, round | 1.5, square, miter |
| `--nx-live-shape` (documented, implemented as a class) | dot, opacity | dot, ring | square, step blink |

A density setting (question 8) would be three overrides of `--nx-control-height`, `--nx-row-height` and `--nx-card-padding` under a `data-density` attribute.

### 7.5 Migration path for Phase 3

Ordered so that each step ships on its own and the application stays usable throughout.

1. **Stop the debt growing.** Add a ratchet test next to the existing token test: it counts inline `style={{`, hex literals in `.tsx`/`.css` and `window.confirm`, and fails if a count rises. Today's baselines are in `00-audit.md` (1,346 / 259 / 15).
2. **Ship the fonts.** Self-host the chosen WOFF2 files, declare `@font-face`, set `--nx-font-sans`, `--nx-font-mono`, `--nx-font-display` in `tokens.ts`. Remove Orbitron, Rajdhani, `--nx-font-futuristic` and the `letter-spacing: 0.02em` on `body`.
3. **Change tier 2 values.** Add `lineControl` and `focus`; replace the palette values. Because the mobile app imports `palettes` directly, add the new palettes beside the current ones (for example `palettesNext`) and point the CSS generator at them; the mobile app switches when its own redesign starts (question 10).
4. **Delete the overrides** at the top of `theme.css` (`--nx-success`, `--nx-danger`) and the accent-theme layer in `color-themes.css` and `lib/color-theme.ts` (pending question 5).
5. **Collapse the aliases.** Mechanical search-and-replace using the table in 7.3, then delete the alias blocks. Strip the literal fallbacks from `var(--x, literal)` (352 occurrences).
6. **Remove the effects.** Typewriter title, 3D canvas, HUD badges, glow shadows, backdrop blurs.
7. **Build the component layer** (`Button`, `IconButton`, `Input`, `Select`, `Checkbox`, `Switch`, `Tabs`, `Card`, `Badge`, `StatusDot`, `Table`, `Dialog`, `Tooltip`, `Kbd`, `TaskCard`, `ApprovalCard`) on tier 3 tokens, one icon primitive, and replace `window.confirm` with the existing `ConfirmModal`.
8. **Migrate screens** in descending order of inline-style count, starting with the shell and chat (highest traffic), then `domotique-home.tsx`, `SetupWizard.tsx`, `domotique.tsx`, `paper-trading.tsx`, `PreferencesPanel.tsx`. Each screen migrated lowers the ratchet.
9. **Spatial shell**: retire or re-skin on `--nx-*`, per question 6.

Steps 2 to 6 change the look of the whole application in a few small pull requests, without touching any screen file. Steps 7 to 9 are the long tail.
