# Base44 build prompts — GTM executive dashboard in the Findigs Hub

Paste these into the Base44 builder for the **Findigs Hub** app, one stage at a time, in order. Each stage ends with a check; don't start the next until it passes. Where a stage says "attach", upload the named file from this folder (or paste its contents) in the same message.

**Design posture for every stage.** The dashboard lives as a **new page in the Findigs Hub at Sales → GTM Dashboard**. It does not need to be a pixel copy of the current HTML file. Build it with the Hub's existing component library, theme, typography, navigation and accessibility features (keyboard navigation, focus states, contrast, responsive layout, screen-reader labels) so it feels native to the Hub. `02_design_spec.md` is guidance for information architecture, chart encodings, data-viz colors, formatting and states, not a pixel contract. What *is* exact: every number, window, filter rule and data-quality flag in `04_metric_definitions.md`.

Before Stage 1: connect the HubSpot connector in the app's connectors panel as the app builder, read-only scopes only: `crm.objects.deals.read`, `crm.objects.companies.read`, `crm.objects.owners.read`, `crm.schemas.deals.read`, `crm.schemas.pipelines.read`.

---

## Stage 1 — Entities, config, seed data

> Attach: `03_data_model.md`, `seed/config.json`, `seed/stages.json`, `seed/owners.json`, `seed/kpi_history.json`

```
I'm adding a GTM executive dashboard module to this app. It's a weekly, read-only snapshot of HubSpot deal data for revenue leadership. In this stage, create the data layer only. No UI yet beyond an admin page that lists snapshots.

Create seven entities exactly as specified in the attached 03_data_model.md, with the field names, types, enums and descriptions given there:
- GtmConfig (singleton that mirrors the attached config.json)
- GtmStage
- GtmOwner
- GtmSnapshot
- GtmDeal
- GtmKpiHistory
- GtmControlDocument

Rules:
1. All writes to these entities come from backend functions running as service role. Regular users never create, update or delete rows. Set entity permissions accordingly.
2. Reads: for now, restrict every Gtm* entity to admin users. I'll widen access in a later stage.
3. GtmDeal will hold roughly 1,000 rows per snapshot and we keep up to 4 snapshots, so make sure snapshot_id and population are indexed/filterable and that listing by snapshot_id + population is efficient.

Seed data (import, don't retype):
- GtmConfig: one row, version = "2026-10-29", portal_id = "243635806", timezone = "America/New_York", config = the entire attached config.json object verbatim, is_active = true.
- GtmStage: the 14 rows in stages.json (map: id → stage_id, label, pipeline → pipeline_id, pipeline "2313721535" → pipeline "N", "2313830082" → "U", probability, won, lost, order → display_order).
- GtmOwner: the 15 rows in owners.json.
- GtmKpiHistory: the 12 entries in kpi_history.json (asOf → as_of; tier1, pg, sdr objects verbatim; snapshot_id blank).

Admin page "GTM Dashboard · Runs" (admins only), created as a new page under Sales in the Hub navigation (it will sit next to the dashboard page added in Stage 3; hide it from non-admins): a table of GtmSnapshot rows sorted by pulled_at desc with as_of, status, is_current, trigger, counts.open_n / won_n / created_n, dollar_tieout, duration_ms, and a details drawer showing count_controls, dollar_controls, dq, stage_notes and error. Add a "Refresh now" button that is disabled with the note "function not deployed yet" until Stage 2.

Do not invent any additional fields or entities. Do not add sample GtmDeal or GtmSnapshot rows.

When done, show me the entity list with field counts and confirm the seed row counts (1 / 14 / 15 / 12).
```

**Check:** entity field counts match `03_data_model.md`; seed counts 1 / 14 / 15 / 12; a non-admin user cannot read any Gtm* entity.

---

## Stage 2 — The refresh backend function

> Attach: `05_hubspot_integration.md`, `03_data_model.md` (again), `04_metric_definitions.md`, `seed/controls_2026-11-23.json`

```
Build the backend function refresh-gtm-dashboard exactly as specified in the attached 05_hubspot_integration.md, using the derivation rules in 03_data_model.md and the formulas in 04_metric_definitions.md. Read those three documents fully before writing code.

Non-negotiables:
1. Read-only against HubSpot. The function may call only: GET /crm/v3/properties/..., GET /crm/v3/pipelines/deals, POST /crm/v3/objects/deals/search, GET /crm/v3/owners, POST /crm/v4/associations/deals/companies/batch/read, POST /crm/v3/objects/companies/batch/read. Nothing else. Use the app's "hubspot" connector via base44.asServiceRole.connectors.getConnection("hubspot").
2. Never estimate, impute or backfill a value HubSpot returned blank. The only permitted handling of blanks is the documented rules: weighted fallback (amount × probability), "Unassigned" source, "No Swan score", "Unresolved owner <id>". A null amount or null units__c fails the run.
3. Stop on anything that doesn't reconcile. Every validation and tie-out failure sets GtmSnapshot.status = "failed" with the verbatim reason, deletes any GtmDeal rows written for that snapshot, and leaves the previous current snapshot untouched. A failed run must never become is_current.
4. Read all definitions from the GtmConfig row (pipelines, terminal stages, field names, segment bands, migration cutoff, SDR rules, tolerance). Do not hardcode IDs or thresholds in the function. Fail with "config missing" if the GtmConfig row is absent.
5. All date bucketing in America/New_York. Use the etMidnightMs helper from the spec for closedate/createdate filters. demo_booked__c is a date property: compare as a calendar date, never timezone-shift it.
6. Throttle HubSpot search calls to 4 per second; retry 429/5xx three times with backoff; any other error fails the run with status, endpoint and body in the error field.
7. Input: { as_of?: "YYYY-MM-DD", trigger: "manual" | "schedule" | "api", controls?: {...} }. Default as_of = today in America/New_York.
8. Authorization: manual runs only from users with role "revops_admin" or the app owner; otherwise 403. Record triggered_by.

Implement the run in the documented order: create snapshot (running) → schema check → record pulls → count controls (search totals) → owners → Swan join → derive and validate → optional dollar tie-out against the controls input or a GtmControlDocument for the same as_of → write deals → upsert GtmKpiHistory (replace same as_of, drop entries older than 26 weeks) → mark reconciled → flip is_current → prune deal rows older than the 3 most recent reconciled snapshots.

The headline block must use exactly these keys: tier1 {qtd, ytd, asp, cycle, nl, ue, gross, wtd, fq, fy}, pg {cqtd, cytd, nqtd, nytd}, sdr {booked30, held30, opp30, heldopp30, oppTotal, oppTotalAmt}.

Compute the data-quality flags listed in 04_metric_definitions.md (DQ-1..12, PG-1..8, SDR-1..7) with their severity rules and store them in GtmSnapshot.dq as [{id, severity, finding, count, handling, section}], where section is "tier", "pg" or "sdr". DQ-9 becomes informational: probabilities are read from pipeline settings.

Also add a small function submit-gtm-controls (revops_admin only) that stores a GtmControlDocument {as_of, source, controls}. Validate that controls has every key present in the attached controls_2026-11-23.json.

Wire the admin page's "Refresh now" button to refresh-gtm-dashboard with trigger "manual", polling the new GtmSnapshot row every 3 seconds and showing status, failed_step and error. Add a "Submit controls" form (paste JSON) that calls submit-gtm-controls.

If the runtime limit is too short for a full run, split the work into refresh-gtm-pull and refresh-gtm-build as described in the spec, chained server-side, and tell me you did so.

When done: run it once with trigger "manual" and show me the resulting GtmSnapshot (status, counts, headline, every count_controls row, dq ids with severities, duration_ms, hubspot_calls).
```

**Check:** status `reconciled`; every `count_controls.ok = true`; counts within a few deals of 108 / 76 / 762 (they drift week to week); `dollar_tieout = not_run`. Then submit `seed/controls_2026-11-23.json` with `as_of = 2026-11-23` and re-run with `as_of: "2026-11-23"`: if the run is on the same Monday the dollar tie-out must pass; on a later date it will fail on counts, which is correct behavior, so delete that test snapshot.

---

## Stage 3 — Dashboard page: header, filters, Tier 1–3

> Attach: `02_design_spec.md`, `04_metric_definitions.md`

```
Create a NEW page in this app at Sales → GTM Dashboard (add it to the Sales section of the Hub navigation; do not modify any existing page). The page renders the current GtmSnapshot (is_current = true) and its GtmDeal rows.

Design posture: build the page with this app's existing component library, theme, typography, spacing and accessibility features (keyboard navigation, focus states, contrast, responsive breakpoints, aria labels) so it looks and behaves like the rest of the Findigs Hub. Use the attached 02_design_spec.md as guidance for information architecture, section order, which charts exist and how they're encoded, data-viz colors, number formatting and empty/loading/stale states. It does not need to match the reference HTML pixel for pixel. Where the spec and the Hub's design system disagree on chrome, components or type, follow the Hub. Where they disagree on a data-viz color role, chart encoding or number format, follow the spec. Follow 04_metric_definitions.md exactly for every number; nothing there is optional.

This stage covers the header, the filter bar, Tier 1 (10 KPI tiles), Tier 2 (five charts) and Tier 3 (deal table), plus the drilldown panel. Pipeline Generation and SDR come in the next stage; leave placeholder sections for them.

Data loading:
- Load the current GtmSnapshot, then its GtmDeal rows where population = "tier" (one query), then rows where population = "pg" (one query, needed for the owner filter list and the next stage). Hold them in page state; all filtering and aggregation happens client-side. Never query HubSpot from the page.
- If no reconciled snapshot exists, render the empty state from the spec.

Use the Hub's existing theme tokens and fonts. Only add the data-viz color roles from spec §1 (actual, gross, weighted, count, unassigned) as page-scoped tokens if the Hub's theme has no equivalents, and map them to the Hub's palette where it does. Don't load new fonts and don't use Google Fonts. Don't change the Hub's global styles.

Page header (spec §3, using the Hub's standard page header component; the Hub's own logo and nav already exist, so don't add another logo): title "GTM Dashboard", sub-line; right side shows "Data last refreshed {pulled_at_label}", the as-of line with the current quarter label and dates from snapshot.windows, and the scope pill with the filtered tier row count. Show the stale chip when as_of is more than 8 days old and the "did not reconcile" chip when the most recent GtmSnapshot is failed.

Filter bar (spec §3), built from the Hub's existing filter/select/date-picker components: Deal owner (multi, options = union of owner_name across tier AND pg rows), Deal stage (multi, grouped by pipeline using GtmStage display order), Segment (multi), Amount min/max, Units min/max, Close date from/to, Compare vs (build the control now but leave it hidden; Stage 5 wires it), Reset. Sticky under the Hub header if the Hub supports sticky toolbars; otherwise at the top of the page. Filters are global state shared by every section.

Filtering rule (same as the reference implementation): a row passes when owner_name ∈ selected owners AND stage_id ∈ selected stages AND segment ∈ selected segments AND amount within range AND units within range AND close_date within range (null close_date fails a date range only when a bound is set).

Tier 1 tiles, computed from the filtered tier rows exactly as 04_metric_definitions.md says: Bookings QTD, Bookings YTD, Average sales price, Average sales cycle (with the migration-cohort warn chip and post-cutoff secondary figure), New Logo bookings YTD, Upsell / Expansion bookings YTD, Gross open pipeline, Weighted open pipeline (stored / fallback split in the sub-line), Current-quarter forecast, Current-year forecast. Use snapshot.windows for the QTD/YTD windows; do not recompute them in the browser. Leave the Compare badge element in each tile empty for now. Every tile is a button that opens the drilldown drawer with that tile's population and the definition text from the spec.

Tier 2: cumulative forecast line chart, two stage funnels, by-segment grouped bars, by-owner horizontal grouped bars, per spec §5 rows T2-1 to T2-5. Use whatever charting library this app already uses (Recharts if none). Keep the encodings and color roles from the spec; tooltips, legends and empty states as specified.

Tier 3: the deal table using the Hub's table component, sortable, default amount desc, with the tags, HubSpot links and table note from spec §4.

Drilldown: use the Hub's drawer or side-panel component; contents per spec §4.

Number and date formatting per spec §6; put the formatters in one shared utility and use it everywhere (tiles, axes, tables, tooltips).

Access for now: admins only (same as the entities). 

When done, with no filters applied, list the ten Tier 1 values the page shows next to the values in GtmSnapshot.headline.tier1 so I can confirm they're identical.
```

**Check:** the ten values match the headline block exactly; the scope pill equals `open_n + won_n`; each tile opens the drawer with the right row count (gross tile = `open_n`).

---

## Stage 4 — Pipeline Generation and SDR sections

> Attach: `02_design_spec.md`, `04_metric_definitions.md` (again)

```
Add the two remaining sections to the GTM executive dashboard page, using the GtmDeal rows with population = "pg" already loaded, filtered by the same global filters, following 02_design_spec.md §5 (rows PG-1 to PG-7 and SDR-1 to SDR-5) and 04_metric_definitions.md (Pipeline Generation and SDR sections).

Section "Pipeline generation":
- Header with the title, sub-line from the spec, and the "Native HubSpot records only" toggle (removes rows with migrated = true from this section and from the SDR section).
- Four KPI tiles: Gross pipeline created QTD, Gross pipeline created YTD, Deals created QTD, Deals created YTD, with the sub-lines defined in the metrics doc (migrated chip, won/lost/open split, average per deal). Each opens the drilldown drawer in "gross" mode (Created and Source columns).
- Pacing · current quarter (with the prior-quarter column at the same elapsed-day count) and Pacing · current year (no prior column) as pace tables. Weeks elapsed and weeks in period are computed from snapshot.windows and snapshot.as_of exactly as defined.
- Pipeline created by week (stacked migrated / native), by source (hover shows the parent deal_source__c split), by deal owner, the create-month × close-month heatmap with totals and the exclusion note, and by Swan score with the fixed band order and coverage legend.
- A collapsible "Pipeline generation · sources and methodology" accordion rendering the scope, fields, formulas and the PG-* flags from GtmSnapshot.dq where section = "pg", with the severity pills and a "{n} flags" badge.

Section "SDR pipeline generation":
- Header and sub-line per spec.
- Four KPI tiles: Meetings booked (30d), Meetings held (30d), Held → opportunity (30d), Opportunities generated (30d), with the sub-lines defined. Trailing window from snapshot.windows.sdr30.
- Meeting booked → held conversion by segment; Opportunities generated per SDR (exclude sdr_owner_id "8309346" from the chart, note it in the legend); Pipeline generated vs goal by segment table reading goals from GtmConfig.config.sdr_section.goal_by_segment (goal 0 → "not configured" chip, never a percentage); Channel mix with the fixed four-bucket order and colors; Stage progression by channel using GtmStage display order for pipeline N.
- A collapsible "SDR section · sources and methodology" accordion with the SDR-* flags.

Then add, below both sections, the page-level "Data quality flags" accordion (tier-section flags DQ-1..12 with severity pills and a High count badge) and the "Sources and methodology" accordion (scope and windows text, the KPI definitions table from the metrics doc, and the count_controls / dollar_controls tables from the snapshot labelled "Validation tie-out"). Finish with the footer from the spec.

When done, with no filters, list the eight PG/SDR tile values next to GtmSnapshot.headline.pg and .sdr, and tell me the Swan coverage sentence the legend shows.
```

**Check:** eight values match the headline block; toggling Native only lowers Pipeline created YTD by the migrated amount in PG-1; the Swan legend reads "{scored} of {total} deals ({pct}%)".

---

## Stage 5 — Compare vs, access, scheduling, Slack

> Attach: `02_design_spec.md`, `06_qa_checklist.md`

```
Finish the GTM executive dashboard.

1. Compare vs. Load GtmKpiHistory sorted by as_of. The current entry is the one matching the current snapshot's as_of; prior entries are everything earlier, newest first. If there are no prior entries, hide the Compare vs control and render no badges. Otherwise populate the dropdown with prior as_of dates (first option suffixed "(most recent)"), default to the first, and on every tile render the badge: delta = (current − prior) ÷ |prior| using the same keys (tier1.qtd ↔ Bookings QTD tile, etc.; pg.* for the four Pipeline Generation tiles; sdr.booked30/held30/heldopp30/opp30 for the SDR tiles). Prior 0 → "new" (blank if current also 0); either side missing → blank; |delta| < 0.0005 → flat. Colors and arrows per 02_design_spec.md §4. Badges compare the unfiltered history values and must not change when page filters change. Tooltip "vs {prior as_of}: {prior value formatted}".

2. Access. Create a Hub role or group "gtm_leadership". Users in gtm_leadership, revops_admin, or admins can open the dashboard page and read GtmSnapshot, GtmDeal, GtmKpiHistory, GtmStage, GtmOwner and GtmConfig. Nobody else can read them. Only revops_admin and admins see the Refresh now button, the Runs admin page and the Submit controls form. Keep GtmControlDocument admin-only. The Sales → GTM Dashboard page and the Sales → GTM Dashboard · Runs admin page appear in the Hub navigation only for the groups allowed to open them.

3. Scheduling. If this app supports scheduled function triggers, schedule refresh-gtm-dashboard every Monday at 08:00 America/New_York with input { "trigger": "schedule" }. If it doesn't, expose the function so it can be called by an external scheduler with the app's service key and tell me the exact URL and auth header to use.

4. Slack (optional; ask me before enabling it). Using the "slack" connector: on a reconciled run post the channel message from 05_hubspot_integration.md to channel C0C1P09SPFF built only from the snapshot headline block, then DM user U0BQ5AZK284 the success note. On any failed run DM U0BQ5AZK284 the failure note and post nothing to the channel. Numbers in the post must come from the headline block, formatted with the shared formatter at full precision (cents), never typed.

5. States per 02_design_spec.md §8: loading skeletons, no-snapshot, stale, and refresh-failed chips.

6. Run through the attached 06_qa_checklist.md sections B, C, E, F and G yourself and report each item as pass or fail with the observed value. Don't fix numbers by changing formulas; if a value is off, tell me which one and by how much.
```

**Check:** everything in `06_qa_checklist.md`. Section D (cross-check with the HTML build) is done by a person, with the Routine's output for the same Monday open side by side.

---

## Follow-up prompts you may need

**When a render drifts from the Hub or from the spec**
```
The {component} doesn't look like the rest of the Hub / doesn't follow 02_design_spec.md §{n}. Rebuild only {component} using the Hub's {component library name} component, keeping the data encoding from the spec: {what's wrong}. Don't touch any number or formula.
```

**When a number disagrees with the HTML build**
```
{Tile} shows {a} but GtmSnapshot.headline.{key} is {b}. The headline block is correct by definition (it's what reconciled). Find where the page's computation diverges from 04_metric_definitions.md and fix the page, not the function.
```

**When the function fails a count control**
```
Show me the count_controls row(s) with ok = false, the exact search filter you sent for the control, and the filter you sent for the pull. They must be the same population. Don't change the tolerance and don't drop the check.
```

**Never ask the builder to**
- change a metric definition, window, threshold or field mapping (those change in Notion, then `seed/config.json`, then the `GtmConfig` row);
- make a failed run current, or skip a failing tie-out "for now";
- write to HubSpot;
- type numbers into a Slack message.
