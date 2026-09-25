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
| P2-1 | Builder totals cover every open deal regardless of the filter, and stay about the forecasting exercise only | `ForecastCore.builderSummary` |
| P2-2 | Deals with no close date always show, so the rep decides whether they are in the forecast | `ForecastCore.builderFilter` |
| P2-3 | The builder shows open deals only. A tagged deal that closes or is reassigned drops out with no note; closed won appears in Closed Won YTD | `Main.gs apiGetBuilder` |
| P2-4 | Series colors Commit `#0F7A50`, Gut `#7A9A1F`, Best Case `#3B6FB8`, Closed Won YTD `#8A5A00` | `config/forecast.json` series_colors |
| P2-5 | Leadership's default AE is the first alphabetically | `Main.gs targetAe_` |
| P2-6 | Notion Data Definitions now holds two approved weighting methods, usable interchangeably per tool: Method A "Weighted deal value" / "Weighted open pipeline" (GTM dashboard) and Method B "Weighted deal value (stage probability)" / "Weighted open pipeline (stage probability)" (Sales forecast tool). New "Used by" option: Sales forecast tool | Notion Metric Definitions |
