# Metric definitions — what every number means

System of record: Notion → Revenue Operations → Reporting & Analytics → **Data Definitions** and its **Metric Definitions** database (31 rows tagged for this dashboard, all Status = Confirmed as of 2026-11-23). `seed/config.json` mirrors it. This file restates both for the Base44 builder; it introduces nothing new. If any line here disagrees with Notion, Notion wins and this file is wrong.

HubSpot portal `243635806`. All timestamps are converted from UTC to **America/New_York** before any day, week, month or quarter bucketing.

## Scope

| Item | Value |
|---|---|
| Pipelines in scope | New Logo `2313721535` (N), Upsell / Expansion `2313830082` (U) |
| Pipeline excluded | Renewal `2559714036` (decision 2026-09-14; DQ-10) |
| Won stages | `3753890502` (N), `3752297196` (U) |
| Lost stages | `3753890503` (N), `3752297197` (U) |
| Win/loss rule | stage-ID membership only. `hs_is_closed_won` / `hs_is_closed_lost` are never used (unreliable on migrated records). |
| Fiscal year | calendar. Q1 Jan–Mar, Q2 Apr–Jun, Q3 Jul–Sep, Q4 Oct–Dec. |
| Dollars | `amount` everywhere. `acv` rejected (populated on a handful of won deals), `hs_acv` is zero, `hs_forecast_amount` mirrors `amount`, `hs_projected_amount` is reference only. |
| Units / segment basis | `units__c` |
| Owner | `hubspot_owner_id` (deal owner). `sdr_owner` is a different person on most deals. |
| Source | `deal_source_drill_down` (parent `deal_source__c` shown on hover). `lead_source`, `hs_analytics_source`, `attribution_source_drill_down` are not used. |
| Fit score | company `swan_score` through the deal → company association. `hs_deal_score` pulled but never used. |
| SDR fields | `sdr_owner`, `demo_booked__c` (date), `demo_completed__c` (Yes/No), `deal_source_group`. `sdr_owner_new` and `demo_completed_date__c` are never used. |
| Migration | `hs_object_source_label = SALESFORCE` marks a migrated record; its `createdate` is the original Salesforce date. Cutoff date `2026-07-14`. |
| Tie-out tolerance | $0.01 on dollar measures, exact on counts |

## Windows (derived from as_of, ET)

| Window | Definition | Example for as_of 2026-11-23 |
|---|---|---|
| QTD | current quarter start … quarter end (bookings restricted to ≤ as_of by the pull) | Q4 FY2026: 2026-10-01 … 2026-12-31 |
| YTD | Jan 1 … Dec 31 of the FY (bookings restricted to ≤ as_of by the pull) | FY2026: 2026-01-01 … 2026-12-31 |
| Prior quarter | previous quarter start … end | Q3 FY2026: 2026-07-01 … 2026-09-30 |
| Trailing 30 days (SDR) | [as_of − 29 days, as_of], inclusive | 2026-10-25 … 2026-11-23 |
| Weeks elapsed (pacing) | inclusive days from period start to as_of ÷ 7 | Q4: 54 days → 7.7 weeks |
| Weeks in period | inclusive days in the period ÷ 7 | Q4: 92 days → 13.1 weeks |

The forecast windows use the full quarter / year (open deals closing later this quarter or year count). The bookings windows end at as_of because the won pull stops there.

## Derived per-deal fields

| Field | Rule |
|---|---|
| Segment | `units__c` 0–2,999 → SMB; 3,000–19,999 → Mid-Market; ≥ 20,000 → Enterprise. Required; a null stops the refresh. Raw free-text `segment` is display only. |
| Weighted deal value | open with `weighted_amount` populated → `weighted_amount`; open with it blank → `amount × hs_deal_stage_probability` (tagged **fallback**); Closed Won → `amount`; Closed Lost → 0. |
| Deal probability | the record's `hs_deal_stage_probability`; if blank, the stage default. A manual override (record ≠ stage default) is DQ-6, not an error. |
| Past-due open deal | not won AND `closedate (ET) < as_of`. Stays in gross and weighted pipeline; counts toward the quarter forecast only if its close date is inside the quarter. |
| Migration cohort | create date before `2026-07-14` (Tier 1–3). Migrated record: `hs_object_source_label = SALESFORCE` (Pipeline Generation). Blank record source = native. |
| Channel bucket | `deal_source_group`: Outbound → Outbound; Inbound → Inbound; Referral → Inbound; Event → Events; blank → Unassigned. |
| Source group (hover) | `deal_source__c` prefix: IB Inbound, OB Outbound, EV Event, RE Referral, DA Data provider, UK Unknown; blank → Unassigned. |

## Tier 1 — headline tiles

All over the **tier** population (open deals in both pipelines + closed-won FY deals in both pipelines), after global filters.

| Tile | Formula | Sub-line |
|---|---|---|
| Bookings QTD | Σ amount, won, close date in QTD window | "{n} deals · {Q start} – {Q end}" |
| Bookings YTD | Σ amount, won, close date in YTD window | "{n} deals · Jan 1 – Dec 31" |
| Average sales price | Bookings YTD ÷ won YTD count | "mean amount, {n} closed-won YTD" |
| Average sales cycle | mean(close date − create date) in days over won YTD; secondary figure excludes migration cohort | `warn` "migration cohort included" n={all} · post-Jul 14 cohort only: {days} (n={clean}); `gap` "data gap" when clean n = 0 |
| New Logo bookings YTD | Σ amount, won YTD, pipeline N; % = ÷ Bookings YTD | "{pct} of YTD bookings · {n} deals" |
| Upsell / Expansion bookings YTD | same for pipeline U | |
| Gross open pipeline | Σ amount over open deals, all close dates | "{n} open deals · all close dates" |
| Weighted open pipeline | Σ weighted over open deals | "weighted_amount, {pct} of gross · {k} stored ${x} · `warn` {m} fallback ${y} via amount × probability" |
| Current-quarter forecast | Bookings QTD + Σ weighted over open deals with close date in the quarter | "won QTD ${a} + weighted open closing in Q{n} ${b} ({k} deals) · fallback split" |
| Current-year forecast | Bookings YTD + Σ weighted over open deals with close date in the FY | same shape |

Any tile whose population is empty shows "—" or $0 with a `gap` chip "no deals in scope". Every tile opens a drilldown of exactly its population (forecast tiles: won + open rows together).

## Tier 2 — grouped views

| Card | Computation |
|---|---|
| Cumulative forecast | weekly buckets (week ending Sunday from the first Sunday of the FY through Dec 31); three cumulative series by close-date week: won amount, open gross amount, open weighted. Open deals with close dates outside the FY are excluded from this chart only; legend reports the count. |
| Stage funnels | open deals per non-terminal stage of each pipeline: count and gross amount, in pipeline display order, stage default probability shown. |
| By segment | three series per segment: Bookings YTD, gross open, weighted open; "{n} deals" = distinct deals in the segment across both populations. |
| By deal owner | same three series per owner, sorted by (gross open + Bookings YTD) descending. |

## Tier 3 — deal table

Every row in the filtered tier population, sortable, default sort amount descending. Tags: won, past due, migration cohort (won rows only), fallback.

## Pipeline Generation (population **pg**: New Logo, created in the FY, any current stage)

| Metric | Formula |
|---|---|
| Gross pipeline created QTD / YTD | Σ amount over pg rows with create date in the window. Sub-line: "{n} deals · {start} – {as_of} · `warn` {m} migrated · {w} won, {l} lost, {o} open" |
| Deals created QTD / YTD | count; sub-line "${avg} average per deal" |
| Pacing (quarter and year) | avg $/week = Σ amount ÷ weeks elapsed; avg deals/week = count ÷ weeks elapsed; run-rate = avg $/week × weeks in period. Prior-quarter column = same metrics over deals created from prior-quarter start through the date at the same elapsed-day count; Δ = (cur − prior) ÷ prior. No prior-year column (FY2025 not pulled). |
| Pipeline created by week | Σ amount per week ending Sunday, split migrated / native, from the first Sunday of the FY through the week containing as_of. |
| By source | Σ amount and count per `deal_source_drill_down`, sorted by $ desc; hover lists parent `deal_source__c` split. |
| By deal owner | Σ amount and count per deal owner, sorted by $ desc. |
| Create month × close month | cell = Σ amount where create month = row and close month = column; shade ∝ √(cell ÷ max cell). Deals with no close date are excluded from the grid and reported beneath it (count and $). |
| By Swan score | Σ amount and count per band Swan 5 / Swan 4 / Swan 3 / No Swan score (bands are the observed integer values); coverage = scored ÷ total. |
| Native-only toggle | removes `migrated` rows from every Pipeline Generation and SDR computation. |

## SDR pipeline generation (subset of pg)

| Metric | Formula |
|---|---|
| SDR opportunity | pg row with `sdr_owner` populated (including the Unassigned placeholder `8309346`), timestamped by create date. Deliberately broader than "reached a later stage". |
| Meetings booked (30d) | count of pg rows with `demo_booked__c` in the trailing-30-day window (cohort by booked date; `sdr_owner` not required). |
| Meetings held (30d) | booked cohort with `demo_completed__c = 'Yes'` as of as_of (held need not fall in the window). Sub-line "{pct} of booked cohort". |
| Held → opportunity (30d) | held cohort with `sdr_owner` populated ÷ held cohort. `—` when nothing held. |
| Opportunities generated (30d) | SDR opportunities with create date in the window; sub-line Σ amount. |
| Booked → held by segment | per segment: held ÷ booked within the booked cohort. |
| Opportunities per SDR | trailing-30-day SDR opportunities grouped by `sdr_owner`, excluding `8309346` from the chart only. |
| Pipeline generated vs goal by segment | Σ amount of SDR opportunities created in QTD and YTD, by segment, against `config.sdr_section.goal_by_segment`. Goal 0 = "not configured": suppress the percentage, never show $0 achievement. |
| Channel mix | Σ amount and count of SDR opportunities per channel bucket (fixed order Outbound, Inbound, Events, Unassigned). |
| Stage progression by channel | count of SDR opportunities by current New Logo stage (including Closed Won / Lost) × channel (Outbound, Inbound, Events). |

## Compare vs (period-over-period)

- Source: `GtmKpiHistory`, one entry per as_of with unfiltered headline totals: tier1 {qtd, ytd, asp, cycle, nl, ue, gross, wtd, fq, fy}, pg {cqtd, cytd, nqtd, nytd}, sdr {booked30, held30, opp30, heldopp30}.
- Prior = the most recent earlier entry by as_of, whatever the gap; the dropdown can pick any older entry within the 26-week window.
- Delta = (current − prior) ÷ |prior|. Prior = 0 → "new" (blank if current is also 0). Either side missing → blank. No earlier entry → the control is hidden.
- Badges compare unfiltered totals only and ignore page filters.
- The Slack post calls out headline deltas of at least `material_change_threshold_pct` (10%) on: Bookings QTD, Bookings YTD, gross open, weighted open, quarter forecast, year forecast, pipeline created QTD, pipeline created YTD, SDR opportunities generated (30d).

## Data quality flags (computed every refresh)

Severity drives the badge counts and the Slack line ("{n} High-severity data-quality flag(s)").

| ID | Severity rule | Finding |
|---|---|---|
| DQ-1 | Medium | `acv` populated on {k} of {n} won FY deals; `amount` used throughout. |
| DQ-2 | High if post-cutoff won deals < 10, else Low | {clean} of {n} won FY deals created on/after 2026-07-14; the rest carry migrated create dates. |
| DQ-3 | High (standing) | No authoritative segment field; segment derived from `units__c`. |
| DQ-4 | Medium | `weighted_amount` populated on {k} of {n} open deals; {m} fall back to amount × probability (${y}). |
| DQ-5 | Low | `hs_forecast_amount` equals `amount` on every open deal. |
| DQ-6 | Low | Manual stage-probability overrides: list of deals where record probability ≠ stage default. |
| DQ-7 | Medium if any, else Low | Open deals with past close dates: list, count, Σ amount. |
| DQ-8 | Medium | Concentration: 8 largest open deals = ${x} of ${gross} ({pct}%); owners listed. |
| DQ-9 | Low (retire in Base44) | Stage probabilities observed from deals, not pipeline settings. Base44 reads the pipelines API, so record "read from pipeline settings" and drop the flag. |
| DQ-10 | Low | Renewal pipeline exists and is excluded. |
| DQ-11 | Low | Owners resolved via owners API; inactive owners listed. |
| DQ-12 | Medium if any, else Low | Owner IDs (deal or SDR) that couldn't be resolved. |
| PG-1 | High | Salesforce-migrated create dates: {m} of {n} pg deals (${x} of ${total}); last migrated create date, first native create date. |
| PG-2 | High | Swan score present for {k} of {n} pg deals; observed values 3/4/5 only; scale undocumented. |
| PG-3 | Low | Deals with amount = 0: names. |
| PG-4 | Medium if any blank, else Low | Blank `deal_source_drill_down`: count, names, Σ amount → bucketed Unassigned. Parent `deal_source__c` null count. |
| PG-5 | Medium if any, else Low | Null amount (always 0 after validation), null close date count, unresolved owner count. |
| PG-6 | Low | Records created from HubSpot mobile (`MOBILE_IOS`) treated as native. |
| PG-7 | Low | Prior-period pacing is same-elapsed-days vs prior quarter; no FY2025 pull. |
| PG-8 | Low | Stage notes from the refresh (e.g. mixed probabilities observed). |
| SDR-1 | Medium | `sdr_owner_new` diverges from `sdr_owner`; live HubSpot saved reports use `sdr_owner_new`; this dashboard follows the Notion decision (`sdr_owner`). |
| SDR-2 | Medium | Three source-bucketing fields exist and disagree; only `deal_source_group` is used here. |
| SDR-3 | Low | SDR definition matches {k} of {n} pg deals ({pct}%); {n−k} genuinely blank. |
| SDR-4 | High until a quota is configured | No pipeline goal for any segment; goal = 0 means not configured. |
| SDR-5 | Low | Held → opportunity is {k} of {n}; near-mechanical consequence of SDR-3. |
| SDR-6 | Low | `deal_source_group` blank on {k} of {n} SDR opportunities → Unassigned. |
| SDR-7 | Low | `demo_completed_date__c` unpopulated since the migration; never used. |

## Reference values for acceptance (as_of 2026-11-23, unfiltered)

| Measure | Value |
|---|---|
| Open deals / gross / weighted | 108 / $76,503,019.03 / $12,190,148.41 (81 fallback) |
| Won YTD / amount | 76 / $7,742,036.12 |
| Bookings QTD | $170,731.00 (3 deals) |
| Quarter forecast / year forecast | $4,008,353.90 / $12,088,758.20 |
| Pipeline created QTD / YTD | $31,315,031.25 (93) / $188,722,380.32 (762) |
| SDR opportunities | 761 · $188,619,970.32 |
| Trailing 30d booked / held / opps | 51 / 33 / 47 ($15,863,097.75) |
| Past-due open | 7 · $4,158,932.48 |
| Swan coverage | 221 of 762 (29.0%) |
| High DQ flags | 3 (DQ-2, DQ-3, SDR-4) |
