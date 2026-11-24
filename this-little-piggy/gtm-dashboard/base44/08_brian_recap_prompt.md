# Single prompt — extend the GTM Dashboard with Brian's requests

One paste for the Base44 builder, for the Findigs Hub app, after Stages 1 to 5 of `01_build_prompt.md` are live. It covers everything from the Will / Brian recap that belongs on the dashboard: the pulse-check framing, the meetings view, the pipeline view with qualified toggle and week-over-week waterfall, forecast change, the AI interpretation layer, and a client-health section. The RevOps Requests channel and the automation error channel are ops items, not dashboard items, and are left out.

The dashboard in Base44 has been edited by hand since the migration began. The prompt therefore opens with a mandatory inspection step (Part 0): the builder inventories what exists, reports it, and treats the current state as the source of truth. Every change after that is additive. Nothing is deleted, renamed or rewritten wholesale.

Definitions for the new metrics are written into the prompt as **provisional**, because they don't exist in Notion yet. The builder shows a "provisional definition" badge on those sections until the Notion rows are confirmed and `GtmConfig` is updated. Attach `07_scope_expansion_prompt.md` for the field inventory.

---

```
IMPORTANT — READ FIRST. The GTM Dashboard in this app has been edited directly in Base44 since it was first built, and those edits are the current source of truth. Do not assume the page, entities or functions match any earlier specification. Before you change anything, complete Part 0 below and show me the inventory. Every change in this prompt is ADDITIVE: extend what exists, never delete, rename, overwrite or regenerate an existing page, component, entity, field, function or style. If something in this prompt conflicts with what you find, stop and ask me rather than resolving it yourself.

==================================================
PART 0 — INSPECT THE CURRENT STATE BEFORE ANY EDIT
==================================================

0.1 Inventory and report, without changing anything:
   - Pages: every page whose name, route or content relates to the GTM dashboard (expected: Sales → GTM Dashboard, Sales → GTM Dashboard · Runs, possibly others I added). For each: route, sections present in order, components used, which entities and functions it reads or calls, and any filters, toggles or styles that differ from the standard component defaults.
   - Entities: every Gtm* entity with its current field list (names, types, enums), permissions and row counts. Flag any field, enum value or entity that is not in 03_data_model.md — those are my edits and must be preserved.
   - Backend functions: every function related to the dashboard (expected: refresh-gtm-dashboard, submit-gtm-controls, possibly split pull/build functions, possibly others). For each: inputs, what it writes, and any logic that departs from 05_hubspot_integration.md. Treat departures as intentional.
   - Config: the current GtmConfig row, including any keys that are not in seed/config.json.
   - Nav: where the dashboard pages sit in the Hub navigation and who can see them.
   - Any customizations: renamed labels, reordered sections, hidden components, extra tiles, custom colors, extra DQ flags, changed copy. List each one explicitly.

0.2 Report the inventory to me as a list and WAIT for my go-ahead before starting Part A. Mark anything you believe conflicts with Parts A–C.

0.3 Before the first edit, create a restore point: a named checkpoint / version of the app (or, if the platform has none, export the current page definitions, entity schemas and function source into a new entity GtmBuildBackup {created_at, label, payload} so they can be restored). Tell me the checkpoint name.

0.4 Rules for every later edit:
   - Add new components, sections, fields, entities and functions alongside existing ones. Where this prompt says "replaces" (e.g. the pipeline view replacing the Sales pipeline KPI group and funnels), do NOT remove the existing components: add the new view, then HIDE the superseded components behind a feature flag in GtmConfig (config.ui.show_legacy_pipeline_group, default true until I flip it) so I can compare both and switch over myself.
   - Extend existing functions by adding steps; do not rewrite them from scratch. Keep every existing output field and behavior intact. If a function must be split for runtime reasons, keep the original name as the entry point.
   - Add fields to existing entities only; never drop or retype a field. New fields must be optional so existing rows stay valid.
   - Keep my label, copy, order and style edits exactly as found. New sections follow the same conventions you observe in the existing page, not the earlier spec, where the two differ.
   - After each Part (A, B, C), re-run the Part 0.1 inventory on the touched items and confirm that nothing listed in 0.1 was removed or changed other than the additions you made. Report any diff you did not intend.

Extend the Sales → GTM Dashboard page and its refresh pipeline. The dashboard's purpose is an executive pulse check on the go-to-market org: pipeline, bookings, activity, forecast, and above all the rate of change week over week. Everything below is read-only against HubSpot, uses the Hub's component library and accessibility features, and follows the existing rule: numbers are exact and reconciled, nothing is estimated. Use the hubspot connector already configured; add no write scopes.

New metric definitions in this prompt are PROVISIONAL. Store each one in GtmConfig.config.provisional as structured JSON (name, population, formula, window, null handling) and show a small "provisional definition" badge on every tile and chart that depends on one. When I later confirm them in Notion and update GtmConfig, the badge is removed by setting provisional = false on that definition. Never hardcode a definition in page or function code; read it from GtmConfig.

==================================================
PART A — REFRESH FUNCTION ADDITIONS (refresh-gtm-dashboard)
==================================================

A1. Pull two more deal properties with the existing pulls: closed_lost_reason and closed_won_reason. Store them on GtmDeal (strings, display and summary only, never aggregated into a KPI). Add them to GtmConfig.config.pull_properties.

A2. Qualified pipeline (provisional): open deals in both in-scope pipelines whose stage is not the first stage of its pipeline (New Logo 3753890497 "Intro & Challenge", Upsell / Expansion 3752297191) and not terminal. Compute count, Σ amount, Σ units__c, Σ weighted. Store first_stage_ids in GtmConfig.config.provisional.qualified.

A3. Pipeline movement, week over week (provisional): diff this snapshot's open tier rows against the previous reconciled snapshot's open tier rows, matched on hubspot_deal_id.
   - added: open now, not open before (new or re-opened)
   - dropped_won / dropped_lost: open before, now in a won / lost stage
   - dropped_other: open before, not present now and not closed (left scope or deleted)
   - moved: open in both with a different stage and/or amount; report the net $ and units change on those deals
   - unchanged: everything else
   Each bucket carries count, amount, units. Net = current gross − prior gross and must equal added − dropped − moved_out + moved_in to the cent; fail the refresh if it doesn't. Compute twice: all open, and qualified only (qualified filter applied to both snapshots). Store the summary on GtmSnapshot.movement and the per-deal rows in a new entity GtmMovement {snapshot_id, as_of, hubspot_deal_id, name, owner_name, pipeline, bucket, prior_stage_label, stage_label, prior_amount, amount, prior_units, units, qualified_before, qualified_now, closed_lost_reason, closed_won_reason}. With no previous reconciled snapshot, movement = null.

A4. Meetings (provisional): a meeting is a New Logo deal in the pg population with demo_booked__c populated, dated by demo_booked__c as a calendar date (never timezone-shifted). Week = week ending Sunday, ET. Source bucket from deal_source__c: "OB - SDR" → SDR; "OB - AE" → AE; "IB - *" → Inbound; "EV - *" → Event; "RE - *" → Referral; "DA - *" → Data provider; blank → Unassigned. Compute, for each week from the first Sunday of the FY through the week containing as_of: total and by-source counts. Store GtmSnapshot.meetings = {weeks: [{week_end, total, by_source}], current_week, prior_week, wow_delta, trailing_4wk_avg, ytd_total}. Note in the definition that meetings on deals created before the FY are not in scope and that demo_booked__c holds only the latest date.

A5. Pulse strip inputs: add to GtmSnapshot.headline.tier1: qgross, qcount, qunits, qwtd, gcount, gunits; add headline.meetings = {current_week, prior_week}. Add the same keys to the GtmKpiHistory entry so Compare vs and week-over-week deltas work on them.

A6. Client health (provisional; companies, not deals). Add a companies pull: POST /crm/v3/objects/companies/search, lifecyclestage IN the Customer and Churn stage IDs of the company lifecycle pipeline (read them from GET /crm/v3/pipelines/companies at run time and store them in schema_check), properties: name, lifecyclestage, client_health_score, client_health_rating, client_health_detail, client_health_score_override, at_risk, at_risk_date, at_risk_reason, churned, churn_date, churn_reason, hs_active_contracts_arr, hs_active_contracts_mrr, hs_next_renewal_date, support_tickets_qtd, support_tickets_this_month, support_issues_last_90_days, support_ticket_ratio_per_100, hubspot_owner_id. Paginate to total; count must equal total.
   Count controls from search totals: customers (lifecyclestage = Customer), churned companies (lifecyclestage = Churn), churn_date in FY, at_risk = true, client_health_score HAS_PROPERTY. ARR sums have no independent control; label them "count-reconciled".
   Write GtmAccount rows per snapshot {snapshot_id, as_of, hubspot_company_id, hubspot_url, name, owner_name, lifecycle_stage, health_score, health_rating, health_override, at_risk, at_risk_date, at_risk_reason, churned, churn_date, churn_reason, arr, mrr, next_renewal_date, tickets_qtd, tickets_month, issues_90d, ticket_ratio_per_100} and one GtmAccountHistory row per account per as_of {as_of, hubspot_company_id, health_rating, health_score, at_risk, arr, tickets_qtd}. History starts accumulating from the first run; there is no backfill.
   Metrics (provisional):
   - Churn to date: companies with churn_date in the FY (fallback: entered the Churn lifecycle stage in the FY when churn_date is blank; count both and report the fallback count as a DQ item) — count and Σ arr.
   - At-risk accounts: at_risk = true among Customer-stage companies — count, Σ arr, list.
   - Expected year-end churn range: low = churn to date ARR; high = churn to date ARR + Σ arr of at-risk accounts whose next_renewal_date is on or before Dec 31 of the FY. Always shown as a range, never a point estimate.
   - Support load: Σ support_tickets_qtd, Σ support_issues_last_90_days over Customer-stage companies; population rate of each field.
   - Health distribution: count of Customer-stage companies per client_health_rating value (ordered as the HubSpot enumeration defines; "No rating" last).
   - Trend: week-over-week change in at-risk count, churned ARR, and the health distribution from GtmAccountHistory.
   Store GtmSnapshot.client_health with all of the above plus field population rates.

A7. New DQ flags, stored in GtmSnapshot.dq with their section:
   - MV-1 (movement) Medium when dropped_other.count > 0, listing the deals.
   - MT-1 (meetings) Low: how many pg rows have demo_booked__c populated vs blank.
   - CH-1 (client_health) High when fewer than 80% of Customer-stage companies have a client_health_rating.
   - CH-2 (client_health) Medium when churn_date is blank on any company in the Churn lifecycle stage (count).
   - CH-3 (client_health) Medium when hs_active_contracts_arr is blank on more than 20% of Customer-stage companies.
   - CH-4 (client_health) Low: two "health" concepts exist (client_health_* from CS, account_health_* derived from open deals); this section uses client_health_* only.

A8. Interpretation function interpret-gtm-snapshot (service role; runs after every reconciled refresh; also on demand for revops_admin). Inputs: current snapshot (headline, windows, movement, meetings, client_health, dq), the previous reconciled snapshot's headline, this snapshot's GtmMovement rows, and the dropped_lost / dropped_won deals with their closed reasons. Use this app's AI / LLM integration to produce:
   { headline: string ≤ 200 chars,
     watch_items: [ { title, why, evidence: [ { metric, value, prior, delta } ], deal_ids: [], account_ids: [] } ]  (3 to 5 items),
     lost_this_week: string,
     client_health_note: string,
     data_caveats: [string] }
   Rules, enforced in the system prompt AND validated in code: every evidence value must exist verbatim in the inputs (reject and regenerate, max 2 retries, then store status = failed_validation); causal language only when quoting closed_lost_reason / closed_won_reason / at_risk_reason text or a DQ flag; otherwise describe the change, not the cause; rank watch items by absolute dollar impact, then percent change, then count; always include a caveat when dollar_tieout = not_run, when dropped_other.count > 0, when any High DQ flag exists, or when a provisional definition is in play; never reference anything outside the inputs. Store in a new entity GtmInterpretation {snapshot_id, as_of, status (draft|approved|posted|rejected|failed_validation), content, model, generated_at, approved_by, approved_at, validation_log}.

==================================================
PART B — PAGE CHANGES (Sales → GTM Dashboard)
==================================================

Keep the existing header, global filter bar, Compare vs control, drilldown drawer, methodology and DQ accordions. Add or change the following, top to bottom. Every new tile is clickable and opens the drawer with its exact population.

B1. Pulse strip (new, directly under the filter bar; unfiltered, like Compare vs). Six compact tiles: Bookings YTD · Gross open pipeline · Qualified open pipeline · Current-quarter forecast · Meetings created this week · At-risk accounts. Each shows the value, the absolute week-over-week change (e.g. "−$4.5M", "+3"), and the percent badge against the previous reconciled snapshot, with a tooltip naming the prior as_of. No prior snapshot → values only.

B2. "This week's read" panel (new, under the Pulse strip). Shows the approved GtmInterpretation for the current snapshot: headline sentence; watch items as a compact list, each with evidence chips (metric · value · Δ) and a link that opens the drawer on its deal_ids / account_ids; "Lost this week" line; client health note; caveats in small text. Clearly labelled as AI-generated interpretation of the snapshot data, with generated time and as_of. gtm_leadership users see only approved content (or nothing, with no empty box). revops_admin users see drafts with Approve / Reject / Regenerate buttons and the validation log.

B3. Tier 1 bookings tiles: unchanged, including any edits I made to them.

B4. Pipeline view (new; intended to supersede the "Sales pipeline" KPI group and the two stage funnels, but per Part 0.4 keep those in place behind config.ui.show_legacy_pipeline_group and let me switch; the forecast tiles stay as they are):
   - Segmented control "All open · Qualified (Stage 2+)" that switches every component in this view, with the provisional badge on "Qualified".
   - Four measure tiles: Deals (count) · Pipeline $ (Σ amount) · Units (Σ units__c) · Weighted $, each with the absolute WoW change and the Compare vs badge.
   - Week-over-week waterfall chart: Prior week gross → + Added → − Dropped (won) → − Dropped (lost) → − Dropped (other) → ± Moved → Current gross. Positive steps in the weighted/green viz role, negative in the gross/neutral role, endpoints in the actual/forest role. Labels show $ and count. A toggle switches the measure to Units. Clicking a step opens the drawer with those GtmMovement rows (account, owner, prior stage → stage, prior amount → amount, closed reason where present).
   - Stage table: one row per open stage per pipeline in display order: Stage · p · Deals · $ · Units · WoW Δ deals · WoW Δ $. Clicking a row opens the drawer with that stage's current deals.
   - Forecast tiles: add the absolute WoW change next to the Compare vs percent.

B5. Meetings section (new, after the pipeline view, title "Meetings"):
   - Tiles: Meetings created this week (WoW delta) · Prior week · Trailing 4-week average · YTD total.
   - Chart: stacked weekly bars of meetings created by source bucket (SDR, AE, Inbound, Event, Referral, Data provider, Unassigned) across the FY; hover shows per-source counts. Give SDR and AE distinct colors; keep Inbound in the weighted/green role.
   - Drilldown: clicking a bar or tile opens the drawer listing deals (account linking to HubSpot, meeting date, source bucket, SDR owner, deal owner, stage, amount, units) with a source filter inside the drawer.
   - Respects the global filters and the Native-only toggle. Provisional badge on the section title.

B6. Tier 2 remaining charts (cumulative forecast, by segment, by owner) and Tier 3 deal table: unchanged. Pipeline Generation and SDR sections: unchanged. "Unchanged" means exactly as found in Part 0, not as described in any earlier document.

B7. Client health section (new, after SDR pipeline generation, title "Client health", provisional badge; sub-line says it uses the Customer population and ignores the deal filters):
   - Tiles: Churned YTD (count · ARR) · At-risk accounts (count · ARR) · Expected year-end churn range (low – high ARR, definition in the sub-line) · Support tickets QTD (with issues last 90 days in the sub-line). WoW deltas and Compare vs badges on each.
   - Health distribution bar: Customer-stage companies by client_health_rating, with the prior week's distribution as a faint overlay and per-rating WoW deltas.
   - At-risk accounts table: account (links to the HubSpot company record), rating, at-risk reason, at-risk date, ARR, next renewal, tickets last 90 days, owner; sortable; default ARR desc.
   - Trend chart: at-risk count and churned ARR by week from GtmAccountHistory. Empty state until at least two weeks exist: "Trend starts accumulating from the first refresh after this section went live."
   - Field-population note under the tiles: "{pct}% of customers have a health rating · {pct}% have contract ARR" from the population rates, so sparse data is visible rather than hidden.

B8. Methodology accordion: add the provisional definitions verbatim from GtmConfig, marked provisional, plus a line that movement is a diff of two reconciled snapshots with no HubSpot control of its own, and that ARR sums are count-reconciled only.

B9. DQ accordion: include the new MV / MT / CH flags with their sections.

==================================================
PART C — SLACK AND ADMIN
==================================================

C1. Interpretation posting: for the first four weeks nothing posts automatically. When a revops_admin approves a draft, post the headline and watch items as a THREADED REPLY under that week's existing pre-read message in the Go-To-Market channel (ask me for the channel ID and how to locate the pre-read; do not create a separate top-level post). Never post a draft, never post when the refresh didn't reconcile. Keep the existing #gtm_leadership refresh post unchanged.

C2. Admin Runs page: per snapshot, show the movement summary (added / dropped / moved / net), meetings current vs prior week, client-health counts and controls, interpretation status, and expand-to-view JSON for each.

C3. Access: unchanged (gtm_leadership, revops_admin, admins).

==================================================
WHEN DONE
==================================================
With no filters applied, show me:
0. The post-build inventory diff against Part 0.1: everything added, and confirmation that nothing pre-existing was removed or changed, with the checkpoint name to restore if I disagree.
1. The Pulse strip values and deltas.
2. The movement block (all and qualified) and proof that added − dropped − moved_out + moved_in = current gross − prior gross to the cent.
3. Meetings current week, prior week, YTD total, and confirmation that YTD total equals the count of pg rows with demo_booked__c populated.
4. The client_health block, its count controls, and the field population rates.
5. The generated interpretation JSON and its validation log.
6. Which sections carry the provisional badge.
```

---

## After it's built

1. Write the provisional definitions into Notion → Metric Definitions (Meeting created, Qualified pipeline, Pipeline movement, Pulse strip, Churn to date, At-risk accounts, Expected year-end churn range, Support load, Client health distribution, Health trend), set Status = Confirmed, add `row_to_config_map` entries, mirror into `seed/config.json` and the `GtmConfig` row, and flip `provisional = false`. Two open questions for Will and Brian: do meetings on deals created before the FY count, and does "Stage 2+" include Trial and Implementation?
2. Decide whether the Base44 interpretation thread replaces or supplements the existing pre-read, so only one system posts.
3. Optionally route the refresh function's failure notification to the new automation error channel so Ray triages it with everything else.
