# Sales Forecast Tool: Phase 0 Discovery & Architecture Proposal

**Status:** Approved 2026-09-25 with the decisions below. Phase 1 (data layer) is in review.

## Decisions (2026-09-25)
| # | Decision | Where it lives |
|---|---|---|
| Q1 | Submission after Friday 12:00 ET counts toward the next Friday's week | `config/forecast.json` cutoff.late_rule |
| Q2 | Phil Aroian: edits own row, sees all rows (`ae_leader`) | `config/roster.json` |
| Q3 | Team Total = roster AEs; read-only non-roster row so columns tie to company totals | `ForecastCore.computeMetrics` |
| Q4 | Headline pipeline = all open stages and dates; in-period sub-line; Best Case warning uses in-period | `config/forecast.json` section1 |
| Q5 | Proceed with Clay's deals in the non-roster row | `config/roster.json` non_roster_owners |
| Q6 | Leadership: Brian Korchin, Alex Schaper, Asaf Raz, plus Phil Aroian | `config/roster.json` |
| Q7 | 2026 folder is in a Shared Drive; Will Ritchings' account owns the script | Deployment |
| Q8 | No holiday cutoff adjustments; missed weeks show as gaps | `config/forecast.json` holiday_overrides = {} |
| Q9 | Commit = "High Confidence" (was 99%) | `config/forecast.json` definitions.commit |
| — | Year rollover as proposed; Will creates the 2027 folder | `config/forecast.json` drive.folders_by_fiscal_year |
| P1-2 | Will Ritchings = admin and core owner | `config/roster.json` admins |
| P1-3 | **Weighted pipeline = amount × pipeline stage probability for every open deal.** HubSpot `weighted_amount` is reference only (only 4 of 49 populated values matched stage weighting). Company weighted is $11,304,048.49 vs $9,512,983.17 under the old stored-first rule. This deliberately deviates from gtm-dashboard, whose config is unchanged | `config/forecast.json` weighting |
| P1-4 | Owners API v3: `archived` = inactive; missing `userId` = no user seat. To be confirmed on the first live run | `ForecastCore.normalizeOwners` |

---
**Data as of:** 2026-09-25, live HubSpot pulls via MCP (portal 243635806)
**Author:** RevOps (Claude Code session)

---

## 1. What gets reused from `gtm-dashboard/`

`gtm-dashboard/config.json` is the mirror of Notion → Data Definitions. The forecast tool reads the same keys and does not copy them by hand. A build script generates the Apps Script config from that file, and a test fails if the two drift apart.

| Definition | gtm-dashboard source | Value | Forecast tool use |
|---|---|---|---|
| In-scope pipelines | `pipelines.new_logo`, `pipelines.upsell_expansion` | `2313721535`, `2313830082` | Same |
| Renewal exclusion | `pipelines.renewal.in_scope=false` | `2559714036` | Same, excluded everywhere |
| Won stage IDs | `terminal_stages.won` | `3753890502`, `3752297196` | Closed Won YTD population |
| Lost stage IDs | `terminal_stages.lost` | `3753890503`, `3752297197` | Excluded from open pipeline |
| Win/loss rule | `terminal_stages.rule` | Stage-ID membership only. `hs_is_closed_won/lost` is never used | Same |
| Bookings / pipeline $ | `fields.bookings_amount` | `amount` | Same. `hs_acv`, `acv`, and `hs_forecast_amount` are never read |
| Weighting | `weighting_rule` | `weighted_amount`, else `amount × hs_deal_stage_probability` | Same. Fallback count is shown per AE and for the team |
| Owner / units / close | `fields.*` | `hubspot_owner_id`, `units__c`, `closedate` | Same |
| Timezone bucketing | `build.py:et_date()` | UTC → America/New_York before any date comparison | Ported to JS as a pure function with identical tests |
| Tie-out tolerance | `tie_out_tolerance_usd` | 0.01 | Same |
| Populations | `populations.open`, `populations.won_fy` | open = in-scope pipeline and non-terminal stage; won = won stage and `closedate` ≥ FY start | Won is additionally capped at `closedate` ≤ submission date (ET) |

**Two things from gtm-dashboard will be handled differently:**
- `build.py` exits when a deal has a null `amount` or `units__c` (`derive_deal`, exit 3). The forecast tool must **show a blank and flag the deal** instead, because the requirements say never to impute and never to exclude.
- gtm-dashboard reads stage probabilities from deal records, because the MCP connector does not expose the pipelines API. The deployed app calls `GET /crm/v3/pipelines/deals` directly with the private-app token. It then **asserts** that the won and lost stage IDs it derives (`metadata.isClosed` + `metadata.probability`) match `terminal_stages`. On a mismatch it stops, which is the same trip-wire gtm-dashboard uses.

**Tie-out check:** Closed Won YTD today is **$7,571,305.12 across 73 deals**. That equals gtm-dashboard's 9/14 figure of $3,896,085.32 plus the two deals that closed won after 9/14: Highmark Residential ($3,660,589.80) and Tyraa Nicole ($14,630.00). The difference is $0.00.

---

## 2. Live discovery results (2026-09-25)

### Stages and probabilities

| Pipeline | Stage ID | Label | Deal-record probability | Deals (all time) |
|---|---|---|---|---|
| New Logo | 3753890497 | Intro & Challenge | 0.10 | 62 open |
| New Logo | 3753890498 | Discovery / Demo | 0.20 (**1 deal at 0.15**) | 18 open |
| New Logo | 3753890499 | Business Case & Stakeholder Alignment | 0.40 | 8 open |
| New Logo | 3753890500 | Negotiation & Execution | 0.60 | 4 open |
| New Logo | 3753890501 | Trial | 0.80 | 6 open |
| New Logo | 3753890502 | Closed Won | 1.00 | 774 |
| New Logo | 3753890503 | Closed Lost | 0.00 | 2,152 |
| Upsell/Exp | 3752297191 | Intro & Challenge | 0.20 | 2 open |
| Upsell/Exp | 3752297192 | Discovery / Demo | 0.40 | 2 open |
| Upsell/Exp | 3752297193 | Business case & Stakeholder alignment | 0.60 | 2 open |
| Upsell/Exp | 3752297194 | Negotiation & Execution | 0.80 | 2 open |
| Upsell/Exp | 3752297195 | Implementation / Contract signed | 0.90 | 1 open |
| Upsell/Exp | 3752297196 | Closed Won | 1.00 | 44 |
| Upsell/Exp | 3752297197 | Closed Lost | 0.00 | 33 |

The in-scope pipelines hold 3,110 deals, all in USD.

### Owners with in-scope open or closed-won-YTD deals

| Owner | Owner ID | isActive | Open deals | Gross open | Stored weighted | Weighted null | Closed Won YTD (n) |
|---|---|---|---|---|---|---|---|
| Phil Aroian | 1053057926 | ✅ | 32 | $41,741,263.58 | $2,862,500.76 | 11 | $5,240,539.03 (14) |
| Matt Lynch | 1032502194 | ✅ | 21 | $10,820,904.35 | $511,956.75 | 14 | $420,389.86 (6) |
| Ben de Winter | 2111244871 | ✅ | 12 | $6,325,852.00 | $113,080.00 | 8 | $484,825.04 (5) |
| Spencer Wuthrich | 167857460 | ✅ | 3 | $4,879,200.00 | $0.00 | 3 | $0.00 (0) |
| Ian McLaughlin | 26451111 | ✅ | 32 | $3,142,411.20 | $432,878.76 | 17 | $355,506.94 (14) |
| **Roster subtotal** | | | **100** | **$66,909,631.13** | **$3,920,416.27** | **53** | **$6,501,260.87 (39)** |
| Clay Stapleford ⚠️ | 686754956 | ✅ (no user seat) | 5 | $2,508,550.00 | $223,839.00 | 4 | $654,238.85 (14) |
| Reese Ryan (excluded) | 663611618 | ✅ | 2 | $197,865.00 | $57,291.00 | 1 | $302,132.80 (16) |
| Hayden Ashwill | 1542312872 | ❌ | 0 | $0.00 | $0.00 | 0 | $113,672.60 (4) |
| **Company total** | | | **107** | **$69,616,046.13** | **$4,201,546.27** | **58** | **$7,571,305.12 (73)** |

"Stored weighted" is the sum of `weighted_amount` where it is populated. The fallback amount (`amount × probability`) is computed from record-level data in Phase 1.

### Field population on the 107 open deals

| Field | Null | Populated | Note |
|---|---|---|---|
| `amount` | 0 | 100% | 0 deals at $0. No clustering at the $50K default |
| `weighted_amount` | 58 | 45.8% | Fallback applies to 58 deals |
| `units__c` | 0 | 100% | |
| `closedate` | 0 | 100% | 8 are past due. 12 close after 2026-12-31 |

These null counts come from reporting-API aggregates. Phase 1 re-checks them at record level, because empty strings and nulls can be counted differently.

---

## 3. Runtime architecture

### Recommendation: Google Apps Script web app, executed as a dedicated service account, with access limited to the findigs.com domain

Two deployment settings decide how identity, concurrency, and immutability work:

| Setting | Choice | Why |
|---|---|---|
| **Execute as** | **Me** (the script owner, which should be a shared RevOps Workspace account, not a person) | AEs need no Drive permissions on the snapshot folder, so they can't edit or delete snapshots in Drive directly. That makes the "never overwrite or delete" rule enforceable. Under "Execute as user accessing", every AE would need edit rights to the folder. |
| **Who has access** | **Anyone within findigs.com** | With this setting, `Session.getActiveUser().getEmail()` returns the viewer's verified Google SSO email even when the script runs as the owner. The app refuses to serve anything if the email is blank or not on the roster or leadership list. |

**How the rest works:**
- **Identity → permissions.** The server resolves the email to a roster entry. Every write call re-checks server-side that `ae_email == session email`. The client never tells the server who the user is.
- **HubSpot.** A private-app token is stored in Script Properties (`HUBSPOT_TOKEN`) with scopes `crm.objects.deals.read`, `crm.objects.owners.read`, and `crm.schemas.deals.read` (for pipelines). Read-only scopes make HubSpot writes impossible, not just avoided.
- **Data pull and cache.** A time-driven trigger runs every 30 minutes, plus a "Refresh data" button. It pulls pipelines, owners, and deals, runs the tie-out, and writes a `data_cache` JSON (Drive `_system/` subfolder) plus a `build_log` row. Page loads read the cache, so the UI stays fast and uses little HubSpot quota.
- **Submit.** A fresh per-owner HubSpot pull runs first, so the Closed Won YTD, gross, and weighted values in the snapshot reflect submission time, not cache time. Then, inside `LockService.getScriptLock()`, the app writes the JSON snapshot, appends a rollup row, and recomputes `is_official` for that AE and week. `submitted_at` is set by the server clock.
- **Concurrency.** Snapshot file names include the AE slug and a millisecond timestamp, so two files can't collide. The script lock serializes Sheet writes (30 s wait, then a clear "try again" error). This is ample for 5–6 AEs submitting on a Friday morning.
- **Builder tag state** lives in a protected `builder_state` tab (one row per AE × deal: tag, updated_at). It is mutable working state, separate from the immutable snapshots. At submission, the full tag list is frozen into the snapshot.
- **Tamper evidence.** Each rollup row stores the snapshot file's SHA-256. An admin function `verifySnapshots()` re-hashes every file and reports drift. A second admin function `rebuildRollup()` regenerates the Sheet from the JSON files, which are the source of truth.

### Alternatives compared

| | **A. Apps Script web app (recommended)** | **B. Cloud Run + IAP + Drive API** | **C. Static HTML rebuilt by a Claude routine + Google Form** |
|---|---|---|---|
| **Auth & identity** | Google SSO, domain-restricted. Email is verified server-side. No login code to maintain | IAP-verified Google identity header. Strongest option, with per-user IAM | Form collects the domain email, but the HTML has no user context: no per-row editing and no leadership vs. AE views |
| **Concurrent submissions** | `LockService` script lock. Limit of 30 simultaneous executions, which is far above need | True concurrency. Needs its own locking, because Drive and Sheets have none (Firestore or a Cloud Tasks queue) | Form handles concurrency, but tag state and validation can't run before the write |
| **Hosting & maintenance** | Zero infrastructure. Code in repo, deployed with `clasp`. Quotas: 6-min execution limit, 20k–100k UrlFetch calls/day. The main risk is script ownership, which this proposal mitigates with a shared owner account | GCP project, billing, container builds, IAM, Drive service-account delegation. The highest burden of the three for a two-person RevOps function | Low infrastructure, but data is only as fresh as the last run. Blocking validation and a live deal builder are not possible |
| **Secret handling** | Script Properties, visible to script editors only. Keep the editor list to 1–2 people | Secret Manager with IAM and audit log. Best in class | Token lives in the routine's connector. No end-user exposure |
| **Verdict** | Meets every requirement at the lowest burden | Worth it only if the tool grows beyond RevOps or needs non-Google users | Fails the requirements for identity-scoped editing and live validation |

### Apps Script risks and their mitigations

| Risk | Mitigation |
|---|---|
| Script owned by a person who later leaves | Owner is a shared Workspace account, and the script and folder live in a Shared Drive. **Open question Q7** |
| Someone with Drive edit rights deletes or edits a snapshot | AEs get no folder access. Editors are limited to 1–2 RevOps admins. SHA-256 verification catches edits |
| No native unit-test runner | All business logic (nesting validation, cutoff and week resolution, `is_official`, weighting, tie-out, movement reconciliation) lives in one pure-JS `core/forecast_core.js`. It is tested under `node --test` and copied into the Apps Script project at build time, so the same code runs in both places |
| HtmlService iframe sandbox | Chart.js 4.x loads from jsDelivr with a pinned version and an SRI hash. This works in IFRAME sandbox mode. If the CDN is blocked, the fallback inlines the pinned `chart.umd.min.js` (~200 KB) as an HTML include |
| HubSpot rate limits | Search API at 200 per page means about 3 calls for open deals and about 1 for won-YTD. Retry with backoff on 429 responses |

### Charting: Chart.js 4 (CDN), with no alternative needed

| Requirement | Chart.js mechanism |
|---|---|
| Commit–Best Case shaded band | `fill: { target: <commit dataset index> }` on the Best Case dataset (Filler plugin) |
| Missing week shows as a gap, never zero | `null` data points with `spanGaps: false`, plus a "Not submitted" marker on a separate scatter dataset at the axis baseline |
| Resubmission overlay | Scatter dataset of non-official submissions, toggled on and off |
| Click a point to open the drill-down | `onClick` → `getElementsAtEventForMode('nearest')` → week and AE |
| Shared vs. independent Y-axis | The small multiples take a computed `suggestedMax` shared across AEs, or `undefined` when the toggle is set to independent |
| Accessibility | "View as table" renders the same data array into an HTML table with CSV export |

**Reading history into Section 3:** one `getValues()` read of the `submissions` tab (one row per submission, with commit, gut, best, CW YTD, submitted_at, is_official, resubmission sequence, and the snapshot file ID). Trend charts and the change table use only that tab. The movement drill-down lazily fetches the two snapshot JSON files it compares, by file ID. Implied Landing = `closed_won_ytd` stored in each snapshot + the value, so history never depends on current HubSpot state.

### File layout

```
sales-forecast/
├── README.md                      deployment, secrets, roster maintenance, year rollover (Phase 5)
├── config/
│   ├── roster.json                AEs, leadership, non-roster owners (draft included in this phase)
│   └── forecast.json              cutoff, delta threshold, FY→Drive folder map, schema version
├── core/forecast_core.js          pure logic, shared by Node tests and Apps Script
├── appsscript/                    clasp root (generated + hand-written .gs/.html)
│   ├── appsscript.json            timeZone America/New_York; webapp executeAs USER_DEPLOYING, access DOMAIN
│   ├── Main.gs                    doGet, auth guard, google.script.run endpoints
│   ├── HubSpot.gs                 pipelines, owners, deal search, independent tie-out pull, retry
│   ├── Data.gs                    per-AE metrics, weighting fallback, DQ flags, cache
│   ├── Snapshots.gs               JSON write, rollup append, is_official, verify/rebuild
│   ├── BuilderState.gs            tag persistence
│   ├── Generated_Config.gs        GENERATED by scripts/build.mjs, never hand-edited
│   ├── Generated_Core.gs          GENERATED copy of core/forecast_core.js
│   └── ui/                        Index, Styles, Section1–3, Methodology, App.js (HtmlService includes)
├── scripts/build.mjs              gtm-dashboard/config.json + config/*.json → Generated_*.gs; drift check
├── scripts/seed_synthetic.mjs     ≥3 weeks of synthetic snapshots → TEST folder only (Phase 4)
├── tests/                         node --test unit tests + fixtures from real, anonymized pulls
└── docs/PHASE0_PROPOSAL.md        this document
```

Brand: the repo has Findigs tokens in `gtm-dashboard/template.html` (Forest `#212B14`, Sand `#FDFBF7`, Key Green `#8EDE65`, Findigs Sans from the CDN with a system-font fallback). These will be extracted into a shared `Styles.html`. Proposed series colors, used in all three sections: **Commit = Forest `#212B14`**, **Gut = Jade `#22C386`**, **Best Case = Sky `#ADD2FF`** (with a darker stroke for contrast), and **Closed Won YTD = Sun `#FFCE59`, dashed**. They will be validated for contrast in Phase 4.

---

## 4. Snapshot schema (v1.0)

**File name:** `forecast_{forecast_week}_{ae_slug}_{submitted_at}.json`, for example `forecast_2026-10-02_phil-aroian_2026-10-02T10-41-07.312-04-00.json`. Colons are replaced with `-` because some sync clients reject `:` in file names. The unmodified ISO 8601 timestamp is stored inside the file.

```json
{
  "schema_version": "1.0",
  "submission_id": "uuid-v4",
  "app_version": "git short SHA at deploy",
  "forecast_week": "2026-10-02",
  "cutoff_at": "2026-10-02T12:00:00-04:00",
  "forecast_period": { "start": "2026-10-02", "end": "2026-12-31" },
  "ae": { "name": "Phil Aroian", "email": "phil.aroian@findigs.com", "hubspot_owner_id": "1053057926", "slug": "phil-aroian" },
  "submitted_at": "2026-10-02T10:41:07.312-04:00",
  "submitted_by_email": "phil.aroian@findigs.com",
  "forecast": { "commit": 1200000, "gut": 2100000, "best_case": 4800000 },
  "validation": { "nesting_ok": true, "warnings": ["best_case_exceeds_in_period_pipeline"] },
  "context_at_submission": {
    "data_pulled_at": "2026-10-02T10:41:05-04:00",
    "closed_won_ytd": { "amount": 5240539.03, "count": 14, "window": ["2026-01-01", "2026-10-02"] },
    "gross_open_pipeline": { "amount": 41741263.58, "count": 32 },
    "gross_open_pipeline_in_period": { "amount": 0, "count": 0 },
    "weighted_open_pipeline": { "amount": 0, "stored_count": 21, "fallback_count": 11 },
    "implied_landing": { "commit": 0, "gut": 0, "best_case": 0 },
    "tie_out_status": "reconciled | mismatch",
    "stage_map_hash": "sha256 of pipelines API stage payload"
  },
  "builder": {
    "saved": true,
    "state_updated_at": "2026-10-02T10:30:00-04:00",
    "totals": { "commit": 0, "gut_cumulative": 0, "best_case_cumulative": 0 },
    "tag_counts": { "commit": 0, "gut": 0, "best_case": 0, "lost": 0, "none": 0 },
    "deals": [
      { "deal_id": "315306386143", "deal_name": "…", "pipeline": "2313721535", "stage_id": "3753890500", "stage": "Negotiation & Execution",
        "amount": 856000, "units": 8000, "close_date": "2026-11-15", "tag": "commit",
        "flags": ["past_due" , "missing_amount", "missing_close_date"] }
    ]
  }
}
```

- `builder.deals` holds **every** open deal the AE owned at submission, including the ones tagged None. The drill-down can then tell "tag removed" apart from "deal left the AE's pipeline" (closed, lost, or reassigned) and report both.
- `amount: null` is written as null, never 0.

**Rollup Sheet** (`Sales Forecast Rollup 2026`, same folder), tab `submissions`: `submission_id, forecast_week, ae_slug, ae_name, ae_email, owner_id, submitted_at, commit, gut, best_case, closed_won_ytd, gross_pipeline, weighted_pipeline, weighted_fallback_n, is_official, resubmission_seq, builder_saved, builder_commit, builder_gut_cum, builder_best_cum, warnings, tie_out_status, schema_version, drive_file_id, file_name, sha256`. The only cell the app ever rewrites is `is_official`, and only under the lock, when a later on-time submission for the same AE and week supersedes an earlier one. Other tabs: `builder_state` (protected), `build_log`, `meta`.

**Week and cutoff rule (proposed):** `forecast_week` = the first Friday 12:00:00 ET cutoff at or after `submitted_at`. `is_official` = the latest submission per (AE, forecast_week). Under this rule, a submission at Friday 12:00:01 belongs to *next* Friday's week. That is the likely behavior, but it is a policy choice: see **Q1**.

**Year rollover:** `config/forecast.json` maps each fiscal year to a Drive folder ID (`"2026": "1WGzeVVLMlfTHpU9S5GKVB45EDRx84I_P"`). A snapshot's FY is the year of its `forecast_week`. The forecast period is `max(submission date, Jan 1 of that year)` → Dec 31 of that year. Consequences:
- After the 2026-12-25 cutoff (a holiday), the next week is **2027-01-01** (also a holiday). It would be an FY2027 forecast, with Closed Won YTD reset and period end 2027-12-31.
- If the FY2027 folder ID is missing from config, submission is **blocked** with an admin message. The app does not create folders on its own.
- Section 3 defaults to the current FY and offers a prior-FY selector.
- The 2027 folder and a new rollup Sheet should be created in December. The README (Phase 5) will include a checklist.

---

## 5. Data quality findings

| # | Severity | Finding | Evidence (2026-09-25) | Handling in tool |
|---|---|---|---|---|
| DQ-1 | High | `weighted_amount` is blank on 58 of 107 open deals, and 45 of the 49 populated values don't equal amount × stage probability | Stored $4.20M vs $5.96M stage-weighted on the same deals | **Superseded by P1-3:** stage probability is used for all deals, and `weighted_amount` is shown as reference in methodology |
| DQ-2 | High | Clay Stapleford: HubSpot owner `isActive=true`, but there is **no HubSpot user seat** for him. Notion (9/14) says his accounts are flagged for reassignment, and that has not been executed | 5 open / $2,508,550.00 (2 past due, $975,840.00). 14 CW YTD / $654,238.85 | Non-roster reconciliation row plus a banner. Deals appear in no AE's builder until reassigned. The `isActive` check alone would **not** catch this case, so the app also checks for a user seat |
| DQ-3 | Medium | Excluded owner Reese Ryan holds deals | 2 open / $197,865.00 (both past due). 16 CW YTD / $302,132.80 | Non-roster row |
| DQ-4 | Medium | Inactive owner holds closed-won YTD | Hayden Ashwill: 4 / $113,672.60 | Counts in company CW YTD and in the non-roster row |
| DQ-5 | Medium | Past-due open deals | 8 deals / $2,107,044.60 (Phil 2, Clay 2, Reese 2, Matt 1, Ian 1) | Flagged in Section 2 and included in totals |
| DQ-6 | Medium | Stage 1 concentration vs. the 9/14 "qualified pipeline = Stage 2+" decision | 64 of 107 open deals are in Intro & Challenge | **Q4** decides whether Gross/Weighted in Section 1 excludes Stage 1 |
| DQ-7 | Medium | Pipeline concentration | Phil holds 60% of gross open ($41.7M of $69.6M) | Informational. Shared Y-axis will make other AEs' charts look flat, so the independent-axis toggle matters |
| DQ-8 | Low | Deal probability deviates from the stage default | 1 New Logo Discovery/Demo deal at 0.15 vs. 0.20 | Fallback uses the deal-level value (same as gtm-dashboard) and flags the deal |
| DQ-9 | Low | Open deals closing after the forecast period | 12 deals (Phil 7, Matt 4, Ben 1) | Hidden by the default ≤ 2026-12-31 filter, shown by the toggle |
| DQ-10 | Low | Spencer Wuthrich: no weighted values and no closed-won | 3 open / $4,879,200.00, all on fallback. 0 CW YTD. User seat created 2026-09-03 | Test case for zero CW YTD. Implied landing = Gut |
| DQ-11 | Low | Timezone boundary risk on the tie-out | Reporting-API date filters vs. ET-converted `closedate` | The independent check uses the same ET-converted boundaries. Any boundary deal is listed if the tie-out misses |
| DQ-12 | Info | Open pipeline shrank since the 9/14 gtm snapshot | 117 → 107 deals, $90.19M → $69.62M | Consistent with the hygiene cleanup. No action |
| DQ-13 | Info | Stage probabilities are not readable through the MCP connector | gtm-dashboard observes them from deal records | The deployed app reads the pipelines API. Phase 1 verifies it against the table above |

Null amounts, units, and close dates are 0 today. The flags stay in the build anyway because the requirements expect them, and Phase 5 tests them with fixtures.

---

## 6. Tie-out check design

| Layer | Primary figure | Independent figure | Where a mismatch shows |
|---|---|---|---|
| Runtime (each data pull) | CRM **Search API** (index), summed per owner and in total | CRM **Objects list / batch-read API** (primary store, a different backend from the search index), summed with the same ET logic | Red banner in Section 1 + methodology panel + `build_log` row |
| Build/QA (Phases 1 and 5) | App output | MCP `query_crm_data` **reporting-API** aggregates (the same controls gtm-dashboard uses) | `sales-forecast/output/tieout.md` + build log |

The measures reconciled within $0.01 are Closed Won YTD (company and per owner) and Gross Open Pipeline (company and per owner). Counts must match exactly. The tie-out does not block the UI: it shows the mismatch and lists the delta deals.

---

## 7. Open questions (need answers before Phase 1)

| # | Question | Recommendation |
|---|---|---|
| **Q1** | A submission after Friday 12:00 ET: does it (a) count toward **next** Friday's week, or (b) get stored as a **late** submission for this week (`is_official=false`, `is_late=true`), leaving this week "Not submitted"? | **(a)** is simpler and needs no special cases. Section 1 would still show "Late: submitted Fri 12:05" so leadership sees it on Monday |
| **Q2** | Phil runs the Friday forecast call and holds 60% of pipeline. Is he an AE who submits, a leader who sees all rows, or both? | `ae_leader` role: edits his own row, reads all rows |
| **Q3** | Should Team Total cover roster AEs only? | Yes. Add a read-only "Non-roster owners" row (Clay, Reese, Hayden) below it, so the CW YTD and pipeline columns tie to company totals |
| **Q4** | Gross/Weighted Open Pipeline in Section 1: all open stages (ties to gtm-dashboard) or Stage 2+ only (per the 9/14 qualified-pipeline decision)? And all close dates, or close date ≤ 2026-12-31? | Show all open stages and all dates as the headline, so it ties to gtm-dashboard. Show in-period pipeline as a sub-line. The Best Case warning compares against **in-period** pipeline |
| **Q5** | Clay's 5 open deals: leave as non-roster until they are reassigned in HubSpot, or hold the build until then? | Proceed. They appear in the non-roster row with a banner |
| **Q6** | Leadership list: Brian Korchin and Will Ritchings confirmed. Anyone else (Asaf Raz, Emma Kyber, Dan Soltis)? | Keep it to the Monday call attendees who need it |
| **Q7** | Which Google account owns the script, and is the `2026` folder in a Shared Drive? Its parent is `16JSvjXHqwwYjMMznYnEaZjhmLj5zxcJB`, and the connector doesn't report a drive ID. | A shared RevOps Workspace account, with the script and folder in a Shared Drive |
| **Q8** | Holiday cutoffs (Fri 11/27, 12/25, 1/1): does the cutoff move, or do we accept "Not submitted" gaps? | Configurable cutoff overrides in `forecast.json` (for example, 12/25 → Wed 12/23 12:00) |
| **Q9** | The Notion definition of Commit (9/18: "verbal received, residual contract risk") differs in wording from this spec ("99% confidence"). Which goes in the methodology panel? | Show the spec's confidence level plus the Notion operating definition, with a link to Notion |

<details>
<summary><strong>Sources & methodology</strong></summary>

| Item | Source | Method |
|---|---|---|
| Stage IDs and probabilities | HubSpot `query_crm_data` (reporting API) | `SELECT dealstage, hs_deal_stage_probability, COUNT(*) FROM DEAL WHERE pipeline IN (2313721535, 2313830082) GROUP BY …` |
| Owners and isActive | HubSpot `search_owners` by ID | Owner IDs from open and won-YTD aggregates |
| AE emails and user seats | HubSpot `users` object search (45 users) | Matched on `hubspot_owner_id` |
| Open pipeline by owner | `query_crm_data` | Non-terminal stage IDs, both in-scope pipelines, `SUM(amount)`, `SUM(weighted_amount)` |
| Closed Won YTD | `query_crm_data` | Won stage IDs, `closedate BETWEEN 2026-01-01 AND 2026-09-25` (reporting-API date semantics, not yet ET-converted) |
| Null rates | `query_crm_data` | `IS NULL` counts per owner on open deals |
| Post-9/14 closes | `search_crm_objects` | Won stages, `closedate ≥ 2026-09-14` |
| Reused definitions | `gtm-dashboard/config.json` v2026-09-22, `build.py` | Read directly |
| Forecast practice | Notion: Revenue Operations → Pipeline Forecasting → "Revenue Leadership Forecast Weekly" (updated 2026-09-18) | Read directly |
| Drive target | Drive metadata for `1WGzeVVLMlfTHpU9S5GKVB45EDRx84I_P` | Folder exists, writable, empty |

Caveats: the aggregates are point-in-time (2026-09-25, about 13:45 ET). Weighted totals here are the stored value only; the fallback amount is computed in Phase 1 from record-level data.
</details>
