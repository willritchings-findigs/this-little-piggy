# Phase 3 test-mode trial: 2026-09-25 13:33–13:37 ET

Run by Will Ritchings (admin) from the Apps Script test deployment (`/dev`), with `FORECAST_TEST_FOLDER_ID` set. Two submissions on behalf of Ben de Winter. Verified independently by Claude via Google Drive.

| Check | Evidence | Result |
|---|---|---|
| Validation in browser (nesting, negative, non-numeric; Best Case warning) | Will: steps 5a–5c as expected | PASS |
| Snapshot per submission, never overwritten | `_test/FY2026`: `forecast_2026-10-02_ben-de-winter_2026-09-25T13-35-26.778-04-00.json`, `…T13-36-01.516-04-00.json` | PASS |
| Rollup rows | Sales Forecast Rollup 2026 (TEST): row 1 best_case 9,000,000 / is_official FALSE / seq 1 / warning `best_case_exceeds_in_period_pipeline`; row 2 best_case 1,000,000 / TRUE / seq 2 | PASS |
| On-behalf attribution | submitted_by `will.ritchings@findigs.com`, on_behalf TRUE on both rows; appended columns AB/AC present | PASS |
| Submission-time figures | closed_won_ytd 484,825.04; gross 6,325,852; in-period 5,041,852; weighted 987,700.40; tie-out reconciled | PASS |
| Production untouched | 2026 folder: only `_system` + rollup; submissions tab header only | PASS |
| UI state after resubmit (screenshot) | Status Resubmitted, 2 submissions this week, implied landing $684,825, on-behalf notice | PASS |

## Defect found and fixed
**Duplicate folders on concurrent first load.** Section 1 and the builder loaded in parallel. Both missed `FY2026` and `_system` on an empty test folder and both created them 73 ms apart (`1Q0NRR4c…` with data, `1FUD0hha…` empty), and two `data_cache.json` files were written. Risk: later requests could pick the empty folder and split data. The same race could hit FY2027 folders or rollup creation at year rollover.

- **Fix:** every create-if-missing path (FY test folder, `_system`, `data_cache.json`, rollup workbook and header migration) now re-checks under a shared re-entrant script lock (`withScriptLock_`). The builder tab also loads lazily, so a page load makes one server call. Test `concurrent first loads create each folder and cache file once` fails on the old code and passes on the new code.
- **Cleanup (Drive trash, recoverable 30 days):** the empty duplicate folder `1FUD0hhat2JWjp0UPr45JA3N-0ngMeu4K` and the duplicate cache `1A8C_Uua7qpZqcSKNNk2n8UiwgqatiOCA`.
- The first load ran two full HubSpot pulls (two `build_log` rows at 13:33:45); lazy tab loading removes that.
