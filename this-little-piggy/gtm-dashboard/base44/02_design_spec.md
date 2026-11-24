# Design spec — GTM executive dashboard in the Findigs Hub

This is design **guidance** for the Base44 build, derived from the current HTML dashboard (`gtm-dashboard/template.html`). The new page lives in the Findigs Hub at **Sales → GTM Dashboard** and should be built from the Hub's own component library, theme, typography and accessibility features so it feels native. It does not need to match the HTML pixel for pixel.

Precedence: the Hub's design system wins on chrome, components, type and spacing. This spec wins on information architecture (what sections and charts exist and in what order), chart encodings, data-viz color roles, number and date formatting, and page states. `04_metric_definitions.md` wins on every number and is not negotiable. Sections 1 to 4 below describe the reference implementation; treat them as the intent to preserve, not CSS to copy.

Brand mode: **new brand** (Findigs, post 2026-07-27 cutover). Light surfaces, borderless cards, green as accent not flood, no illustration, no "Floop" arrow.

## 1. Tokens

Reference palette from the HTML build. Map these to the Hub's existing theme tokens wherever an equivalent exists; add only the `--viz-*` roles as page-scoped tokens if the Hub has none. Use them by semantic role; never paint with raw color literals.

```css
.gtm-dashboard {
  /* brand anchors */
  --forest: #212B14; --sand: #FDFBF7; --key-green: #8EDE65;
  --neutral-10: #F5F4EE; --neutral-20: #EBE9E4; --neutral-30: #DBDAD5; --neutral-40: #CCCBC6; --neutral-50: #B2B1AD;
  --neutral-60: #999894; --neutral-70: #807F7C; --neutral-80: #666563; --neutral-90: #4D4C4A; --neutral-100: #333331;
  --jade-60: #22C386; --sky-60: #ADD2FF; --sun-60: #FFCE59; --coral-60: #FFA27A; --berry-60: #F3B3F1; --pebble-60: #DDC8C9;
  /* semantic */
  --fg-1: var(--forest); --fg-2: var(--neutral-80); --fg-3: var(--neutral-70);
  --fg-on-dark: var(--sand); --fg-on-brand: var(--forest); --fg-link: var(--forest);
  --fg-danger: #C04128; --fg-success: #1B9D6B;
  --bg-page: var(--sand); --bg-surface: var(--neutral-10); --bg-surface-2: var(--neutral-20); --bg-brand: var(--key-green);
  --border-subtle: var(--neutral-30); --border-default: var(--neutral-40); --border-strong: var(--forest);
  --focus-ring: 0 0 0 3px rgba(142, 222, 101, 0.6);
  /* spacing and radii */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;
  --r-xs: 4px; --r-sm: 8px; --r-md: 12px; --r-lg: 16px; --r-xl: 24px; --r-pill: 999px;
  /* data viz */
  --viz-actual: var(--forest);        /* closed-won actuals, "Events" channel */
  --viz-gross: var(--neutral-50);     /* gross open pipeline, migrated records, "No Swan score", "Outbound" channel */
  --viz-weighted: var(--key-green);   /* weighted pipeline, native records, dollars, "Inbound" channel */
  --viz-count: var(--sky-60);         /* deal counts in the funnel */
  --viz-unassigned: var(--neutral-40);
}
```

Green text must use deep green `#3f7a1e` or `--fg-success`, never `--key-green` (fails contrast as text).

## 2. Typography

- Body and UI: **Findigs Sans 400**, 14px, line-height 1.45, antialiased.
- Labels and tier captions: Findigs Sans 500, 12px, letter-spacing 0.08em, uppercase allowed only on the tier captions ("TIER 1 · HEADLINE NUMBERS").
- Numerals everywhere: `font-variant-numeric: tabular-nums`. KPI values Findigs Sans 900 (or 700 if 900 isn't loaded), 26px, letter-spacing -0.02em, line-height 1.05.
- Page title (h1) 28px 900; section titles (h2) 22px 900 for Pipeline Generation and SDR, 18px 700 for "Tier 3 · Deal table"; card titles (h3) 14px 700; card descriptions 12px `--fg-3`.
- Display serif **Orbikular SemiBold 600** is permitted for the page h1 only, and only if the Hub already loads it. Do not load it for this page alone.
- Fonts are self-hosted. Load Findigs Sans from `https://media.findigs.com/static/fonts/findigs-sans-{regular,medium,bold,black}.otf` (weights 400/500/700/900, `font-display: swap`) unless the Hub already provides the face. Never use Google Fonts.
- Monospace for property names inside descriptions (`amount`, `weighted_amount`): `ui-monospace, SFMono-Regular, Menlo, Consolas`, 11px, on `--bg-surface-2`, radius 4px, padding 0 4px.

## 3. Page layout

```
┌ Hub shell (nav, user menu) ─────────────────────────────────────────────┐
│ .gtm-dashboard  max-width 1400px, margin auto, padding 24px 24px 64px   │
│                                                                          │
│ Header: logo + title + sub (left)   refreshed / as-of / scope pill (right)│
│ Sticky filter bar (top: Hub header height, z 20, bg --bg-page, 1px rule) │
│ Tier 1  ── KPI groups grid 3fr / 2fr                                     │
│ Tier 2  ── chart rows (1 col, then 2 col, 2 col)                         │
│ Tier 3  ── deal table                                                    │
│ Pipeline generation ── 4 KPI tiles, charts                               │
│ SDR pipeline generation ── 4 KPI tiles, charts                           │
│ Data quality flags (accordion) · Sources and methodology (accordion)     │
│ Footer                                                                   │
└──────────────────────────────────────────────────────────────────────────┘
Drilldown drawer slides in from the right over a scrim.
```

- Section spacing: `margin-top: var(--space-6)`.
- Chart rows: `display:grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px`. Variant `.one` is a single column.
- Below 1024px: every grid collapses to one column; KPI grids go to two columns; the drawer is full width.
- Below 640px: KPI grids go to one column; the filter bar becomes a collapsible "Filters" button.

### Header

- Left: Findigs horizontal logo (30px tall, `https://media.findigs.com/static/logos/findigs-horizontal-light.svg`, text fallback "Findigs" 900/22px), then h1 "GTM executive dashboard" and sub-line: "Closed-won bookings and open pipeline · New Logo and Upsell / Expansion · HubSpot portal 243635806 · Internal only".
- Right, 13px `--fg-2`, right-aligned: "Data last refreshed **{pulled_at ET}**", "As-of date for QTD / YTD windows: **{as_of}** · {Qn FY2026 (Mon D – Mon D)} · FY = calendar year", and a **scope pill** (`--bg-surface-2`, pill radius, 4px 12px, weight 500): "{n} deals in scope" where n is the filtered Tier 1–3 row count.
- If the current snapshot is older than 8 days, add a `warn` chip "stale: last reconciled refresh {as_of}".

### Sticky filter bar

Chips are `details/summary` style popovers or an equivalent React popover:

| Control | Type | Default | Notes |
|---|---|---|---|
| Deal owner | multi-select checklist | all | Options = union of owner names across Tier 1–3 and Pipeline Generation populations. Count badge (forest pill, 11px) shows selected count when not "all". |
| Deal stage | multi-select, grouped by pipeline (New Logo, Upsell / Expansion) | all | |
| Segment | multi-select: SMB, Mid-Market, Enterprise | all | |
| Amount $ | min / max number inputs, step 1000 | blank | |
| Units | min / max number inputs, step 100 | blank | |
| Close date | date from / to | blank | Filters on close date, not create date, in every section. |
| Compare vs | select of prior snapshot dates, "(most recent)" suffix on the first | most recent prior | Hidden entirely when there is no prior snapshot. |
| Reset filters | button, `--bg-surface-2`, radius 12px | | Restores every control above except Compare vs. |

Chip: `--bg-surface` background, radius 12px, padding 7px 12px, 13px/500, transparent 1px border that becomes `--border-default` when open. Popover: `--sand` background, 1px `--border-default`, radius 16px, padding 12px, min-width 240px, max-height 320px scroll, shadow `0 8px 24px rgba(33,43,20,0.12)`. Clicking outside closes it.

Filters apply to **every** section simultaneously; Compare vs badges ignore filters (they compare unfiltered totals).

## 4. Components

### KPI group
`--bg-surface` background, radius 24px, padding 16px, h3 14px/700 with 12px bottom margin. "Closed-won bookings" group holds a 3-column grid of 6 tiles; "Sales pipeline" holds a 2-column grid of 4 tiles. Pipeline Generation and SDR each have a 4-column strip in the same surface.

### KPI tile (clickable)
- `--sand` background, radius 16px, padding 14px 16px, min-height 104px, flex column, 1px transparent border → `--border-default` on hover, 160ms ease `cubic-bezier(0.2,0,0,1)`. Whole tile is a button; focus-visible shows `--focus-ring`.
- Rows: label (12px `--fg-2`) · value row (value + Compare badge, baseline aligned, 8px gap, wraps) · sub-line (12px `--fg-3`, pushed to bottom with `margin-top:auto`).
- Compare badge: 12.5px 700 tnum. `up` = `--fg-success` with "▲ +12.3%", `down` = `--fg-danger` with "▼ −4.1%", `flat` (|Δ| < 0.05%) = `--fg-3` 500 "0.0%", `new` when prior is 0, blank when either side missing. Tooltip: "vs {prior as-of date}: {prior value}".
- Inline chips used in sub-lines: `.warn` (`--sun-60` bg, forest text, radius 4px, 1px 6px, 11px/500) e.g. "migration cohort included", "{n} fallback", "{n} migrated"; `.gap` (`--coral-60` bg) e.g. "no deals in scope", "data gap", "not configured".

### Card
`--bg-surface`, radius 24px, padding 16px 24px. h3 then `.desc` (12px `--fg-3`, 12px bottom margin) then the chart then an optional `.legend` (flex wrap, 6px 16px gap, 12px `--fg-2`, 12px square swatches radius 3px; line swatch = 12×3px).

### Deal table (Tier 3 and drawer)
- Wrapper: max-height 560px scroll, radius 16px, `--sand` background. Sticky thead on `--sand`, 12px/500 `--fg-2`, 10px 12px padding, bottom 1px `--border-subtle`; sortable headers with ▲/▼ indicator; numeric columns right-aligned, tnum.
- Rows: 13px, 8px 12px padding, 1px `--border-subtle` separators, hover `--bg-surface`.
- Columns (Tier 3): Company / deal (link to HubSpot record `https://app.hubspot.com/contacts/243635806/record/0-3/{id}`, new tab) · Pipeline · Stage · Owner · Close date · Segment (derived, raw value in 11px `--fg-3` parentheses) · Units · Amount · Weighted.
- Tags after the deal name, 10.5px/500, radius 4px, 1px 6px, 6px left margin: `won` (`--jade-60` bg), `past due` (`--coral-60`), `migration cohort` / `migrated` (`--sun-60`), `fallback` after the weighted value (`--bg-surface-2`, title "weighted_amount is blank; amount × stage probability used").
- Table note (12px `--fg-3`, right of the section title): "{n} deals · ${gross} gross · click a column to sort · deal names link to HubSpot".

### Drilldown drawer
Fixed right, `width: min(900px, 94vw)`, `--sand`, shadow `-12px 0 40px rgba(33,43,20,0.18)`, slides in 240ms. Scrim `rgba(33,43,20,0.35)`. Header: title (18px 900), meta line "{n} deals · gross ${x} · weighted ${y} · {definition}", Close button. Body: a deal table sorted by amount desc. For gross-pipeline-style drilldowns the last two columns are Created and Source; for bookings drilldowns the last column is Cycle (days). Escape and scrim click close it.

### Accordions (methodology, DQ)
`details.meth`: `--bg-surface`, radius 24px, summary 14px/700 padding 14px 24px with a "Show/Hide" chevron label on the right and an optional DQ badge ("{n} flags", `--bg-surface-2` pill). Body padding 0 24px 24px; h4 13px/700 with 16px top margin; tables 12px with `--border-subtle` rules.

### Severity pill
`.sev.h` `--coral-60`, `.sev.m` `--sun-60`, `.sev.l` `--bg-surface-2`; forest text, radius 4px, 11px/500.

### Pace table
Two columns (or four with prior period): rows "Avg $ created per week" (value class `big` 16px 700), "Avg deals created per week", "Weeks elapsed / total", "Run-rate to end of period" (big). Δ cell: `.delta.up` success / `.delta.down` danger, 12px 700, formatted "+12%".

### Heatmap
Table, 12px, cells 72px wide; row headers = create month, column headers = close month, plus "Row total" column and "Column total" row (`.tot` cells on `--bg-surface-2`). Cell shading: `background: rgba(33,43,20, 0.08 + 0.87 × √(cell ÷ max cell))`; text turns `--sand` when the alpha exceeds 0.5. Empty cell shows "·" in `--fg-3`. Note below: "Excluded from grid (no close date): {n} deals · ${x}. Close month uses the current closedate value: actual close for won/lost deals, expected close for open deals. Dates in ET."

### Toggle
"Native HubSpot records only (exclude Salesforce-migrated)" checkbox in the Pipeline Generation header. Applies to the Pipeline Generation and SDR sections only.

### Empty state
Inside any card or table when the filter removes everything: 12px `--fg-3`, centered, 24px padding: "No deals match the active filters."

### Footer
Two-ended flex, 12px `--fg-3`, 1px top rule: "Source: HubSpot CRM (portal 243635806) · Snapshot refreshed weekly · Internal only" and "Built by Revenue Operations · Questions to Will Ritchings".

## 5. Charts

Implement with Recharts (or inline SVG). Every chart: `--font-sans` 11px labels in `--fg-2`, grid lines `--neutral-30` 1px, axis `--neutral-50` 1px, value labels `--fg-1` 11px/500, `aria-label` on the chart root, and a hover tooltip (`--sand` bg, 1px `--border-default`, radius 8px, 12px). Dollar axes use the compact format below. Y max = "nice" ceiling of the data max (1 / 2 / 2.5 / 5 / 10 × power of ten), 5 ticks.

| # | Card | Type | Encoding | Colors | Hover / labels |
|---|---|---|---|---|---|
| T2-1 | Cumulative forecast through Dec 31, {FY} | line, 3 series, weekly buckets (week ending Sunday, first Sunday of the FY through Dec 31), x = close-date week, y = cumulative $ | actuals (closed-won amount), gross open (amount), weighted open | actuals `--viz-actual` 2.5px; gross `--viz-gross` 2px dashed 6 4; weighted `--viz-weighted` 2.5px; vertical dashed marker "as of {date}" in `--neutral-60` | end-of-line value labels; legend notes "{n} open deals with close dates outside {FY} excluded" |
| T2-2/3 | Stage funnel · New Logo / Upsell | butterfly bars per stage (ordered by pipeline order, open stages only) | left bar = deal count, right bar = gross $ | counts `--viz-count`, dollars `--viz-dollars`; stage label centered with "p = 0.2" beneath in 9.5px | bar titles "{stage}: {n} deals" / "{stage}: ${amount}" |
| T2-4 | Bookings and pipeline by segment | grouped vertical bars, 3 categories (SMB, Mid-Market, Enterprise) × 3 series | Bookings YTD, Gross open, Weighted open | `--viz-actual`, `--viz-gross`, `--viz-weighted` | value above each bar (9.5px); "{n} deals" under category |
| T2-5 | Bookings and pipeline by deal owner | horizontal grouped bars, same 3 series, owners sorted by gross open + YTD bookings desc | | same | value at bar end; "{n} deals" under owner |
| PG-1/2 | Pacing · current quarter / year | table, not chart (see Pace table) | | | |
| PG-3 | Pipeline created by week | stacked vertical bars, weeks ending Sunday from the first Sunday of the FY to the week containing as-of | bottom = migrated $, top = native $ | migrated `--viz-gross`, native `--viz-weighted`; zero weeks show a 1px `--neutral-40` tick | tooltip "Week ending {date}: {n} deals · ${amount} ({m} migrated · {k} native)"; month labels under the first week of each month |
| PG-4 | Pipeline created by source | horizontal bars, `deal_source_drill_down` values sorted by $ desc, 18px bars | gross $ | `--viz-weighted` | label "${amount} · {n}"; tooltip adds parent `deal_source__c` breakdown lines |
| PG-5 | Pipeline created by deal owner | horizontal bars by deal owner sorted by $ desc | gross $ | `--viz-weighted` | same |
| PG-6 | Create month × expected close month | heatmap table | cell = Σ amount | see Heatmap | tooltip "Created {Mon YYYY}, closes {Mon YYYY}: {n} deals · ${amount}" |
| PG-7 | Pipeline created by Swan score | horizontal bars, fixed band order Swan 5 · Swan 4 · Swan 3 · No Swan score (always shown, even at 0), max-width 640px | gross $ | scored `--viz-weighted`, unscored `--viz-gross` | legend "Coverage: {scored} of {total} deals ({pct}%)" |
| SDR-1 | Meeting booked → held conversion, by segment | vertical % bars (0–100%, 25% grid), 3 segments, bar width ≤ 80px | held ÷ booked | `--viz-weighted` | % above bar, "{n} booked" below; "—" when no booked |
| SDR-2 | Opportunities generated per SDR | horizontal bars by `sdr_owner` name sorted by $ desc, excluding Unassigned (8309346) | Σ amount, count | `--viz-weighted` | legend "{n} deals across {k} SDRs · {u} Unassigned deal(s) excluded from this view, counted in the headline tile" |
| SDR-3 | Pipeline generated vs. goal, by segment | table: Segment · QTD generated vs. goal · YTD generated vs. goal | | | goal 0 → `.gap` chip "not configured"; otherwise "${x} of ${goal} ({pct}%)" |
| SDR-4 | Channel mix — SDR opportunities | horizontal bars, fixed order Outbound · Inbound · Events · Unassigned (Unassigned always shown) | Σ amount, count | Outbound `--viz-gross`, Inbound `--viz-weighted`, Events `--viz-actual`, Unassigned `--viz-unassigned` | legend with the four swatches + "{n} SDR opportunities" |
| SDR-5 | Stage progression by channel | grouped vertical bars, New Logo stages in order (incl. Closed Won / Lost) × 3 channels (Outbound, Inbound, Events), bar width ≤ 22px, stage labels rotated 28° | count | same channel colors | tooltip "{stage} · {channel}: {n}" |

## 6. Number and date formatting

- Compact USD (tiles, axes, bar labels): ≥ $10M → `$12.3M` (1 decimal); ≥ $1M → `$1.23M` (2 decimals); ≥ $1K → `$123K` (0 decimals); else `$999`. Null → "—".
- Full USD (tables, drawer meta, methodology): `$7,742,036` (rounded to whole dollars, thousands separators). Tie-out tables keep cents.
- Counts: thousands separators. Percentages: one decimal (`43.1%`). Days: whole number + " days".
- Dates: `MM/DD/YY` in tables and sub-lines; `Mon D, YYYY` in the header and Slack post; windows as `Jan 1 – Dec 31`. All dates are America/New_York.

## 7. Motion and accessibility

- Drawer 240ms, tile border 160ms, both `cubic-bezier(0.2,0,0,1)`. Honor `prefers-reduced-motion` (no slide, instant).
- Every interactive element reachable by keyboard; `--focus-ring` on focus-visible; Escape closes the drawer and any open popover.
- Charts carry `role="img"` and an `aria-label`; the deal table is a real `<table>` with `<th scope>`.
- Contrast: body text on `--sand` and `--neutral-10` is ≥ 7:1 (forest); `--fg-3` on `--sand` is ≥ 4.5:1. Never put `--key-green` text on a light surface.

## 8. States

- **Loading**: skeleton tiles (shimmer on `--bg-surface-2`) while the current snapshot loads; charts show a 200px skeleton.
- **No reconciled snapshot yet**: header shows a `gap` chip "No reconciled refresh yet" and sections render empty states; the Refresh button (admins) is prominent.
- **Stale** (> 8 days): header `warn` chip; nothing else changes.
- **Refresh failed** (latest run failed, prior snapshot still current): header `warn` chip "Last refresh {date} did not reconcile — showing {as_of}" linking to the run record for admins.
