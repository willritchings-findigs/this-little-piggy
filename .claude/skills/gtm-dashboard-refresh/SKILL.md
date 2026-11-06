---
name: "gtm-dashboard-refresh"
description: "Refresh the Findigs GTM executive dashboard from live HubSpot data and publish it — re-pull open, closed-won, and created-this-year deals (also backing the SDR pipeline generation section added 2026-09-23/28, no separate pull), rebuild the self-contained HTML with gtm-dashboard/build.py — including Compare vs period-over-period KPI badges vs a prior snapshot — tie out against reporting-API controls, QA the render, commit it to the repo, and post it to #gtm_leadership. Success means the dashboard was rebuilt, QA'd and pushed to the repo; no Drive upload is required. On any stop or failure, DM Will in Slack instead — #gtm_leadership only ever sees successful refreshes. Use this whenever anyone asks to refresh, rebuild, re-run, update, or re-publish the GTM/exec/pipeline/bookings/forecast/SDR dashboard, or the Monday dashboard, and on every scheduled Routine run. Also use it when someone asks why a number looks off, or how it compares to a prior week — the tie-out, DQ output, and Compare vs badges answer that. Never edits HubSpot or Notion."
---

# GTM dashboard refresh

Rebuilds `output/findigs_gtm_executive_dashboard_<as_of>.html` from a fresh HubSpot pull and publishes it. The dashboard has three sections: Tier 1–3 (bookings, pipeline, forecast), Pipeline Generation, and SDR pipeline generation. Every KPI tile carries a Compare vs badge against a prior snapshot. The CRO and revenue leadership read it, so the posture is: **read-only against HubSpot and Notion, stop on anything that doesn't reconcile, never estimate a number**. A refresh that publishes a wrong figure is worse than one that stops and says why.

What each metric means (fields, weighting, segment bands, fiscal calendar, SDR rules, the Compare vs delta) lives in Notion → Revenue Operations → Reporting & Analytics → **Data Definitions** and its **Metric Definitions** database. `config.json` mirrors them for the build. This skill owns *process* only. To change a definition, change it in Notion and `config.json`, not here.

**Delivery is split by outcome.** Only a refresh whose build, QA and push to the repo all succeeded is posted to `#gtm_leadership` (`config.distribution.slack_channel_id`). Every stop, error, QA or tie-out failure, and failed push goes to Will as a Slack DM (`config.distribution.slack_dm_user_id`) in unattended runs, or to the chat in on-demand runs. `#gtm_leadership` never sees a failure, a stack trace, or a link to a file that wasn't pushed. Drive upload is no longer part of this skill; Will uploads to Drive himself if wanted. `publish.py` stays in the kit but is not run.

The kit lives in `this-little-piggy/gtm-dashboard/` in `willritchings-findigs/this-little-piggy`. Work there. Read `README.md` once per run: its Step 2 is the authoritative list of control queries. Read `schema.md` when writing data files. Dates are America/New_York throughout; `as_of` is today's ET date unless someone gives one.

## Run modes

- **Unattended** (Claude Code Routine, Mondays 08:00 ET): follow every stop rule literally. On a stop, DM Will the failure note and end. Run QA with `--require-render`.
- **On demand** (someone asks in chat): same steps. On a stop, explain in the chat and ask instead of DMing; the person is right here. QA may run without `--require-render`; if it falls back to syntax only, say so.
- **Diagnostic** ("why does X look off", "how does this compare to last week"): never delivers, never commits, never writes history.
  - To explain the **last published** numbers, run `python build.py --diagnostic` on the committed `data/` without re-pulling.
  - To explain **live HubSpot**, run steps 0–3 first, then `python build.py --diagnostic`.
  - Answer from `output/diagnostic/tieout.md`, the DQ tables in it, `data/kpi_history.json`, and the Compare vs badges in `output/diagnostic/<file>.html`. `--diagnostic` writes only under `output/diagnostic/` (gitignored) and never touches `data/kpi_history.json` or `runs/runs.jsonl`. Discard any re-pulled `data/` changes afterwards (`git checkout -- data/`).

## Procedure

### Before step 0: right branch, right kit

Unattended runs may start on a throwaway `claude/*` branch; the Routine prompt checks out `config.distribution.git_branch` (`git fetch origin <branch> && git checkout <branch> && git pull origin <branch>`) before invoking this skill. Do that checkout yourself if it hasn't happened and it succeeds. If the checkout is on any other branch after that (checkout failed, or the branch can't be pushed to), or its `config.json` has no `sdr_section` or `compare_vs` block (an older kit), stop. `data/kpi_history.json` only accumulates if every refresh builds and commits on that one branch.

**Connectors.** HubSpot, Notion and Slack finish connecting a few seconds into a Routine run (they show as "still connecting" at first), so an early tool search can come back empty while the tools exist. The 2026-11-02 run stopped at step 1 this way and no dashboard was published.

- Find connector tools by server name, never by keyword: ToolSearch `+HubSpot`, `+Notion`, `+Slack`, or exact `select:mcp__<Server>__<tool>` names. Keyword searches ("hubspot", "slack") have returned nothing while the tools existed.
- If a connector's tools are missing, wait ~20 seconds and search again, up to 3 tries (about a minute), before treating it as unreachable and stopping.
- If Slack itself is the missing connector, send the failure note as a push notification instead of a Slack DM.

### 0. Preflight: definitions agree

1. Read `config.json`.
2. Run `config.notion.preflight_query` with the Notion `query_data_sources` tool against `config.notion.metric_definitions_data_source`. It returns every row tagged GTM executive dashboard, Pipeline Generation section, or SDR section.
3. **Mapping is one-to-one.** Every returned row must have exactly one key in `config.notion.row_to_config_map`, and every key must match exactly one returned row. An unmatched row or an unmatched key is a stop. Don't check a row count; the mapping is the count.
4. For each row, compare Formula, Object & fields, Scope / filters, Exclusions and Null handling against its mapped config keys. The comparison is semantic, not string-equal, but a different field name, threshold, stage ID, window or handling rule is a mismatch.
5. Any mismatch, or any row with Status = Proposed or Deprecated → **stop** and report the exact rows. Don't pick a side: Will decides which is right and updates the other.
6. Notion unreachable: on demand, ask whether to proceed on `config.json` alone. Unattended, stop.

### 1. Verify the HubSpot schema

1. `get_properties` (deals) for every name in `config.pull_properties`, and `get_properties` (companies) for `swan_score`. Missing → stop, naming the property.
2. Re-derive the stage map: `SELECT dealstage, hs_deal_stage_probability, COUNT(*) FROM DEAL WHERE pipeline IN ('<new_logo>','<upsell>') GROUP BY dealstage, hs_deal_stage_probability`. The reporting API keeps at most two GROUP BY dimensions; stage IDs are unique across pipelines, so `pipeline` isn't needed. A stage ID not in the current `snapshot.json`, or a won/lost stage not in `config.terminal_stages` → stop; a new terminal stage silently changes bookings. A changed probability is not a stop: record it in `snapshot.notes` and continue.

### 2. Controls first

Run **every** control query in `README.md → Step 2`, before the record pulls and in the same session, and write `data/controls.json` in the shape in `schema.md`. HubSpot is live: doing controls first and records straight after keeps the window to seconds. If the tie-out later misses by exactly one deal's amount, re-run steps 2 and 3 together once. If it misses twice, stop.

### 3. Pull records

1. `search_crm_objects` × 3 with the full `config.pull_properties` list, `limit: 200`, paginated by `offset` until `total`:
   - open: `pipeline IN (new_logo, upsell)` AND `dealstage NOT IN (four terminal IDs)` → `data/deals_open.json`
   - won FY: `dealstage IN (won IDs)` AND `closedate GTE <FY start>` → `data/deals_won.json`
   - created FY: `pipeline EQ new_logo` AND `createdate GTE <FY start>` → `data/deals_created.json`. The SDR section reads its population from this file; there is no separate SDR pull.
2. Write each result array to disk **verbatim**. Don't reshape, retype, or reformat dates; `build.py` does typing and ET conversion. When a tool result is too large and is saved to a file, build the data file from that saved file with a script. Never retype records. Each array's length must equal the reported `total`; otherwise stop, naming the pull, the total, and the count.
3. `query_crm_data`: `SELECT hs_object_id, company.swan_score FROM DEAL WHERE pipeline = '<new_logo>' AND createdate BETWEEN '<FY start>' AND '<FY end>' AND company.swan_score IS NOT NULL LIMIT 500` → `data/swan_scores.json` as `[{deal_id, swan_score}]`.
4. **Owners.** Collect every distinct `hubspot_owner_id` and every distinct `sdr_owner` across the three files, including HubSpot's "Unassigned" placeholder `8309346`. The deal owner and the SDR owner are different people on most deals; resolve both. `search_owners` any ID not already in `snapshot.json` and add `{name, active}`. If `search_owners` can't resolve an ID, leave it out and continue; the build shows it as "Unresolved owner <id>" and flags it as DQ-12. Never describe an owner as former or unknown without trying to resolve the ID first.
5. Write `data/snapshot.json` (shape in `schema.md`): `as_of`, `pulled_at_et`, stages with probabilities, owners, notes.

**Single-record gaps are not stops.** A blank `deal_source_drill_down` is bucketed as "Unassigned" and an unresolved owner is shown by ID. Both are counted in the dashboard's DQ tables, and both are reported in the run summary. A null `amount` or `units__c` still stops the build: those are required by their Metric Definitions rows.

### 4. Build

`python build.py`

- **Exit 0**: `output/findigs_gtm_executive_dashboard_<as_of>.html`, `output/tieout.md` and `output/slack_post.txt` are written. A line is appended to `runs/runs.jsonl`, and `data/kpi_history.json` gets this `as_of`'s entry (a same-day re-run replaces it). Continue.
- **Exit 2**: tie-out miss, and nothing was written. stderr names each measure and delta. Apply the one controlled re-run from step 2; otherwise stop with the measure and delta verbatim. Never edit `controls.json` to make it pass. (A stderr starting `usage:` is a bad command line, not a tie-out.)
- **Exit 3**: schema problem: unknown stage, out-of-scope pipeline, null `amount` or `units__c`, or a broken template. The message names the record. Fix the pull, never the record. A second exit 3 is a stop.

### 5. QA

Unattended: `python qa.py --require-render`. On demand: `python qa.py`.

It checks:
- JS syntax.
- The headline tiles against the embedded sums.
- The Pipeline Generation YTD count.
- The SDR tiles against the build's SDR counts.
- Compare vs: hidden when there's no prior snapshot; otherwise the dropdown size and the badge values against the most recent prior snapshot.
- The owner filter, reset, native-only toggle and gross drilldown.
- No page errors.

**Exit 4 → stop**, quoting the failed checks. That includes a browser that won't launch, and, with `--require-render`, a missing Playwright. On demand, a syntax-only pass must be mentioned in the chat summary.

### 6. Deliver: commit, then post

Only reached when steps 0–5 all passed.

1. **Commit and push** `data/`, `runs/runs.jsonl`, `output/tieout.md`, `output/slack_post.txt`, `output/qa_screenshot.png` and the built HTML to `config.distribution.git_branch`, with message `dashboard refresh <as_of>`. Commit straight to the branch and push; no PR. **A failed commit or push is a stop**: send the failure note and don't post.
2. **Post** `output/slack_post.txt` to `#gtm_leadership` verbatim, replacing `<DRIVE_LINK>` with the link built from `config.distribution.dashboard_link_pattern` (`{as_of}` filled in; the file is now on the branch). Every number in it comes from the build and matches `tieout.md`; don't type or edit numbers. The Slack connector can't attach files, so the post carries the link to the pushed HTML.
3. DM Will the success note.

### 7. Run summary (chat or Routine log)

Always, whatever the outcome:
- Record counts per pull against their reported totals.
- The tie-out result (n/n reconciled).
- DQ flags by severity, naming any single-record gaps (blank source, unresolved owner).
- What changed versus the previous `runs/runs.jsonl` line: gross, weighted, weighted-fallback count, past-due count, Swan coverage, SDR opportunities.

A jump in fallback count means `weighted_amount` stopped being populated; a jump in past-due means close dates aren't maintained. Only the short notes below go to Slack.

## Stop rules, collected

Stop, and send the failure note (DM unattended, chat on demand; never `#gtm_leadership`) when:

- the checkout isn't `config.distribution.git_branch`, or is an older kit (before step 0)
- Notion definitions and `config.json` disagree, the row mapping isn't one-to-one, or a used row is Proposed or Deprecated (step 0)
- a configured property no longer exists, or a new stage ID or terminal stage appears (step 1)
- a pull's returned count ≠ its reported `total` (step 3)
- `build.py` exits non-zero after at most one controlled re-run of steps 2–3 (step 4)
- `qa.py` exits non-zero (step 5)
- the commit or push fails (step 6.2)
- the HubSpot or Notion connector is unreachable at the step that needs it, after the retries under **Connectors** (before step 0). On demand, an unreachable Notion can instead be put to the user (step 0.6). 
- **the Slack connector is unreachable** (after the same retries). There's no DM to send, so send the failure note as a push notification instead (and write it into the Routine log or chat), and never retry into the channel.

Not stops: a blank `deal_source_drill_down`, an owner ID `search_owners` can't resolve, a changed stage probability.

Never:

- edit any HubSpot or Notion record
- edit `controls.json` or any file in `data/` by hand to make the gate pass
- estimate, impute, or backfill a value HubSpot returned blank. The only permitted handling is the build's own rules (weighted fallback, Swan "No score", "Unassigned" source, "Unresolved owner"), all documented in Notion.
- change `config.json` during a run; that's a decision, not a refresh
- type numbers into a Slack post; post `slack_post.txt`

## Message formats

**`#gtm_leadership` post (only when the push succeeded):** `output/slack_post.txt`, verbatim, with `<DRIVE_LINK>` replaced by the repo link to the pushed HTML. `build.py` generates it, in this shape:

```
GTM executive dashboard — refreshed <Mon D, YYYY>
Bookings QTD $X (n deals) · YTD $Y (n)
Gross open pipeline $A · weighted $B · quarter forecast $C · year forecast $D
Pipeline created QTD $E (n) · YTD $F (n)
SDR opportunities $G (n) · trailing 30d: booked n, held n, opportunities n
<DRIVE_LINK>
Sources and methodology are in the file. <High-severity DQ count, or headline changes of ±config.compare_vs.material_change_threshold_pct% vs the prior snapshot, or "No new data-quality flags.">
```

**Success DM to Will:**

```
Dashboard refresh succeeded, posted to #gtm_leadership. <repo link>
```

**Failure note** (DM to Will unattended, chat on demand):

```
GTM dashboard refresh did not publish — <as_of>
Stopped at step <n> (<name>): <one sentence>.
<the measure / property / row / check that failed, verbatim from the tool or build output>
Last successful build: <as_of from the last runs/runs.jsonl line>. Prior file remains current in the repo.
```

`#gtm_leadership` isn't told a run happened when it doesn't publish. From the channel's side, no news means nothing changed since the last post.
