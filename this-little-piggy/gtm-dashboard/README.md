# GTM executive dashboard — build kit

Self-contained HTML dashboard for CRO / VP Sales / Marketing / CS leadership, sourced from HubSpot portal `243635806`. Three sections: **Tier 1–3** (closed-won bookings, open and weighted pipeline, forecasts, funnels, deal table), **Pipeline Generation** (New Logo deals created in the fiscal year: pacing, weekly creation, source, owner, create-month × close-month heatmap, Swan score), and **SDR pipeline generation** (added 2026-09-23/28: meeting booked→held and held→opportunity conversion, opportunities generated per SDR, pipeline vs. goal by segment, channel mix, stage progression by channel — same New Logo FY population as Pipeline Generation, not a separate pull).

Everything about *how* a number is calculated lives in Notion → **Data Definitions** (Reporting & Analytics section of the Revenue Operations wiki). `config.json` here mirrors those definitions and must match; the refresh skill checks that first and stops on drift.

## Layout

```
gtm-dashboard/
├── README.md          this file
├── config.json        confirmed decisions (mirror of Notion Data Definitions)
├── schema.md          exact shape of every file in data/
├── build.py           data/*.json → output/*.html + tieout.md; exits non-zero on tie-out failure
├── qa.py              headless render check of the built file
├── template.html      dashboard shell — brand tokens, inline SVG charts, filters, drilldowns, methodology blocks
├── data/              written by each refresh (ships with the 2026-09-14 snapshot as a working example)
├── runs/runs.jsonl    one line per successful build — counts and totals for drift review
└── output/            built dashboard(s), tieout.md, qa_screenshot.png
```

## Refresh — the short version

The `gtm-dashboard-refresh` skill (`.claude/skills/gtm-dashboard-refresh/SKILL.md` at the repo root) does all of this. Run it in Claude Code with HubSpot, Notion, Google Drive and Slack connected:

> Refresh the GTM dashboard.

It runs weekly as a Claude Code Routine (Mondays 08:00 ET). The manual procedure below is what the skill executes; use it to debug a failed run.

## Refresh procedure (manual)

**0. Preflight.** Read `config.json`. Fetch the Notion Data Definitions database and compare every metric row whose *Used by* includes "GTM executive dashboard", "Pipeline Generation section", or "SDR section" against `config.json` (the 8 SDR-section rows are `Category = SDR` in the Metric Definitions database; `config.notion.preflight_query` already includes them). Any difference → stop; fix one side, re-run. Set `as_of` = today's date in ET.

**1. Verify schema.** `get_properties` for every name in `config.pull_properties` (this now includes `sdr_owner`, `demo_booked__c`, `demo_completed__c`, `deal_source_group` for the SDR section) plus `weighted_amount`; `get_properties companies swan_score`. Re-derive the stage → probability map from live deals (query in `schema.md`). `search_owners` for any `hubspot_owner_id` **or `sdr_owner`** value not yet in the owners map — these are frequently different people (SDR owner and deal owner are different concepts; do not assume overlap). Any missing property or a new terminal stage → stop.

**2. Controls.** `query_crm_data` aggregates → `data/controls.json`. The original six, plus five more added with the SDR section (2026-09-23/28) — all against the identical population window (pull controls and records in the same session, immediately after each other, same as every other section):
1. open: `pipeline, COUNT(*), SUM(amount), SUM(hs_projected_amount), SUM(weighted_amount)` for open stages in both pipelines
2. won FY: `pipeline, COUNT(*), SUM(amount), SUM(acv), SUM(units__c)` for won stages, `closedate` in FY
3. created FY: `hs_object_source_label, COUNT(*), SUM(amount)` for New Logo, `createdate` in FY
4. created FY by `deal_source_drill_down`
5. created FY by `company.swan_score`
6. any row whose `SUM(amount)` you will later tie to
7. **SDR opportunities total**: `COUNT(*), SUM(amount)` for New Logo FY deals where `sdr_owner IS NOT NULL`
8. **SDR opportunities by channel**: same population, `GROUP BY deal_source_group` (raw values are capitalized — `Outbound`/`Inbound`/`Referral`/`Event` — not lowercase; a `query_crm_data` aggregate's TSV display normalizes them lowercase, which does not match the raw `search_crm_objects` value `build.py` actually compares against — verify against a live record sample, not just the aggregate's display, if this ever looks like a mismatch)
9. **SDR meeting booked, trailing 30d**: `COUNT(*)` for New Logo FY deals where `demo_booked__c` falls in `[as_of − 29 days, as_of]` (ET, inclusive)
10. **SDR meeting held, trailing 30d**: same, plus `demo_completed__c = 'Yes'`
11. **SDR held → opportunity, trailing 30d**: same, plus `sdr_owner IS NOT NULL`
12. **SDR opportunities generated, trailing 30d**: `COUNT(*), SUM(amount)` for New Logo FY deals where `sdr_owner IS NOT NULL` and `createdate` falls in the same trailing-30-day window (a different window basis than #7 — createdate, not demo_booked__c)

**3. Pull.** Three `search_crm_objects` pulls with the full `pull_properties` list, paginated to `total` → `deals_open.json`, `deals_won.json`, `deals_created.json` (the SDR section reads its population out of `deals_created.json` — no separate pull). One `query_crm_data` for `company.swan_score IS NOT NULL` → `swan_scores.json`. Write `snapshot.json`, including any newly-resolved `sdr_owner` names from step 1. Returned count ≠ reported `total` → stop.

**4. Build.** `python build.py`. Exit 0 = reconciled and written. Exit 2 = tie-out miss — the stderr lines name the measure; the usual cause is a record created or edited between steps 2 and 3 (re-run 2 and 3 together). Exit 3 = schema problem (unknown stage or owner, null amount) — the message says which.

**5. QA.** `python qa.py`. Needs Playwright for the render checks; without it you get a syntax check only and a note saying so.

**6. Deliver — success only.** Upload `output/findigs_gtm_executive_dashboard_<as_of>.html` to Google Drive folder `1rFO4rDgvUZuf03NHeSdzDJT4MCEVy0Tb` (Revenue Operations / Reporting & Analytics). **Known limitation, confirmed 2026-09-28:** the file (500KB+, growing with each new section and each week of Compare-vs history) is too large for the Drive connector's `create_file` tool — its content must pass through a single model-generated tool call, and this file exceeds that call's practical size ceiling. There is no chunked/resumable/path-based upload in the available Drive toolset. If the upload fails for this reason, do not keep retrying it — tell Will directly and give him the file's path in this repo/branch so he can upload it himself; this is a standing, structural limitation, not a transient error to work around. Once uploaded (by either path), post to `#gtm_leadership` (`C0C1P09SPFF`) with the file link and the headline numbers from `tieout.md` (now including the SDR section's), and send Will a short success DM. Commit `data/`, `runs/`, `output/tieout.md` to the repo (the HTML is large; commit it only if you want the history).

**If any step 0–5 stops the run, none of the above happens.** Instead, DM Will (`U0BQ5AZK284`) the failure note — see the skill's "Failure note format" section. `#gtm_leadership` never receives a failure, an error, or a partial run; it only ever sees a working dashboard. If Slack itself is unreachable, fall back to the Routine log / chat response, since there's no DM to send.

## Decisions log

| Date | Decision | Where it lives |
|---|---|---|
| 2026-09-14 | `amount` is the bookings and pipeline field; `acv` rejected (populated on 5 of 71 won deals) | config.fields |
| 2026-09-14 | Calendar fiscal year | config.fiscal_year |
| 2026-09-14 | Segment derived from `units__c`: SMB < 3,000 · Mid-Market 3,000–19,999 · Enterprise ≥ 20,000 | config.segment_rule |
| 2026-09-14 | Renewal pipeline excluded | config.pipelines.renewal |
| 2026-09-14 | Sales cycle = close date − create date, all won deals, migration cohort tagged | config.migration |
| 2026-09-14 | Pipeline Generation: New Logo only; migrated records included with footnote + native-only toggle | config.pipeline_generation |
| 2026-09-14 | Source = `deal_source_drill_down` (replaced `deal_source__c`) | config.fields.source |
| 2026-09-14 | Fit = company `swan_score` via deal → company association (replaced `hs_deal_score`) | config.fields.company_fit_score |
| 2026-09-14 | Weighted = `weighted_amount` when populated, else `amount × hs_deal_stage_probability`; won = 100%; lost = $0 | config.weighting_rule |
| 2026-09-22 | Distribution: Drive folder + `#gtm_leadership`; weekly Monday 08:00 ET routine; repo `willritchings-findigs/this-little-piggy` | config.distribution |
| 2026-09-22 | Success refreshes post to `#gtm_leadership`; any error or stop is DM'd directly to Will instead — the channel never sees a failure | config.distribution.slack_dm_user_id |
| 2026-09-23 | SDR section added: 6 metrics (conversion rates, opportunities per SDR, pipeline vs. goal by segment, channel mix, stage progression by channel), confirmed in Notion Metric Definitions (`Category = SDR`) | config.sdr_section |
| 2026-09-23 | SDR owner field = `sdr_owner` (not `sdr_owner_new`, which diverges heavily on the same deals — a team-reassignment pattern, not a completeness difference) | config.fields.sdr_owner / config.fields.not_used.sdr_owner_new |
| 2026-09-23 | SDR channel mix source = `deal_source_group` (independently set from `deal_source_drill_down` and `attribution_source_drill_down` — not a lookup of either) | config.sdr_section.channel_buckets |
| 2026-09-23 | Pipeline goal by segment: no quota file exists; placeholder 0 = "not configured" for every segment, never estimated, percent-to-goal suppressed | config.sdr_section.goal_by_segment |
| 2026-09-28 | Re-checked against a live FY2027 capacity/quota workbook that appeared in Drive — does not supersede the placeholder (wrong fiscal year, scenario-based, different segment taxonomy) | config.sdr_section.goal_by_segment.note |

## Prerequisites

- Python 3.11+ (standard library only; `zoneinfo` needs the `tzdata` package on minimal images: `pip install tzdata`)
- Node (any recent) for the JS syntax check in `qa.py`
- Optional: Playwright + Chromium for full QA (`pip install playwright && playwright install chromium`)
- Claude Code connectors for the skill: HubSpot, Notion, Google Drive, Slack. The Slack identity attached to the Routine must be a member of `#gtm_leadership` (private).

## Routine setup

Repository `willritchings-findigs/this-little-piggy`. Connectors: HubSpot, Notion, Google Drive, Slack. Schedule: weekly, Monday 08:00 America/New_York. Prompt:

```
Run the gtm-dashboard-refresh skill now, exactly as written in its SKILL.md. This is an unattended run: if the Notion Data Definitions diff shows drift, a HubSpot property is missing, a pull count does not match its total, build.py exits non-zero, or qa.py fails, stop at that step. On any stop, DM me (Slack user U0BQ5AZK284) the failure note — do not post anything to #gtm_leadership in that case. #gtm_leadership should only ever receive a post when the refresh fully succeeds. Never edit anything in HubSpot or Notion.
```

Before the channel post reaches anyone but you, confirm the Slack identity the Routine runs under is actually a member of `#gtm_leadership` (private channel) — a DM to `U0BQ5AZK284` works regardless, but the success post will silently fail otherwise.

Test with **Run now** before trusting the schedule.

## Known limitations

- Snapshot, not live. Header shows the pull time.
- Stage probabilities are observed from deal records, not read from pipeline settings (the connector does not expose them).
- The dashboard's brand font and logo load from the Findigs CDN and fall back to system font / text wordmark offline. Data and charts never need the network.
- `weighted_amount` is populated on roughly half of open deals; the fallback rule covers the rest and each fallback deal is tagged.
- The built HTML has outgrown the Drive connector's upload tool (see Step 6) — plan for a manual upload step until that's resolved.
- SDR section: `sdr_owner_new` and `attribution_source_drill_down` exist in HubSpot and are actively used by several live, currently-configured HubSpot saved reports, but this dashboard deliberately does not use either (see `config.fields.not_used` and DQ flags SDR-1/SDR-2 in the built file). If Findigs' live SDR reporting is ever reconciled onto a single field, update the Notion Metric Definitions rows first, then `config.json`, then re-run — never the reverse.
