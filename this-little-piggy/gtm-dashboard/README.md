# GTM executive dashboard — build kit

Self-contained HTML dashboard for CRO / VP Sales / Marketing / CS leadership, sourced from HubSpot portal `243635806`. Three sections: **Tier 1–3** (closed-won bookings, open and weighted pipeline, forecasts, funnels, deal table), **Pipeline Generation** (New Logo deals created in the fiscal year: pacing, weekly creation, source, owner, create-month × close-month heatmap, Swan score), and **SDR pipeline generation** (added 2026-09-23/28: meeting booked→held and held→opportunity conversion, opportunities generated per SDR, pipeline vs. goal by segment, channel mix, stage progression by channel — same New Logo FY population as Pipeline Generation, not a separate pull).

Everything about *how* a number is calculated lives in Notion → **Data Definitions** (Reporting & Analytics section of the Revenue Operations wiki). `config.json` here mirrors those definitions and must match; the refresh skill checks that first and stops on drift.

## Layout

```
gtm-dashboard/
├── README.md          this file
├── config.json        confirmed decisions (mirror of Notion Data Definitions)
├── schema.md          exact shape of every file in data/
├── build.py           data/*.json → output/*.html + tieout.md + slack_post.txt; exits non-zero on tie-out failure
├── qa.py              headless render check of the built file
├── template.html      dashboard shell — brand tokens, inline SVG charts, filters, drilldowns, methodology blocks
├── data/              written by each refresh (ships with the 2026-09-14 snapshot as a working example)
├── runs/runs.jsonl    one line per build *attempt* — counts and totals for drift review (append-only, not deduped)
└── output/            built dashboard(s), tieout.md, slack_post.txt, qa_screenshot.png
    └── diagnostic/    scratch output from `build.py --diagnostic` — gitignored, never touches data/kpi_history.json or runs/runs.jsonl
```

`build.py --diagnostic` (added 2026-09-29) is for "why does this say X" / "how does this compare to last week" questions: it writes the HTML, `tieout.md`, and `slack_post.txt` under `output/diagnostic/` and skips both history writes entirely, so answering a question never pollutes the Compare vs baseline or the audit log. `data/kpi_history.json` already dedupes by `as_of` on every write (a same-day re-run replaces that date's entry, never adds a second one); `runs/runs.jsonl` intentionally is not deduped — it's an audit log of every attempt, including re-runs. `build.py` also caps embedded Compare vs history to `config.compare_vs.history_window_weeks` (26 by default) — measured 2026-09-29: this has negligible effect on file size (~700 bytes/history entry vs. the ~450KB embedded pipeline-generation deal array, which is the real driver of the file's size — see Known limitations).

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

**4. Build.** `python build.py`. Exit 0 = reconciled and written (also writes `output/slack_post.txt` — see step 6). Exit 2 = tie-out miss — the stderr lines name the measure; the usual cause is a record created or edited between steps 2 and 3 (re-run 2 and 3 together). Exit 3 = schema problem (unknown stage or owner, null amount) — the message says which.

**5. QA.** `python qa.py`. Needs Playwright for the render checks; without it you get a syntax check only and a note saying so. In an unattended (Routine) run, a missing Playwright install is itself a stop — see the skill's stop rules; on demand it can still fall back to syntax-only with a chat note.

**6. Deliver — in this order: upload, then commit, then post.**

1. Upload `output/findigs_gtm_executive_dashboard_<as_of>.html` to Google Drive folder `1uxooqagOt5pmyOKYjrH3ZLf9wjhNRuoX` (Shared Drive / Reports & Analytics / GTM Leadership Dashboard — moved here 2026-09-29 from the prior My Drive folder `1rFO4rDgvUZuf03NHeSdzDJT4MCEVy0Tb`). **Known limitation, confirmed 2026-09-28, re-measured 2026-09-29:** the file (664KB as of the SDR section — 68% of that is the embedded pipeline-generation deal array, 15% the template shell, 13% the Tier 1–3 deal array; Compare vs history is under 1%) is too large for the Drive connector's `create_file` tool, whose content has to pass through a single model-generated tool call. There is no chunked/resumable/path-based upload in the available Drive toolset. This is a standing, structural limitation, not a transient error — do not keep retrying it. The real fix is a service-account-based resumable upload outside any model tool call; spec'd but not yet built (see `publish_spec.md`).
2. **Commit `data/`, `runs/runs.jsonl`, `output/tieout.md`, `output/slack_post.txt` to the repo, regardless of whether the upload in step 1 succeeded** — a reconciled build is worth persisting even if delivery failed. Commit it too if the repo owner has asked for HTML file history. **A failed commit is always a stop** — DM Will, do not proceed to post.
3. If the upload in step 1 succeeded: post `output/slack_post.txt` **verbatim** to `#gtm_leadership` (`C0C1P09SPFF`), with its `<DRIVE_LINK>` placeholder replaced by the real Drive link — every number in it already matches `tieout.md` exactly, so nothing here is typed by the model. Then send Will a short success DM.
4. If the upload in step 1 failed (the size limitation above, or any other Drive error): **do not post to `#gtm_leadership`.** Instead DM Will the "built but not published" note: the file's path on this repo/branch, and the full contents of `output/slack_post.txt` (with `<DRIVE_LINK>` replaced by that repo path, not a Drive link) ready for him to paste once he's uploaded it himself.

**If any step 0–5 stops the run, or the commit in step 6.2 fails, none of the delivery above happens.** Instead, DM Will (`U0BQ5AZK284`) the failure note — see the skill's "Failure note format" section. `#gtm_leadership` never receives a failure, an error, a partial run, or a built-but-undelivered dashboard; it only ever sees one that's actually reachable. If Slack itself is unreachable, fall back to the Routine log / chat response, since there's no DM to send.

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
| 2026-09-29 | Delivery folder moved to a Shared Drive: `GTM Leadership Dashboard` (under `Reports & Analytics`), replacing the prior My Drive folder | config.distribution.gdrive_folder_id / gdrive_folder_path |
| 2026-09-29 | Slack post generated by `build.py` into `output/slack_post.txt` from the same numbers as `tieout.md`; the skill posts that file verbatim instead of composing the post itself | build.py, config.distribution |
| 2026-09-29 | Material-change threshold for the Slack post's DQ/change line: ±10% on any headline scalar vs. the comparison snapshot; process/display parameter, not a metric definition | config.compare_vs.material_change_threshold_pct |
| 2026-09-29 | Compare vs embedded history capped at a trailing window (default 26 weeks); measured to have negligible effect on file size — see Known limitations | config.compare_vs.history_window_weeks |
| 2026-09-29 | `build.py --diagnostic`: diagnostic/on-demand runs write scratch output under `output/diagnostic/` and never touch `data/kpi_history.json` or `runs/runs.jsonl` | build.py |
| 2026-09-29 | Delivery reordered to upload → commit → post, so a reconciled build's history is committed even if the Drive upload fails; commit failure is always a stop | README Step 6 |

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
- The built HTML has outgrown the Drive connector's upload tool (see Step 6) — plan for a manual upload step until `publish_spec.md`'s resumable-upload approach is built and approved.
- The file's size is driven almost entirely by the embedded pipeline-generation deal array (68% of 664KB, measured 2026-09-29), not by Compare vs history (under 1%) or the template shell (15%). Capping history further won't meaningfully help; shrinking the file for real would mean cutting or externalizing deal-level drilldown data, which hasn't been proposed or approved.
- SDR section: `sdr_owner_new` and `attribution_source_drill_down` exist in HubSpot and are actively used by several live, currently-configured HubSpot saved reports, but this dashboard deliberately does not use either (see `config.fields.not_used` and DQ flags SDR-1/SDR-2 in the built file). If Findigs' live SDR reporting is ever reconciled onto a single field, update the Notion Metric Definitions rows first, then `config.json`, then re-run — never the reverse.
- `qa.py` does not test Compare vs rendering (no check exists for the `#cmp-wrap` badge/no-badge behavior). The underlying JS (`template.html`'s `initCompare`/`renderCompare`) already does the right thing — badges against the most recent prior snapshot by date, hides the widget entirely when there's no prior snapshot — but nothing in `qa.py` verifies it. Flagged 2026-09-29, not yet built.
- **Which branch the Routine commits to is not configured anywhere** — not in `config.json`, not in this README, not in the skill. Every refresh commit to date has landed on `claude/loving-bardeen-nyzhg3` (PR #2, open, unmerged as of 2026-09-29); `main` does not have `data/kpi_history.json` at all. If a future run ever committed to `main` before that PR merges, it would start a brand-new, empty Compare vs history and orphan everything accumulated here. Needs an explicit decision (a `config.distribution` key naming the branch, or confirmation that "wherever the Routine's checkout is" is good enough) before the next scheduled run.
