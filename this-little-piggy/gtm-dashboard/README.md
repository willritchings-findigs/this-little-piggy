# GTM executive dashboard — build kit

Self-contained HTML dashboard for CRO / VP Sales / Marketing / CS leadership, sourced from HubSpot portal `243635806`. Three sections: **Tier 1–3** (closed-won bookings, open and weighted pipeline, forecasts, funnels, deal table), **Pipeline Generation** (New Logo deals created in the fiscal year: pacing, weekly creation, source, owner, create-month × close-month heatmap, Swan score), and **SDR pipeline generation** (meeting booked→held and held→opportunity conversion, opportunities generated per SDR, pipeline vs. goal by segment, channel mix, stage progression by channel — same New Logo FY population as Pipeline Generation, not a separate pull). Every KPI tile carries a **Compare vs** badge: percent change against a prior snapshot from `data/kpi_history.json`.

Everything about *how* a number is calculated lives in Notion → **Data Definitions** (Reporting & Analytics section of the Revenue Operations wiki). `config.json` here mirrors those definitions and must match; the refresh skill checks that first and stops on drift.

## Layout

```
gtm-dashboard/
├── README.md          this file
├── config.json        confirmed decisions (mirror of Notion Data Definitions)
├── schema.md          exact shape of every file in data/
├── build.py           data/*.json → output/*.html + tieout.md + slack_post.txt; exits non-zero on tie-out failure
├── qa.py              headless render check of the built file; exits 4 on any failure
├── template.html      dashboard shell — brand tokens, inline SVG charts, filters, drilldowns, Compare vs, methodology blocks
├── publish.py         streams the built HTML to the Drive folder as a service account; prints the Drive link
├── test_publish.py    offline tests for publish.py against a fake Drive API
├── publish_spec.md    design notes behind publish.py (scope, credential, Shared Drive membership)
├── requirements.txt   Python dependencies for qa.py and publish.py
├── data/              pulled data, rewritten by each refresh, plus kpi_history.json (Compare vs history, one entry per as_of)
├── runs/runs.jsonl    one line per successful non-diagnostic build — counts and totals for drift review (append-only; a same-day re-run adds a line)
└── output/            built dashboard(s), tieout.md, slack_post.txt, qa_screenshot.png
    └── diagnostic/    scratch output from `build.py --diagnostic` — gitignored, never touches data/kpi_history.json or runs/runs.jsonl
```

`build.py --diagnostic` is for "why does this say X" / "how does this compare to last week" questions: it writes the HTML, `tieout.md`, and `slack_post.txt` under `output/diagnostic/` and skips both history writes entirely, so answering a question never pollutes the Compare vs baseline or the audit log.

**Compare vs.** On every non-diagnostic build, `build.py` writes this `as_of`'s unfiltered headline totals into `data/kpi_history.json` (a same-day re-run replaces that date's entry, never adds a second), keeps only the trailing `config.compare_vs.history_window_weeks` weeks, and embeds the history in the HTML. Each badge shows `(current − prior) / |prior|` against the **most recent earlier entry by `as_of`** — whatever the gap, not "last Monday" — and the dropdown can pick any older entry. A prior of 0 reads "new" (blank if both are 0); a missing value on either side reads blank; with no earlier entry the Compare vs control is hidden. Badges compare unfiltered totals only; they don't follow the page filters. `output/slack_post.txt` calls out headline changes of at least `config.compare_vs.material_change_threshold_pct`% using the same formula. Definition: Metric Definitions row "Compare vs delta (period-over-period)".

## Refresh — the short version

The `gtm-dashboard-refresh` skill (`.claude/skills/gtm-dashboard-refresh/SKILL.md` at the repo root) does all of this. Run it in Claude Code with HubSpot, Notion, Google Drive and Slack connected, on the branch named in `config.distribution.git_branch`:

> Refresh the GTM dashboard.

It runs weekly as a Claude Code Routine (Mondays 08:00 ET). The manual procedure below is what the skill executes; use it to debug a failed run.

## Refresh procedure (manual)

**0. Preflight.** Check out `config.distribution.git_branch`. Read `config.json`. Run `config.notion.preflight_query` against the Notion Metric Definitions database; it returns every row whose *Used by* includes "GTM executive dashboard", "Pipeline Generation section", or "SDR section". Check that the rows and `config.notion.row_to_config_map` match one-to-one (every row has exactly one key, every key matches exactly one row — no row count is hardcoded anywhere), then compare each row against its mapped config keys. Any unmatched row or key, any difference, or any row not Confirmed → stop; fix one side, re-run. Set `as_of` = today's date in ET.

**1. Verify schema.** `get_properties` for every name in `config.pull_properties` (including the SDR fields `sdr_owner`, `demo_booked__c`, `demo_completed__c`, `deal_source_group`); `get_properties companies swan_score`. Re-derive the stage → probability map from live deals (query in `schema.md`). Any missing property, unseen stage ID, or new terminal stage → stop.

**2. Controls.** Eleven `query_crm_data` aggregates → `data/controls.json` (keys in `schema.md`). Run them before the record pulls, in the same session, so both see the same population:
1. **open**: `pipeline, COUNT(*), SUM(amount), SUM(hs_projected_amount), SUM(weighted_amount)` for open stages in both pipelines → `open_count`, `open_gross`, `open_hs_projected_amount`, `open_weighted_amount_stored` (summed across pipelines)
2. **won FY**: `pipeline, COUNT(*), SUM(amount), SUM(acv), SUM(units__c)` for won stages, `closedate` from FY start through as_of (inclusive, ET; Notion Bookings YTD, 2026-10-27) → `won_count`, `won_amount`, `won_acv`, `won_units`
3. **created FY by record source**: `hs_object_source_label, COUNT(*), SUM(amount)` for New Logo, `createdate` in FY → `created_by_record_source`, and its totals → `created_count`, `created_amount`
4. **created FY by source**: same population `GROUP BY deal_source_drill_down` → `created_by_drill_down`. The API reports blank values as "Unassigned", which is the bucket `build.py` puts them in.
5. **created FY by Swan score**: same population `GROUP BY company.swan_score` → `created_swan` (blank → key `"null"`)
6. **SDR opportunities**: `COUNT(*), SUM(amount)` for New Logo FY deals where `sdr_owner IS NOT NULL` → `sdr_opp_count`, `sdr_opp_amount`
7. **SDR by channel**: same population `GROUP BY deal_source_group` → `sdr_by_channel`. Keys are the raw stored values, capitalized (`Outbound`, `Inbound`, `Referral`, `Event`; blank → `"null"`). The aggregate's TSV display may show them lowercased; write the raw value.
8. **SDR meetings booked, trailing 30d**: `COUNT(*)` for New Logo FY deals with `demo_booked__c` in `[as_of − 29 days, as_of]` (ET, inclusive) → `sdr_meeting_booked_30d`. **Query the window as `demo_booked__c BETWEEN '<as_of − 30 days>' AND '<as_of>'`**: the reporting API treats `BETWEEN a AND b` on this date field as `(a, b]` and drops deals dated on `a`, so starting one day early returns the inclusive `[as_of − 29, as_of]` count (confirmed 2026-10-21: control 53 vs pull 55 with start = as_of − 29; 55 with start = as_of − 30). Items 9 and 10 use the same window. **2026-11-05: the API stopped dropping the start day** (control with start = as_of − 30 returned 60 vs pull 56; start = as_of − 29 returned 56, matching the pull). If these three controls miss by a few deals on a refresh, re-query once with start = as_of − 29 and compare against the pull before treating it as a real gap.
9. **SDR meetings held, trailing 30d**: same, plus `demo_completed__c = 'Yes'` → `sdr_meeting_held_30d`
10. **SDR held → opportunity, trailing 30d**: same as 9, plus `sdr_owner IS NOT NULL` → `sdr_opp_from_held_30d`
11. **SDR opportunities generated, trailing 30d**: `COUNT(*), SUM(amount)` for New Logo FY deals with `sdr_owner IS NOT NULL` and `createdate` in the same window → `sdr_opp_30d_count`, `sdr_opp_30d_amount` (window basis is `createdate`, not `demo_booked__c`)

**3. Pull.** Three `search_crm_objects` pulls with the full `pull_properties` list, paginated to `total` → `deals_open.json`, `deals_won.json`, `deals_created.json` (the SDR section reads its population out of `deals_created.json` — no separate pull). Write results verbatim; when a result is saved to a file because it's too large, build the data file from that saved file with a script, never by retyping. A small pull (usually won FY) can come back inline instead of as a file; re-run it with these extra properties so the result is saved to a file: `hs_lastmodifieddate, hs_all_owner_ids, hs_analytics_source, dealtype, description, hs_projected_amount, hs_forecast_amount, hs_acv`. `build.py` ignores properties it doesn't use. `swan_scores.json` is the one file that may be written from inline output (one `deal_id`/score pair per row); the tie-out gates it per score against `controls.created_swan`, so a transcription error exits 2. One `query_crm_data` for `company.swan_score IS NOT NULL` → `swan_scores.json`. Returned count ≠ reported `total` → stop. Then resolve owners: `search_owners` every `hubspot_owner_id` **and** every `sdr_owner` value (including HubSpot's "Unassigned" placeholder `8309346`) not yet in `snapshot.json`. SDR owner and deal owner are different people on most deals; don't assume overlap. An ID `search_owners` can't resolve is left out and shows as "Unresolved owner <id>" (DQ-12) — not a stop. Write `snapshot.json`.

**4. Build.** `python build.py`. Exit 0 = reconciled and written (also writes `output/slack_post.txt` — see step 6 — and updates `data/kpi_history.json` and `runs/runs.jsonl`). Exit 2 = tie-out miss, nothing written — the stderr lines name the measure; the usual cause is a record created or edited between steps 2 and 3 (re-run 2 and 3 together, once). A stderr starting `usage:` is a bad command line, which argparse also reports as exit 2. Exit 3 = schema problem (unknown stage, out-of-scope pipeline, null `amount` or `units__c`, template missing its data placeholder) — the message says which. A blank `deal_source_drill_down` ("Unassigned") or an unresolved owner ("Unresolved owner <id>") does not stop the build; both are counted in the DQ tables.

**5. QA.** Unattended: `python qa.py --require-render`. On demand: `python qa.py`. Render checks need Playwright (Chromium is pinned at `/opt/pw-browsers/chromium` when present). They cover: the headline tiles, the Pipeline Generation and SDR tiles against the build's counts, Compare vs (hidden with no prior snapshot; otherwise dropdown size and badge values against the most recent prior), filters, reset, native-only toggle, drilldown, a click on every KPI tile, and page errors. Exit 0 = pass, 4 = fail — including a browser that won't launch and, with `--require-render`, a missing Playwright. Without the flag, a missing Playwright passes on syntax only and says so.

**6. Deliver — commit, then post.** (Changed 2026-10-26: no Drive upload; `publish.py` is retained but not run.)

1. **Commit and push** `data/`, `runs/runs.jsonl`, `output/tieout.md`, `output/slack_post.txt`, `output/qa_screenshot.png` and the built HTML to `config.distribution.git_branch` (`main`), straight to the branch, no PR. **A failed commit or push is always a stop**: DM Will, do not post.
2. Post `output/slack_post.txt` **verbatim** to `#gtm_leadership` (`C0C1P09SPFF`), with `<DRIVE_LINK>` replaced by the link from `config.distribution.dashboard_link_pattern`. Then send Will a short success DM. Slack can't attach the file, so the post links the pushed HTML.

**If any step 0–5 stops the run, or the commit in step 6.2 fails, none of the delivery above happens.** Instead, DM Will (`U0BQ5AZK284`) the failure note — see the skill's "Message formats" section. `#gtm_leadership` never receives a failure, an error, a partial run, or a built-but-undelivered dashboard; it only ever sees one that's actually reachable. If Slack itself is unreachable, fall back to the Routine log / chat response, since there's no DM to send. In an on-demand run, every note that would be DM'd goes into the chat instead.

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
| 2026-10-26 | Success = built, QA'd and pushed to `main`; `#gtm_leadership` post links the pushed HTML; Drive upload dropped from the routine | SKILL.md step 6, config.distribution.dashboard_link_pattern |
| 2026-09-29 | Delivery reordered to upload → commit → post, so a reconciled build's history is committed even if the Drive upload fails; commit failure is always a stop | README Step 6 |
| 2026-10-05 | Single-record gaps don't stop the build: blank `deal_source_drill_down` → "Unassigned"; owner ID missing from `snapshot.json` → "Unresolved owner <id>" (DQ-12). Null `amount` / `units__c` still stop | build.py; Metric Definitions rows "Pipeline created by source" / "by owner" (Proposed) |
| 2026-10-05 | Preflight checks `row_to_config_map` is one-to-one with the returned Notion rows instead of any hardcoded row count | config.notion.note |
| 2026-10-05 | Refresh commits go to one named branch | config.distribution.git_branch |
| 2026-10-05 | Unattended QA runs with `--require-render`: a missing Playwright or a browser that won't launch is a failure (exit 4) | qa.py, skill step 5 |
| 2026-10-05 | One Compare vs delta formula everywhere: `(current − prior) / |prior|` | build.py, template.html; Metric Definitions row "Compare vs delta (period-over-period)" (Proposed) |

## Prerequisites

- Python 3.11+ (standard library only; `zoneinfo` needs the `tzdata` package on minimal images: `pip install tzdata`)
- Node (any recent) for the JS syntax check in `qa.py`
- `python3 -m pip install -r requirements.txt`: Playwright for the `qa.py` render checks, plus google-auth, requests and cryptography for `publish.py`. Cloud containers already ship Chromium at `/opt/pw-browsers/chromium`; never run `playwright install` there. Use `python3 -m pip`, not bare `pip`: on some images they're different interpreters. If `from google.oauth2 import service_account` crashes with a `PanicException`, the image's system cryptography is broken; `python3 -m pip install --ignore-installed cryptography` fixes it.
- `GTM_DASHBOARD_SA_KEY`: no longer needed (2026-10-26, Drive upload dropped from the skill). Only relevant if `publish.py` is run by hand.
- Claude Code connectors for the skill: HubSpot, Notion, Google Drive, Slack. The Slack identity attached to the Routine must be a member of `#gtm_leadership` (private).

## Routine setup

Repository `willritchings-findigs/this-little-piggy`. Connectors: HubSpot, Notion, Google Drive, Slack. Schedule: weekly, Monday 08:00 America/New_York. Prompt:

```
Run the gtm-dashboard-refresh skill now, exactly as written in its SKILL.md. First run `git fetch origin main && git checkout main && git pull origin main` and do all work and commits on `main`. This is an unattended run: if the Notion Data Definitions diff shows drift, a HubSpot property is missing, a pull count does not match its total, build.py exits non-zero, or qa.py fails, stop at that step. On any stop, DM me (Slack user U0BQ5AZK284) the failure note — do not post anything to #gtm_leadership in that case. #gtm_leadership should only ever receive a post when the refresh fully succeeds. Never edit anything in HubSpot or Notion.
```

Before the channel post reaches anyone but you, confirm the Slack identity the Routine runs under is actually a member of `#gtm_leadership` (private channel) — a DM to `U0BQ5AZK284` works regardless, but the success post will silently fail otherwise.

The Routine must run on the `main` branch. Routine sessions start on a throwaway `claude/*` branch, so the prompt above checks out `main` first, and the Routine's repository setting must allow pushes to branches other than `claude/*` (unrestricted branch push), or the step 6.2 push fails. The skill stops before step 0 if `main` can't be checked out, and `data/kpi_history.json` only accumulates on `main`. The Routine's environment setup script should run `python3 -m pip install -r this-little-piggy/gtm-dashboard/requirements.txt` (see Prerequisites). Check with `python publish.py --check`.

Test with **Run now** before trusting the schedule.

## Known limitations

- Snapshot, not live. Header shows the pull time.
- Stage probabilities are observed from deal records, not read from pipeline settings (the connector does not expose them).
- The dashboard's brand font and logo load from the Findigs CDN and fall back to system font / text wordmark offline. Data and charts never need the network.
- `weighted_amount` is populated on roughly half of open deals; the fallback rule covers the rest and each fallback deal is tagged.
- The built HTML has outgrown the Drive connector's upload tool, so `publish.py` uploads it instead (see Step 6). Until `GTM_DASHBOARD_SA_KEY` is provisioned, every run ends as built-but-not-published and needs a manual upload. (Not used by the routine since 2026-10-26: the refresh commits the HTML to the repo and the post links it.)
- The file's size is driven almost entirely by the embedded pipeline-generation deal array, not by Compare vs history (under 1%) or the template shell. Capping history further won't meaningfully help; shrinking the file for real would mean cutting or externalizing deal-level drilldown data, which hasn't been proposed or approved.
- SDR section: `sdr_owner_new` and `attribution_source_drill_down` exist in HubSpot and are actively used by several live, currently-configured HubSpot saved reports, but this dashboard deliberately does not use either (see `config.fields.not_used` and DQ flags SDR-1/SDR-2 in the built file). If Findigs' live SDR reporting is ever reconciled onto a single field, update the Notion Metric Definitions rows first, then `config.json`, then re-run — never the reverse.
- `data/kpi_history.json` only accumulates if every refresh builds and commits on `config.distribution.git_branch`. A run on any other checkout starts from whatever history that branch has.

## Changelog

Dated history that used to sit inside the procedure. Decisions are in the Decisions log above; definitions are in Notion.

- **2026-09-14** — First build: Tier 1–3 and Pipeline Generation, six control queries.
- **2026-09-22** — Kit committed to `willritchings-findigs/this-little-piggy`; Drive + `#gtm_leadership` delivery; failures DM'd to Will.
- **2026-09-23** — SDR section definitions confirmed in Notion (8 Metric Definitions rows, `Category = SDR`).
- **2026-09-28** — SDR section and Compare vs built; five SDR control queries added; Drive upload found to fail on file size; `qa.py` f-string fix for Python < 3.12. `deal_source_group` raw values verified capitalized; `demo_completed_date__c` re-verified dead; FY2027 quota workbook checked and not applied.
- **2026-09-29** — Delivery folder moved to the Shared Drive; `slack_post.txt` generated by `build.py`; `--diagnostic`; `kpi_history.json` dedupe and 26-week cap (measured: about 700 bytes per entry against a 664KB file, 68% of it the pipeline-generation deal array); delivery reordered to upload → commit → post; `publish_spec.md` written.
- **2026-10-05** — Single-record gaps no longer stop the build; owner filter now built from both populations (a PG-only owner was silently dropped from PG and SDR totals); `qa.py --require-render`, SDR and Compare vs checks, launch failures exit 4; one Compare vs delta formula; one-to-one preflight mapping; `config.distribution.git_branch`; repo copy of the skill at `.claude/skills/gtm-dashboard-refresh/SKILL.md`.
- **2026-10-12** — `publish.py` built from `publish_spec.md` (resumable upload, never overwrites, exit 5 not configured / 6 failed) with offline tests in `test_publish.py`; `requirements.txt`. Ported the Tier 1 KPI click-handler fix (`.kpi[data-k]`) from the unmerged 2026-09-24 branch, and `qa.py` now clicks every KPI tile and fails on page errors. Refreshes commit straight to `main`.
