# Sales forecast: QA test list (Phase 5)

Every case in the Phase 5 QA list is automated and runs with `npm test`: 127 tests, 0 failures as of 2026-09-28.
The tests run the real Apps Script code (`appsscript/*.gs`, loaded alphabetically as Apps Script does) against a fake HubSpot that serves the live 2026-09-25 pulls, plus in-memory Drive and Sheets. Browser tests drive the real UI in Chromium. The live checks at the end cover what only Google can prove.

## Required cases

| # | Case | Automated test (file › name) | What it proves |
|---|---|---|---|
| 1 | Nesting rule validation | `submission.test.mjs` › *validateForecast: nesting rule…* · *blocking validation happens server-side too* · `ui_submission.test.mjs` › *AE: nesting rule blocks submit…* | Commit > Gut or Gut > Best Case blocks the submission in the browser **and** on the server; nothing is written. Equal values are allowed |
| 2 | Resubmission before and after the cutoff | `submission.test.mjs` › *resubmission before the cutoff…* · *submission after the cutoff counts toward next week…* · *forecast week: Mon–Fri 11:59:59.999 ET…* · `trend.test.mjs` › *apiGetTrend: the open week is hidden until its cutoff passes* | Before the cutoff (Friday 5:00 PM ET since P5-5): new file, earlier row un-officialed, only `is_official` edited in place. At 5:00:00 PM and later: counts toward next Friday; this week is untouched. DST-aware |
| 3 | AE with zero open pipeline | `submission.test.mjs` › *zero open pipeline AE can submit $0…* · `builder.test.mjs` › *zero-pipeline AE gets an empty builder…* · `core.test.mjs` › *computeMetrics: rows, zero-pipeline AE…* | $0 submission accepted; Best Case > $0 warns (not blocks); empty builder, not an error |
| 4 | Inactive-owner deal | `qa.test.mjs` › *inactive owner holding an open deal…* · `core.test.mjs` › *computeMetrics: roster owner inactive / unknown / seatless flagged high* | The deal appears in the non-roster row and the company total, is flagged, and is in no AE row or builder. Tie-out still reconciles |
| 5 | Missing-amount deal | `qa.test.mjs` › *deal with no amount…* · `core.test.mjs` › *missing amount: blank + flag, never imputed* · `builder.test.mjs` › *builderSummary: missing amount counted but $0…* | Shown blank and flagged; weighted blank; tagging it adds $0 and warns; the snapshot stores `null`, never 0 |
| 6 | Concurrent submissions by two AEs | `qa.test.mjs` › *concurrent submissions by two AEs…* · *overlapping submissions for the same AE…* · `submission.test.mjs` › *lock contention: clear error, nothing written* | Interleaved submissions both land with separate immutable files. **Fixed in Phase 5:** if two submissions for the same AE overlap, the later `submitted_at` stays official even when it is written first |
| 7 | Missing week renders as a gap | `trend.test.mjs` › *trendSeries: a missing week is a null gap…* · `ui_trend.test.mjs` › *trend: team + per-AE charts, gap (not zero) with marker…* | Every series is `null` for the missed week (not 0, not carried forward), with a dashed "Not submitted" marker and blank table cells |
| 8 | Single-week trend state | `trend.test.mjs` › *trendSeries: one week of data → trendAvailable false…* · `ui_trend.test.mjs` › *single closed week…* | Points render; "Trend requires 2+ submissions" is shown on the page and on each card |
| 9 | Resubmission overlay | `trend.test.mjs` › *only official rows are plotted; superseded … feed the overlay* · `ui_trend.test.mjs` › *view toggle … resubmission overlay* | Superseded same-week submissions are drawn as hollow rings, listed in the tooltip, and counted; they never replace the official point |
| 10 | Drill-down reconciliation mismatch is flagged, not hidden | `trend.test.mjs` › *movementDrilldown: a submitted change tag movement does not explain…* · `ui_trend.test.mjs` › *drill-down: … mismatch flagged not hidden…* | "Does not reconcile" banner, per-value unexplained $, and flagged rows. $0.01 tolerance |
| 11 | A week with no builder tags saved | `trend.test.mjs` › *movementDrilldown: no builder tags saved…* · `ui_trend.test.mjs` › *drill-down: … no-tags week says so…* | "No Forecast Builder tags were saved this week. Deal movement is not inferred." No deal lists or reconciliation are produced |

## Additional coverage (from the build requirements)

| Area | Tests |
|---|---|
| Tie-out within $0.01 (Closed Won YTD, Gross Open) and mismatch surfaced in the UI and build log | `appsscript_sim.test.mjs` › *pullData_: live fixture reconciles…* · *runtime tie-out mismatch is surfaced…* |
| Read-only toward HubSpot | `appsscript_sim.test.mjs` › *hsRequest_: blocks writes…* · `builder.test.mjs` › *apiSaveTags: … never calls HubSpot writes* |
| Snapshots never overwritten or deleted; integrity check | `submission.test.mjs` › *Snapshots.gs never rewrites or deletes Drive files* · *verifySnapshots detects edited and deleted files* · `trend.test.mjs` › *apiGetMovement: … integrity check on read* |
| Renewal pipeline excluded; forbidden fields never pulled | `core.test.mjs` › *config: reuses gtm-dashboard definitions, excludes renewal…* · *classify: renewal + lost excluded…* |
| Year rollover | `submission.test.mjs` › *year rollover: FY2027 folder not configured blocks the submission…* · `qa.test.mjs` › *rolloverStatus…* · *trend in the first week of January…* |
| Synthetic data only in test mode | `trend.test.mjs` › *seedSyntheticSnapshots: refuses outside test mode…* · *skips any AE/week that already has a real test submission* |
| Chart library fallback | `ui_trend.test.mjs` › *Chart.js: blocked CDN and SRI failure both fall back…* |
| Permissions (transparency, edit own only, admin on behalf) | `submission.test.mjs` › *permissions…* · *admin submits on behalf…* · `ui_submission.test.mjs` › *Admin: submits on behalf…* |

## Admin panel (P6)

| Case | Automated test | What it proves |
|---|---|---|
| Only admins can open or use it | `admin.test.mjs` › *only admins can open or use the panel* · `ui_admin.test.mjs` › *Admin tab: visible to admins only* | Every admin endpoint re-checks on the server; the tab is hidden for AEs and leadership |
| Invite an AE end to end | `admin.test.mjs` › *invite an AE end to end…* · `ui_admin.test.mjs` › *invite an AE with confirmation…* | Saved to the runtime roster, email sent with Reply-To the inviter, audit-logged, a new Section 1 row appears, and the new user can sign in and submit |
| Roster rules | `admin.test.mjs` › *invite: AE needs a real, unassigned HubSpot owner…* · *change access…* | findigs.com only, no duplicates, owner must exist and be unassigned, unique slugs, last-admin and self-demotion guards |
| Deactivate keeps history | `admin.test.mjs` › *deactivate an AE…* · `ui_admin.test.mjs` › *change access, deactivate…* | Access denied immediately, row gone, deals move to Other owners with totals still tying, trend history and movement still readable, reactivation restores |
| No email in test mode | `admin.test.mjs` › *invite without email, and no email is ever sent in test mode* | Test mode can't email real people |
| Year rollover from the panel | `admin.test.mjs` › *year rollover folder from the panel…* · `ui_admin.test.mjs` › *health, Other owners reason, and year-rollover folder…* | Validated, can't overwrite a configured year or reuse a folder, banner clears, FY2027 submissions land in the new folder |
| Health actions | `admin.test.mjs` › *health actions…* | Refresh, trigger install, and integrity check work and are logged |

## Live checks (Google only; run at go-live)
- [x] Phase 1: live data pull ties out (2026-09-25, `verification/2026-09-25/live_run_apps_script.md`)
- [x] Phase 3: test-mode submission and resubmission write immutable files and correct `is_official` (2026-09-25)
- [x] Phase 4: synthetic trend renders in the web app; the chart library loads (2026-09-25)
- [ ] Go-live: `FORECAST_TEST_FOLDER_ID` deleted; the first real submission lands in the production 2026 folder and **Sales Forecast Rollup 2026**
- [ ] Admin panel: after `clasp push`, the owner approves the new "send email" permission, then an invite to a test address arrives with the `/exec` link
- [ ] Go-live: `installTriggers` run; the refresh trigger shows in Triggers and `build_log` gains a row every 30 minutes
- [ ] First Friday: every AE opens the `/exec` URL and submits before 5:00 PM ET; Monday review uses Section 3 with two or more weeks
- [ ] After the first Friday: run `verifySnapshots` and confirm the log shows `"ok": true` with `problems: []`
