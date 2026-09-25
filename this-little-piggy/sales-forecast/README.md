# Sales Forecast (weekly AE call/commit tool)

Google Apps Script web app for the Friday AE forecast and the Monday Revenue Leadership review. Architecture, schema, and decisions: `docs/PHASE0_PROPOSAL.md`. The full deployment, roster maintenance, and year-rollover guide will be written in Phase 5. This file currently covers only the Phase 1 data layer.

## Layout
```
config/roster.json, config/forecast.json   hand-edited sources
core/forecast_core.js                      all business logic (Node-tested, copied into Apps Script)
appsscript/                                clasp project root
  Generated_Config.gs, Generated_Core.gs   GENERATED — never edit; run `npm run build`
  Client_Core.html, Client_Config.html     GENERATED — browser copies of core + safe config subset (no roster)
  HubSpot.gs  Data.gs  Storage.gs  BuilderState.gs  Main.gs      server
  Index.html  Styles.html  Client_App.html  Client_Builder.html   UI (HtmlService)
scripts/build.mjs                          gtm-dashboard/config.json + config/*.json → Generated_Config.gs
scripts/verify_phase1.mjs                  live-pull tie-out against reporting-API controls
scripts/preview.mjs                        local preview: real .gs + UI, fake HubSpot, in-memory Sheets
tests/                                     node --test: core, Apps Script simulation, builder API, Chromium UI
verification/<date>/                       raw pulls, controls, tieout.md, sample AE output
```

HubSpot definitions (pipelines, stage IDs, fields, weighting, tolerance) come **only** from `../gtm-dashboard/config.json`, so Closed Won YTD ties out between the two tools. `npm test` fails if the generated files are stale or if the config breaks a requirement (for example, Renewal in scope, a forbidden field in the pull list, or a duplicate roster entry).

## Local checks
```
npm test              # build --check + all tests (UI tests need global Playwright; they skip otherwise)
npm run preview       # http://127.0.0.1:8787/?as=ben.dewinter@findigs.com  (try ?as=brian.korchin@findigs.com)
npm run verify:phase1 # re-runs the 2026-09-25 tie-out from verification/
```

## Phase 1 live check in Apps Script (admin)
1. HubSpot → Settings → Integrations → Private apps → create **Findigs Sales Forecast (read-only)** with scopes `crm.objects.deals.read`, `crm.objects.owners.read`, `crm.schemas.deals.read`. No write scopes.
2. `npm i -g @google/clasp`, then `clasp login`. Create a standalone script in the Shared Drive with `clasp create --type standalone --rootDir appsscript`, then run `npm run build && clasp push`.
3. Apps Script editor → Project Settings → Script properties → add `HUBSPOT_TOKEN`. The token is never committed.
4. Run `debugSampleAe` from the editor and authorize the requested scopes. The log shows Ben de Winter's figures, the Search-vs-Objects tie-out, and flags. A `build_log` row is appended to **Sales Forecast Rollup 2026** in the 2026 folder, which is created on first run.
5. Optional: run `installTriggers` to refresh data every 30 minutes.

**Pass criteria (gate for Phase 3, which writes to the production Drive folder):**
- [ ] `debugSampleAe` completes. The tie-out shows `ok: true`: Search API vs Objects list API within $0.01 and counts exact
- [ ] Company Closed Won YTD and Gross Open match HubSpot reports for the same day
- [ ] Stage map passes: no drift error, 14 in-scope stages
- [ ] Clay Stapleford shows `ownerStatus: no_user_seat` and Hayden Ashwill shows `inactive`. This confirms the owners-API mapping
- [ ] **Sales Forecast Rollup 2026** exists in the 2026 folder with tabs `submissions`, `builder_state`, `build_log`, `meta`, and one `build_log` row
- [ ] `_system/data_cache.json` exists in the 2026 folder

`.clasp.json` holds the script ID and is git-ignored.
