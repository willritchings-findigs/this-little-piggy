# GTM executive dashboard — build kit

Self-contained HTML dashboard for CRO / VP Sales / Marketing / CS leadership, sourced from HubSpot portal `243635806`. Three sections: **Tier 1–3** (closed-won bookings, open and weighted pipeline, forecasts, funnels, deal table), **Pipeline Generation** (New Logo deals created in the fiscal year: pacing, weekly creation, source, owner, create-month × close-month heatmap, Swan score), and **SDR pipeline generation** (added 2026-09-23 — meeting booked/held and held/opportunity conversion, opportunities per SDR, pipeline vs. segment goal, channel mix, stage progression; definitions in `config.sdr_section`).

Every KPI tile in all three sections also carries a week-over-week `%`-change badge (added 2026-09-24), driven by a "Compare vs" dropdown defaulting to the most recent prior dashboard version. `build.py` derives this by re-parsing every historical `output/*.html` file it finds on disk — see "Historical comparison" below.

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
├── data/              written by each refresh (overwritten every run — always the latest pull)
├── runs/runs.jsonl    one line per successful build — counts and totals for drift review
└── output/            every built dashboard version (kept, not overwritten — see "Historical comparison"), tieout.md, qa_screenshot.png
```

## Refresh — the short version

The `gtm-dashboard-refresh` skill does all of this (it's an org-level Claude Code skill, not a file in this repo — see claude.ai skill settings to view or edit its source). Run it in Claude Code with HubSpot, Notion, Google Drive and Slack connected:

> Refresh the GTM dashboard.

It runs weekly as a Claude Code Routine (Mondays 08:00 ET). The manual procedure below is what the skill executes; use it to debug a failed run.

## Refresh procedure (manual)

**0. Preflight.** Read `config.json`. Fetch the Notion Data Definitions database and compare every metric row whose *Used by* includes "GTM executive dashboard" against `config.json`. Any difference → stop; fix one side, re-run. Set `as_of` = today's date in ET.

**1. Verify schema.** `get_properties` for every name in `config.pull_properties` plus `weighted_amount`; `get_properties companies swan_score`. Re-derive the stage → probability map from live deals (query in `schema.md`). `search_owners` for any `hubspot_owner_id` not yet in the owners map. Any missing property or a new terminal stage → stop.

**2. Controls.** Six base `query_crm_data` aggregates plus the SDR controls → `data/controls.json`:
1. open: `pipeline, COUNT(*), SUM(amount), SUM(hs_projected_amount), SUM(weighted_amount)` for open stages in both pipelines
2. won FY: `pipeline, COUNT(*), SUM(amount), SUM(acv), SUM(units__c)` for won stages, `closedate` in FY
3. created FY: `hs_object_source_label, COUNT(*), SUM(amount)` for New Logo, `createdate` in FY
4. created FY by `deal_source_drill_down`
5. created FY by `company.swan_score`
6. any row whose `SUM(amount)` you will later tie to
7. SDR opportunity count/amount by `sdr_owner` and by `deal_source_group` (created FY)
8. SDR meeting booked/held and opportunities-created, all in the trailing 30 days by owner

For #8, always use a `GROUP BY`-shaped query or a direct record pull, never a bare scalar `COUNT(*)` — a bare scalar aggregate silently undercounted on this narrow a date window when checked 2026-09-23 (49 vs the correct 50; 55/26 vs 58/28).

**3. Pull.** Three `search_crm_objects` pulls with the full `pull_properties` list (now includes `sdr_owner`, `demo_booked__c`, `demo_completed__c`, `deal_source_group`), paginated to `total` → `deals_open.json`, `deals_won.json`, `deals_created.json`. One `query_crm_data` for `company.swan_score IS NOT NULL` → `swan_scores.json`. Write `snapshot.json`. Returned count ≠ reported `total` → stop.

**4. Build.** `python build.py`. Exit 0 = reconciled and written. Exit 2 = tie-out miss — the stderr lines name the measure; the usual cause is a record created or edited between steps 2 and 3 (re-run 2 and 3 together). Exit 3 = schema problem (unknown stage or owner, null amount) — the message says which. As part of this step, `build.py` also re-parses every `output/findigs_gtm_executive_dashboard_*.html` already on disk to derive the week-over-week comparison data (see "Historical comparison" below) — this never fails the build; a file it can't parse is just skipped with a stderr warning.

**5. QA.** `python qa.py`. Needs Playwright for the render checks; without it you get a syntax check only and a note saying so. If Playwright is installed but the browser fails to launch with an "executable doesn't exist" error, that's a browser-version mismatch, not "Playwright missing" — look for a pre-installed Chromium binary and re-run the render checks with `executable_path` set explicitly before falling back to syntax-only. This is how a real bug (a too-broad KPI click-handler selector) was caught 2026-09-24; it was invisible to the syntax-only check.

**6. Deliver — success only.** Upload `output/findigs_gtm_executive_dashboard_<as_of>.html` to Google Drive folder `1rFO4rDgvUZuf03NHeSdzDJT4MCEVy0Tb` (Revenue Operations / Reporting & Analytics). Post to `#gtm_leadership` (`C0C1P09SPFF`) with the file link and the four headline numbers from `tieout.md`, and send Will a short success DM. Commit `data/`, `runs/`, `output/tieout.md`, **and the built HTML** to the repo — committing the HTML is mandatory as of 2026-09-24, not optional: the week-over-week comparison feature reads historical `output/*.html` files from disk, so an uncommitted file is invisible to next week's build in a fresh clone.

## Historical comparison

Every KPI tile's `%`-change badge and the "Compare vs" dropdown are driven by a `HISTORY` array `build.py` embeds in each build. It works by globbing `output/findigs_gtm_executive_dashboard_*.html`, re-parsing each file's own embedded `DEALS`/`PG`/`META` JSON, and recomputing the same unfiltered KPI snapshot using *that file's own* QTD/YTD windows (see `snap_tier1`/`snap_pg`/`snap_sdr`/`load_history` in `build.py`). There's no separate log file to keep in sync — the dashboard files are the source of truth — but that also means a dashboard file that's never committed simply doesn't exist for comparison purposes next week. A historical file built before the SDR section existed (before 2026-09-23) correctly yields no SDR badges rather than a fabricated number.

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
| 2026-09-23 | SDR pipeline generation section added: opportunity = `sdr_owner IS NOT NULL` timestamped by `createdate`; meeting held = `demo_completed__c = 'Yes'`; channel = `deal_source_group` (referral folded into Inbound); rolling window = trailing 30 calendar days | config.sdr_section |
| 2026-09-24 | Week-over-week KPI comparison added to every tile; committing built HTML to `output/` is now mandatory (not "only if requested") since the comparison feature reads historical files from disk | this file, §Historical comparison |

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
