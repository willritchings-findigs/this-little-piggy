# Live Apps Script run: 2026-09-25 13:01 ET (Phase 3 gate)

Run by Will Ritchings: `debugSampleAe` in the **Sales Forecast** Apps Script project (script owner Will; HubSpot private app, read-only scopes). Verified independently by Claude via HubSpot reporting API and Google Drive.

| Pass criterion | Evidence | Result |
|---|---|---|
| Tie-out ok (Search API vs Objects list API, ≤ $0.01, counts exact) | log `"tieOut": {"ok": true, "mismatches": []}`; build_log `reconciled` | PASS |
| Company CW YTD and Gross Open match HubSpot | app $7,571,305.12 / 73 and $69,616,046.13 / 107; reporting API (same day) identical | PASS |
| Stage map: no drift | pull completed, no drift error; no UNKNOWN_STAGE flag on 107 open deals | PASS |
| Owners-API mapping (archived = inactive, no userId = no seat) | Clay Stapleford "no user seat", Hayden Ashwill "inactive" | PASS |
| Rollup workbook created | "Sales Forecast Rollup 2026" (1BG8wJB12SB1jKXqD4mKejpwXw7z4QoLfBpt7FFIiXXU): submissions, builder_state, build_log, meta; 1 build_log row, status OK | PASS |
| Cache written | `_system/data_cache.json` (1oxnxch8B8TE_iAvItgtqhT9QuiTYaAQZ), 116,633 bytes | PASS |
| Sample AE (Ben de Winter) | CW YTD $484,825.04 (5); gross $6,325,852 (12); in-period $5,041,852 (11); stage-weighted $987,700.40; identical to local verification | PASS |

Flags returned (same 7 as local verification): NON_ACTIVE_OWNER_WON_YTD ×2 (Hayden, Clay), NON_ROSTER_OPEN_DEALS ×2 (Reese, Clay), WEIGHTED_STORED_DIVERGES (45), PAST_DUE (8), PROB_DEVIATES (1).

Run time: 45 s (13:01:13 → 13:01:58), well under the 6-minute Apps Script limit.
