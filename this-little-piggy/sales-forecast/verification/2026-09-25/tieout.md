# Phase 1 tie-out — as of 2026-09-25 ET

Primary: CRM Search API record pulls (open 107, won 74 incl. boundary over-fetch) → `ForecastCore.computeMetrics`.
Independent: HubSpot reporting API aggregates (`controls_reporting_api.json`). Tolerance $0.01; counts exact.

**Result: RECONCILED** · weighted checks reconciled

## Closed Won YTD and Gross Open Pipeline

| Scope | Measure | Primary | Independent | Δ $ | n (P / I) | |
|---|---|---|---|---|---|---|
| Company | Closed Won YTD | $7,571,305.12 | $7,571,305.12 | 0.00 | 73 / 73 | ✅ |
| Company | Gross Open Pipeline | $69,616,046.13 | $69,616,046.13 | 0.00 | 107 / 107 | ✅ |
| Matt Lynch | Closed Won YTD | $420,389.86 | $420,389.86 | 0.00 | 6 / 6 | ✅ |
| Matt Lynch | Gross Open Pipeline | $10,820,904.35 | $10,820,904.35 | 0.00 | 21 / 21 | ✅ |
| Phil Aroian | Closed Won YTD | $5,240,539.03 | $5,240,539.03 | 0.00 | 14 / 14 | ✅ |
| Phil Aroian | Gross Open Pipeline | $41,741,263.58 | $41,741,263.58 | 0.00 | 32 / 32 | ✅ |
| Hayden Ashwill | Closed Won YTD | $113,672.60 | $113,672.60 | 0.00 | 4 / 4 | ✅ |
| Hayden Ashwill | Gross Open Pipeline | $0.00 | $0.00 | 0.00 | 0 / 0 | ✅ |
| Spencer Wuthrich | Closed Won YTD | $0.00 | $0.00 | 0.00 | 0 / 0 | ✅ |
| Spencer Wuthrich | Gross Open Pipeline | $4,879,200.00 | $4,879,200.00 | 0.00 | 3 / 3 | ✅ |
| Ben de Winter | Closed Won YTD | $484,825.04 | $484,825.04 | 0.00 | 5 / 5 | ✅ |
| Ben de Winter | Gross Open Pipeline | $6,325,852.00 | $6,325,852.00 | 0.00 | 12 / 12 | ✅ |
| Ian McLaughlin | Closed Won YTD | $355,506.94 | $355,506.94 | 0.00 | 14 / 14 | ✅ |
| Ian McLaughlin | Gross Open Pipeline | $3,142,411.20 | $3,142,411.20 | 0.00 | 32 / 32 | ✅ |
| Reese Ryan | Closed Won YTD | $302,132.80 | $302,132.80 | 0.00 | 16 / 16 | ✅ |
| Reese Ryan | Gross Open Pipeline | $197,865.00 | $197,865.00 | 0.00 | 2 / 2 | ✅ |
| Clay Stapleford | Closed Won YTD | $654,238.85 | $654,238.85 | 0.00 | 14 / 14 | ✅ |
| Clay Stapleford | Gross Open Pipeline | $2,508,550.00 | $2,508,550.00 | 0.00 | 5 / 5 | ✅ |

## Weighted open pipeline (method: amount × pipeline stage probability)

Stage-weighted is checked against an independent reporting-API SUM(amount) by owner × stage. HubSpot `weighted_amount` is pulled for reference only and must still reconcile to prove the comparison uses the real field. "Old rule" = gtm-dashboard stored-first rule, shown for impact only.

| Owner | Stage-weighted (primary) | Stage-weighted (independent) | Old rule (stored-first) | HubSpot weighted_amount Σ (primary / reporting API) | blank (primary / API) | |
|---|---|---|---|---|---|---|
| Ian McLaughlin | $769,728.78 | $769,728.78 | $648,664.24 | $432,878.76 / $432,878.76 | 17 / 17 | ✅ |
| Spencer Wuthrich | $487,920.00 | $487,920.00 | $487,920.00 | $0.00 / $0.00 | 3 / 3 | ✅ |
| Reese Ryan | $123,036.00 | $123,036.00 | $145,071.00 | $57,291.00 / $57,291.00 | 1 / 1 | ✅ |
| Clay Stapleford | $424,952.00 | $424,952.00 | $449,823.00 | $223,839.00 / $223,839.00 | 4 / 4 | ✅ |
| Matt Lynch | $1,680,626.88 | $1,680,626.88 | $1,522,768.63 | $511,956.75 / $511,956.75 | 14 / 14 | ✅ |
| Phil Aroian | $6,830,084.43 | $6,830,084.43 | $5,679,435.90 | $2,862,500.76 / $2,862,500.76 | 11 / 11 | ✅ |
| Ben de Winter | $987,700.40 | $987,700.40 | $579,300.40 | $113,080.00 / $113,080.00 | 8 / 8 | ✅ |
| **Company** | **$11,304,048.49** | **$11,304,048.49** | $9,512,983.17 | $4,201,546.27 / $4,201,546.27 | 58 / 58 | |

## Section 1 figures (roster AEs, team, non-roster, company)

| Row | Closed Won YTD (n) | Gross Open (n) | In-period ≤ 12/31 (n) | Weighted Open (stage) | weighted n / blank n | Past due |
|---|---|---|---|---|---|---|
| Phil Aroian (AE + leader) | $5,240,539.03 (14) | $41,741,263.58 (32) | $23,347,253.58 (25) | $6,830,084.43 | 32 / 0 | 2 |
| Spencer Wuthrich | $0.00 (0) | $4,879,200.00 (3) | $4,879,200.00 (3) | $487,920.00 | 3 / 0 | 0 |
| Ian McLaughlin | $355,506.94 (14) | $3,142,411.20 (32) | $3,142,411.20 (32) | $769,728.78 | 32 / 0 | 1 |
| Ben de Winter | $484,825.04 (5) | $6,325,852.00 (12) | $5,041,852.00 (11) | $987,700.40 | 12 / 0 | 0 |
| Matt Lynch | $420,389.86 (6) | $10,820,904.35 (21) | $8,215,834.35 (17) | $1,680,626.88 | 21 / 0 | 1 |
| **Team Total (roster)** | $6,501,260.87 (39) | $66,909,631.13 (100) | $44,626,551.13 (88) | $10,756,060.49 | 100 / 0 | 4 |
| ↳ Hayden Ashwill — Inactive owner; closed-won YTD only, no open deals | $113,672.60 (4) | $0.00 (0) | $0.00 (0) | $0.00 | 0 / 0 | 0 |
| ↳ Reese Ryan — Excluded pending role confirmation | $302,132.80 (16) | $197,865.00 (2) | $197,865.00 (2) | $123,036.00 | 2 / 0 | 2 |
| ↳ Clay Stapleford — Owner record isActive=true but no HubSpot user seat; accounts flagged for reassignment (Notion, 2026-09-14) | $654,238.85 (14) | $2,508,550.00 (5) | $2,508,550.00 (5) | $424,952.00 | 5 / 0 | 2 |
| **Non-roster owners** | $1,070,044.25 (34) | $2,706,415.00 (7) | $2,706,415.00 (7) | $547,988.00 | 7 / 0 | 4 |
| **Company total** | $7,571,305.12 (73) | $69,616,046.13 (107) | $47,332,966.13 (95) | $11,304,048.49 | 107 / 0 | 8 |

## FY boundary handling (won pull over-fetched from 2025-12-31)

- Excluded 234106655428 "OneSource RE - Upsell": closedate 2025-12-31T05:00:00Z UTC = 2025-12-31 ET (FY2025)

## Data-quality flags

| Code | Severity | Detail |
|---|---|---|
| NON_ACTIVE_OWNER_WON_YTD | medium | Hayden Ashwill (inactive) holds closed-won YTD counted in company total but in no AE row · $113,672.60 |
| NON_ROSTER_OPEN_DEALS | medium | Reese Ryan holds 2 open deal(s) outside the forecast roster (active) · $197,865.00 |
| NON_ROSTER_OPEN_DEALS | high | Clay Stapleford holds 5 open deal(s) outside the forecast roster (no user seat) · $2,508,550.00 |
| NON_ACTIVE_OWNER_WON_YTD | medium | Clay Stapleford (no user seat) holds closed-won YTD counted in company total but in no AE row · $654,238.85 |
| WEIGHTED_STORED_DIVERGES | low | 45 open deal(s) carry a HubSpot weighted_amount that differs from amount × stage probability (weighted_amount is not used; reference only) · $25,830,349.18 (gross amount of flagged deals) |
| PAST_DUE | medium | 8 open deal(s) have a close date before today · $2,107,044.60 (gross amount of flagged deals) |
| PROB_DEVIATES | low | 1 open deal(s) carry a deal probability that differs from the stage default · $616,320.00 (gross amount of flagged deals) |

Stage map: 14 stages, won 3753890502, 3752297196, lost 3753890503, 3752297197 — matches gtm-dashboard config 2026-09-22.
