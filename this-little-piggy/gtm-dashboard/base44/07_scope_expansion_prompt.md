# Scope expansion — Stages 6 to 8 (from the Will / Brian recap)

> **Current-state guard.** The dashboard has been edited by hand in Base44 since the migration began. Prepend Part 0 of `08_brian_recap_prompt.md` (inspect, report, wait, checkpoint, additive-only rules) to any stage below before pasting it, and read "replaces" as "add alongside and hide the old one behind a config flag".

Brian's recap covered four things: dashboard scope, an AI interpretation layer, a RevOps Requests Slack channel, and an automation-error channel. Only the first two belong to the Base44 GTM Dashboard. This file triages the recap, lists the definitions that must be confirmed in Notion before building, and gives the next three stages of the Base44 prompt. Run them after Stages 1 to 5 in `01_build_prompt.md` are live and reconciled.

## 1. Triage

| Recap item | Verdict | Why |
|---|---|---|
| Core purpose: executive pulse check on pipeline, bookings, activity, forecast, rate of change | **Dashboard, Stage 6** | Becomes a "Pulse" strip at the top: five numbers with week-over-week change. The rate-of-change framing is the organizing idea for everything below. |
| Meetings view: week-over-week net new meetings, drilldown by account and source (SDR, AE, inbound) | **Dashboard, Stage 6, needs one definition** | `demo_booked__c` (meeting date) and `deal_source__c` (OB - SDR, OB - AE, IB - *, EV, RE, DA) are already pulled. Needs a Notion row defining "meeting created". |
| Pipeline view: full vs qualified (Stage 2+) toggle; count, dollars, units; week-over-week waterfall (added, dropped, moved, net); drilldown per stage | **Dashboard, Stage 6, needs two definitions** | All inputs exist. The waterfall diffs the current snapshot against the prior reconciled snapshot, which the data model already retains. Needs Notion rows for "qualified pipeline" and "pipeline movement". |
| Forecast: current figure plus week-over-week change | **Dashboard, Stage 6** | Already computed (quarter and year forecast, Compare vs). Stage 6 shows the absolute change next to the percent. |
| Post-sales / client health: churn to date, at-risk accounts, expected year-end churn range, support metrics, health scores, trend overlays | **Dashboard, Stage 8, needs discovery and definitions first** | Nothing in the current pull. HubSpot company properties exist for all of it (see §4), but none has a Notion definition and the Renewal pipeline is excluded by decision. Stage 8a is a read-only discovery prompt; 8b builds only after Notion rows exist. |
| AI interpretation: "pay attention to XYZ" commentary; why deals were lost; weekly "what do I care about" synthesis | **Dashboard, Stage 7** | Build as a grounded summary over the snapshot, the movement block and `closed_lost_reason`. Draft-reviewed before it posts anywhere for the first month. |
| Pre-read already posts to the Go-To-Market channel after each refresh | **Context, not a build item** | The interpretive summary must thread under or replace that post, not add a third weekly message. Decide which before Stage 7 enables Slack. |
| RevOps Requests Slack channel (read-only HubSpot queries), John tested it | **Not this dashboard** | Separate ops tooling. Record it in the RevOps wiki handover notes. |
| Automation error channel so Ray can triage | **Not this dashboard** | Same. One useful tie-in: the Base44 refresh function's failure DM could also post there once it exists; note it as an option in Stage 7, don't build it now. |

## 2. Definitions to confirm in Notion before Stage 6

Add these rows to Metric Definitions (Used by: GTM executive dashboard), set Status = Confirmed, then mirror them into `seed/config.json` and the `GtmConfig` row. The preflight mapping check means the refresh will stop until both sides agree, which is the point. Proposed wording:

| Metric | Proposed definition | Open question for Will / Brian |
|---|---|---|
| Meeting created | A New Logo deal with `demo_booked__c` populated, dated by `demo_booked__c` (calendar date, never TZ-shifted). Population: New Logo deals created in the FY (the existing pg population). Week = week ending Sunday, ET. "Net new this week" = count with `demo_booked__c` in the current week; week-over-week = current week − prior week. Source breakdown = `deal_source__c` parent value; SDR = "OB - SDR", AE = "OB - AE", Inbound = any "IB - *", Event = "EV - *", Referral = "RE - *", Data provider = "DA - *", Unknown/blank = "Unassigned". | Is a meeting on a deal created in FY2025 in scope? (Current pull would miss it.) Should rescheduled demos count once? (`demo_booked__c` holds only the latest date.) |
| Qualified pipeline | Open deals in both in-scope pipelines whose stage is **not** the first stage (`3753890497` Intro & Challenge for New Logo, `3752297191` for Upsell / Expansion) and not terminal. Measured three ways: count, Σ `amount`, Σ `units__c`. | Confirm "Stage 2+" means everything after Intro & Challenge, including Trial / Implementation. |
| Pipeline movement (week over week) | Diff of open deals between the current reconciled snapshot and the previous reconciled snapshot, matched on HubSpot deal ID. **Added** = open now, not open before (new deal or re-opened). **Dropped** = open before, not open now, split into Won, Lost, and Other (moved out of scope or deleted). **Moved** = open in both with a different stage and/or amount; reported as the net $ change on those deals. **Net** = current gross − prior gross = added − dropped + moved. Each bucket carries count, $ and units. Qualified-only variant applies the qualified filter to both snapshots. | Should "dropped → Other" be flagged as a DQ item when non-zero? (Suggest yes, Medium.) |
| Pulse strip | Five headline measures with week-over-week absolute and percent change against the prior reconciled snapshot: Bookings YTD, Gross open pipeline, Qualified open pipeline, Current-quarter forecast, Meetings created (current week). Same delta formula as Compare vs. | None. Display parameter only, like `compare_vs`. |
| Closed-lost reason (pull only) | Add `closed_lost_reason` and `closed_won_reason` to `pull_properties`. Display and summary only; never aggregated into a KPI. | Free text in HubSpot. Fine for Stage 7 commentary; not for charts. |

`seed/config.json` additions once confirmed: `pull_properties` += `closed_lost_reason`, `closed_won_reason`; new block `qualified_rule: { first_stage_ids: ["3753890497", "3752297191"] }`; new block `movement_rule` as above; new block `pulse: { measures: [...] }`; `row_to_config_map` entries for the four new rows.

## 3. Stage 6 — Pulse, meetings, pipeline view, forecast change

> Attach: `02_design_spec.md`, `04_metric_definitions.md`, this file. Precondition: the Notion rows in §2 are Confirmed and `GtmConfig` has been updated to match.

```
Extend the Sales → GTM Dashboard page and the refresh-gtm-dashboard function with the week-over-week views below. Same posture as before: build with the Hub's component library and accessibility features; every number follows the definitions in the attached 07_scope_expansion_prompt.md §2 and the existing 04_metric_definitions.md; nothing is estimated.

A. Refresh function additions (read definitions from GtmConfig, never hardcode):
1. Pull the two new properties closed_lost_reason and closed_won_reason with the existing pulls (they're now in config.pull_properties). Store them on GtmDeal as closed_lost_reason / closed_won_reason (strings, display only).
2. Compute a "movement" block by diffing this snapshot's open tier rows against the previous reconciled snapshot's open tier rows, matched on hubspot_deal_id, per the Pipeline movement definition: added, dropped (won / lost / other), moved (net $ change, count), net. Each bucket has count, amount, units. Compute it twice: all open deals, and qualified only (stage not in config.qualified_rule.first_stage_ids). Also store the per-deal movement rows in a new entity GtmMovement {snapshot_id, as_of, hubspot_deal_id, name, owner_name, pipeline, bucket (added|dropped_won|dropped_lost|dropped_other|moved|unchanged), prior_stage_label, stage_label, prior_amount, amount, prior_units, units, qualified_before, qualified_now}. If there is no previous reconciled snapshot, store movement = null and show "first snapshot, no movement yet".
3. Compute a "meetings" block: for each week ending Sunday from the first Sunday of the FY through the week containing as_of, count pg rows by demo_booked__c week, split by source bucket (SDR, AE, Inbound, Event, Referral, Data provider, Unassigned from deal_source__c). Store {weeks: [{week_end, total, by_source}], current_week, prior_week, wow_delta}.
4. Compute "qualified" totals: count, Σ amount, Σ units over open tier rows not in a first stage.
5. Add to GtmSnapshot.headline: tier1.qgross, tier1.qcount, tier1.qunits, tier1.gcount, tier1.gunits, meetings.current_week, meetings.prior_week, plus the movement and meetings blocks as their own fields on GtmSnapshot. Add the same new tier1 and meetings keys to the GtmKpiHistory entry so Compare vs works on them.
6. New DQ flags: MV-1 Medium when dropped_other.count > 0 (deals that left the open population without closing: list them); MT-1 Low reporting how many pg rows have demo_booked__c populated vs not. Add both to the dq array with section "movement" and "meetings".

B. Page additions, in this order from the top:

1. Pulse strip (new, directly under the filter bar, unfiltered like Compare vs): five compact tiles — Bookings YTD, Gross open pipeline, Qualified open pipeline, Current-quarter forecast, Meetings created this week — each showing the value, the absolute week-over-week change (e.g. "−$4.5M") and the percent badge, against the previous reconciled snapshot. Tooltip names the prior as_of. Use the existing badge styling. If there is no prior snapshot, show the values with no deltas.

2. Meetings view (new section after Tier 1, titled "Meetings"): 
   - Tiles: Meetings created this week (with WoW delta), prior week, trailing 4-week average, YTD total.
   - Chart: stacked weekly bars of meetings created by source bucket (SDR, AE, Inbound, Event, Referral, Data provider, Unassigned), weeks ending Sunday across the FY; hover shows counts per source. Use the viz color roles; give SDR and AE distinct colors and keep Inbound as --viz-weighted.
   - Drilldown: clicking a bar or a tile opens the drawer listing the deals (account name linking to HubSpot, meeting date, source parent, SDR owner, deal owner, stage, amount, units), sortable; a source filter chip inside the drawer.
   - Respects the global filters and the Native-only toggle.

3. Pipeline view (replace the "Sales pipeline" KPI group and the two stage funnels with this; keep the forecast tiles):
   - A segmented control "All open · Qualified (Stage 2+)" that switches every component in this view.
   - Three measure tiles side by side: Deals (count), Pipeline $ (Σ amount), Units (Σ units__c), each with the WoW delta and Compare vs badge. Weighted $ stays as a fourth tile.
   - Week-over-week waterfall chart: bars for Prior week gross → + Added → − Dropped (won) → − Dropped (lost) → − Dropped (other) → ± Moved → Current gross. Positive bars in --viz-weighted, negative in --viz-gross, the two endpoints in --viz-actual. Labels show $ and count. A toggle under it switches the measure to Units. Clicking any bar opens the drawer listing those GtmMovement rows with prior stage → stage and prior amount → amount.
   - Stage table (replaces the funnels): one row per open stage per pipeline in display order: Stage · p · Deals · $ · Units · WoW Δ deals · WoW Δ $. Clicking a row opens the drawer with that stage's current deals. Keep the butterfly funnel as an optional chart view if it's cheap; the table is required.

4. Forecast: on the Current-quarter forecast and Current-year forecast tiles, add the absolute WoW change next to the Compare vs percent ("$4.01M · −$0.3M (−6.9%) vs 11/16/26").

5. Methodology accordion: add the Movement, Meetings and Qualified definitions verbatim from the config, and a "Validation" note that movement is a diff of two reconciled snapshots and has no HubSpot control of its own.

C. Admin Runs page: show the movement summary (added / dropped / moved / net counts) per snapshot.

When done, with no filters: list the Pulse strip values and deltas, the movement block (all and qualified), and the meetings current/prior week counts, and confirm added − dropped + moved equals current gross − prior gross to the cent.
```

**Check:** net movement reconciles to the cent; qualified count + first-stage count = open count; the meetings YTD total equals the number of pg rows with `demo_booked__c` populated this FY; Pulse deltas equal Compare vs (most recent) deltas.

## 4. Stage 7 — AI interpretation layer ("This week's read")

> Attach: this file. Precondition: Stage 6 reconciled for at least two consecutive weeks so there is movement data to read.

```
Add a grounded weekly interpretation to the GTM Dashboard. It explains what changed and why, using only data already in the snapshot. It is not allowed to invent, estimate, or speculate beyond the fields it is given.

A. Backend function interpret-gtm-snapshot (service role, invoked at the end of a reconciled refresh and on demand by revops_admin):
1. Inputs: the current GtmSnapshot (headline, windows, movement, meetings, dq), the previous reconciled snapshot's headline, the GtmMovement rows for this snapshot, and the GtmDeal rows that are dropped_lost or dropped_won this week including closed_lost_reason / closed_won_reason.
2. Use this app's AI gateway / LLM integration to produce a JSON object {headline: string ≤ 200 chars, watch_items: [{title, why, evidence: [{metric, value, prior, delta}], deal_ids: []}] (3 to 5 items), lost_deals_summary: string, data_caveats: [string]}. Rules for the model, enforced in the system prompt and validated in code:
   - Every watch item must cite at least one evidence entry whose metric and values come verbatim from the inputs. Reject and regenerate (max 2 retries) if a cited value is not present in the inputs.
   - Causal language is allowed only when quoting closed_lost_reason / closed_won_reason text or a DQ flag. Otherwise describe the change, not the cause.
   - Rank watch items by absolute dollar impact, then by percent change, then by count.
   - Always include a caveat when dollar_tieout = not_run, when dropped_other.count > 0, or when any High DQ flag exists.
   - Never mention a person by name other than deal owners already in the data; never reference anything outside the inputs.
3. Store the result in a new entity GtmInterpretation {snapshot_id, as_of, status (draft|approved|posted|rejected), content (the JSON), model, generated_at, approved_by, approved_at}.

B. Page: a panel "This week's read" at the top of the dashboard, under the Pulse strip. Shows the headline sentence, the watch items as a compact list with their evidence chips (metric · value · Δ), a "Lost this week" line, and the caveats in small text. Label it clearly as AI-generated interpretation of the snapshot data, with the generated time and the as_of. Each watch item's deal_ids link to the drawer. Only approved interpretations are visible to gtm_leadership; revops_admin sees drafts with Approve / Reject / Regenerate buttons.

C. Slack: for the first four weeks, interpretations post nowhere automatically; a revops_admin approves and the function then posts the headline + watch items as a threaded reply under that week's existing pre-read in the Go-To-Market channel (ask me for the channel ID and how to find the pre-read message; don't create a separate top-level post). After four approved weeks I'll decide whether to let it post without approval. Never post a draft, never post when the refresh didn't reconcile.

D. Runs admin page: show interpretation status per snapshot and the full JSON on expand.

When done, generate an interpretation for the current snapshot and show me the JSON and the validation log (which evidence values were checked).
```

**Check:** every evidence value in the JSON exists in the snapshot; a draft is invisible to a `gtm_leadership` test user; rejecting a draft and regenerating produces a new row rather than overwriting.

## 5. Stage 8 — Post-sales and client health

Nothing here has a definition yet, and the Renewal pipeline is excluded from the dashboard by a confirmed decision. So Stage 8 is two prompts: a read-only discovery that produces a report for Will and Brian to turn into Notion rows, then a build that waits for those rows.

### Candidate HubSpot company properties (found 2026-11-24)

| Need | Candidate fields | Note |
|---|---|---|
| Churn to date | `churned` (bool), `churn_date`, `churn_reason`, `churn_notes`; lifecycle stage "Churn" (`hs_v2_date_entered_3524209338`), `lifecyclestage` | Also Salesforce snapshot fields `churn_date__c`, `churn_category__c`, `churn_lost_to__c`, `churn_risk*__c` frozen at the 2026-07-10 cutover; useful for history, not for live status. |
| At-risk accounts | `at_risk` (bool), `at_risk_date`, `at_risk_reason`, `client_health_score_override` ("CSM determined churn risk") | |
| Health score | `client_health_score`, `client_health_rating`, `client_health_detail`, `account_health_label`, `account_health__worst_open_deal_numeric` | Two different "health" concepts: client health (CS) vs account health derived from open deals (sales). Pick one for this section. |
| Dollar exposure | `hs_active_contracts_arr`, `hs_active_contracts_mrr`, `hs_next_renewal_date` | Depends on HubSpot Contracts being populated. |
| Support metrics | `support_tickets_qtd`, `support_tickets_this_month`, `support_issues_last_90_days`, `support_ticket_ratio_per_100` | Source system and refresh cadence unknown. |
| Trend overlays | none stored historically | Requires a weekly company snapshot entity in Base44 (`GtmAccountHistory`) from the first Stage 8 refresh onward. No backfill is possible. |

### Stage 8a — discovery (read-only, no UI)

```
Add a read-only backend function discover-client-health (revops_admin only) that inventories what HubSpot holds for post-sales health, and writes a report to a new entity GtmDiscoveryReport {as_of, kind: "client_health", report: object}. Do not build any dashboard UI from it.

Using the hubspot connector (read scopes only):
1. GET /crm/v3/properties/companies and record, for each of the fields listed in the attached 07_scope_expansion_prompt.md §5 candidate table: type, options (for enums), description, and whether it is a HubSpot calculated/rollup property.
2. GET /crm/v3/pipelines/companies (lifecycle stage pipeline) and record every stage with its ID and label; identify the Customer and Churn stages.
3. Using POST /crm/v3/objects/companies/search with limit 1 and reading total only, count companies: lifecyclestage = Customer; lifecyclestage = Churn; churned = true; at_risk = true; client_health_score HAS_PROPERTY; hs_active_contracts_arr HAS_PROPERTY; hs_next_renewal_date between Jan 1 and Dec 31 of the current FY; support_tickets_qtd HAS_PROPERTY. Also: churn_date between FY start and today (count), and the same for hs_v2_date_entered_3524209338.
4. Pull up to 200 Customer-stage companies (properties: name, client_health_score, client_health_rating, at_risk, at_risk_reason, hs_active_contracts_arr, hs_next_renewal_date, support_tickets_qtd, support_issues_last_90_days, lifecyclestage) and report population rates per field and the distribution of client_health_rating values.
5. Report, in plain language, which of Brian's asks (churn to date, at-risk accounts, expected year-end churn range, support metrics, health scores, trend) can be computed from populated fields today, which fields are sparsely populated, and what a weekly history would need.

Show me the report. Do not propose definitions; those are decided in Notion.
```

### Stage 8b — build (only after Notion rows exist)

Write Notion Metric Definitions rows for: Churn to date (count and ARR), At-risk accounts (count, ARR, list), Expected year-end churn range (low = churn to date; high = churn to date + at-risk accounts with next renewal on or before Dec 31; show as a range, never a point estimate), Client health distribution (by `client_health_rating`), Support load (tickets QTD, issues last 90 days), and Health trend (week-over-week change in the rating distribution and in at-risk count from `GtmAccountHistory`). Then:

```
Add a "Client health" section to the GTM Dashboard per the new Notion rows now mirrored in GtmConfig.client_health. Same posture: Hub components, exact numbers, nothing estimated.

Refresh function: add a companies pull (lifecyclestage in the Customer and Churn stages, properties listed in config) with count controls from search totals, write GtmAccount rows per snapshot and one GtmAccountHistory row per account per as_of (rating, at_risk, arr, tickets_qtd). Churn to date and at-risk have count controls; ARR sums have no independent control and must be labelled "count-reconciled".

Page section, after SDR pipeline generation: tiles for Churned YTD (count · ARR), At-risk accounts (count · ARR), Expected year-end churn range (low – high, as defined, with the definition in the sub-line), Support tickets QTD; a health distribution bar (ratings in the configured order) with the prior-week distribution as a faint overlay and WoW deltas; an at-risk accounts table (account, rating, at-risk reason, ARR, next renewal, tickets last 90d, CSM/owner) linking to HubSpot company records; a trend line of at-risk count and churned ARR by week from GtmAccountHistory, which will be empty until a few weeks have accumulated — say so in the empty state. Respects the Compare vs selection for deltas; ignores the deal filters (different population) and says so in the section sub-line.

When done, list the four tile values next to the snapshot's client_health block and the count controls.
```

## 6. Out of scope for the dashboard (handover notes)

- **RevOps Requests Slack channel**: read-only HubSpot query channel, tested by John. Document ownership, what it can answer, and the "no writes" rule in the RevOps wiki. Not a dashboard item.
- **Automation error channel**: all automation failures route there for Ray. Once Stage 2 is live, consider pointing the Base44 refresh function's failure notification there in addition to the DM, so it's triaged like everything else. Not built in any stage above.
- **Pre-read to the Go-To-Market channel**: already exists. Stage 7 threads under it; don't let two systems post.
