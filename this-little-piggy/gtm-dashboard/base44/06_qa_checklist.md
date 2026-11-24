# QA checklist — acceptance for the Base44 dashboard

Run after Stage 5 and after any later change. Mirrors `gtm-dashboard/qa.py` plus a tile-for-tile comparison with the HTML build for the same as-of date. A check that fails blocks sharing the page with #gtm_leadership.

## A. Refresh function

- [ ] Manual run as a `revops_admin` user creates a `GtmSnapshot` with `status = reconciled`, `is_current = true`, and the previous current snapshot flips to `superseded`.
- [ ] Count controls: every entry in `count_controls` has `ok = true`. Expect 1 open, 1 won, 1 created, 3 record-source, ~22 drill-down (+1 blank), 1 SDR, 4 channel (+1 blank), 4 window controls.
- [ ] Record counts equal totals: `counts.open_n`, `won_n`, `created_n` equal the search `total` values recorded in the run.
- [ ] `GtmDeal` rows for the snapshot = `open_n + won_n` tier rows + `created_n` pg rows.
- [ ] Owner resolution: no `owner_name` starting "Unresolved owner" unless DQ-12 reports the same IDs.
- [ ] Swan: `counts.swan_scored_n` is within ±3 of the Routine's Swan count for the same Monday (association timing can differ by a deal or two; a larger gap means the primary-company selection is wrong).
- [ ] With a control document for the same as_of: `dollar_tieout = passed` and every `dollar_controls` entry `ok = true`.
- [ ] Failure path: run with `as_of` set to a date before the FY start (forces a won-row validation failure) → `status = failed`, `error` populated, no `GtmDeal` rows for that snapshot, previous snapshot still `is_current`, page still renders the previous data with the "did not reconcile" chip.
- [ ] Non-admin invoking the function gets 403.
- [ ] HubSpot audit: the connector's scopes are read-only; the function source contains no `POST /crm/v3/objects/*` other than `/search` and `/batch/read`.

## B. Page renders without errors

- [ ] No console errors on load, after each filter change, after opening every KPI tile, after toggling Native only, after changing Compare vs.
- [ ] Fonts: Findigs Sans renders (no Arial fallback) on desktop Chrome and Safari.
- [ ] Hub shell intact: nav and user menu unaffected by the dashboard's scoped tokens.

## C. Headline tiles equal the snapshot (unfiltered)

Compare the rendered value to `GtmSnapshot.headline` for the current snapshot:

- [ ] Bookings QTD = tier1.qtd · Bookings YTD = tier1.ytd · ASP = tier1.asp · cycle = round(tier1.cycle) days · NL = tier1.nl · UE = tier1.ue
- [ ] Gross = tier1.gross · Weighted = tier1.wtd · Quarter forecast = tier1.fq · Year forecast = tier1.fy
- [ ] Pipeline created QTD/YTD = pg.cqtd / pg.cytd; Deals created QTD/YTD = pg.nqtd / pg.nytd
- [ ] SDR tiles = sdr.booked30 / sdr.held30 / sdr.heldopp30 (as %) / sdr.opp30
- [ ] Scope pill = open_n + won_n.
- [ ] Sub-lines: weighted tile shows stored count + fallback count summing to open_n; cycle tile shows n and post-cutoff n.

## D. Cross-check with the HTML build (same as_of)

Open `output/findigs_gtm_executive_dashboard_{as_of}.html` and `output/tieout.md` for the Routine's run on the same Monday. With no filters:

- [ ] All 14 headline tiles match to the cent / to the deal.
- [ ] Tier 3 table row count = open_n + won_n; sorting by Amount desc gives the same first 10 deals.
- [ ] Stage funnel counts per stage match.
- [ ] By-segment bars: Bookings YTD, gross, weighted per segment match.
- [ ] Pipeline created by week: the same bar heights for the last 8 weeks (hover values).
- [ ] Source bars: same 22 values, same ordering, same top-3 amounts.
- [ ] Heatmap: same row/column totals; "excluded (no close date)" count matches.
- [ ] Swan coverage sentence matches (e.g. "221 of 762 deals (29.0%)").
- [ ] SDR channel mix counts (Outbound/Inbound/Events/Unassigned) match the tieout.md channel controls after folding Referral into Inbound.
- [ ] DQ accordion: same IDs, same severities, same High count (currently 3).

## E. Filters and interactions

- [ ] Deselecting one owner lowers gross pipeline and scope count; the owner disappears from the by-owner chart; Pipeline Generation and SDR tiles change too (filters are global).
- [ ] Owner list includes owners who only appear in Pipeline Generation (not just Tier 1–3).
- [ ] Reset filters restores every tile to the snapshot headline exactly; Compare vs selection is preserved.
- [ ] Native only: Pipeline created YTD drops by the migrated amount shown in PG-1 (natAmt); unchecking restores it.
- [ ] Amount / Units / Close date ranges apply; close-date range filters on close date in the Pipeline Generation section too (not create date).
- [ ] Every KPI tile (14) opens the drawer; the gross tile's drawer row count = open_n; forecast drawers contain won + open rows; Escape and scrim click close it.
- [ ] Deal names link to `app.hubspot.com/contacts/243635806/record/0-3/{id}` in a new tab.
- [ ] Table sorting works on every column; numeric columns sort numerically.

## F. Compare vs

- [ ] With only one `GtmKpiHistory` row, the Compare vs control is hidden and no badges render.
- [ ] With n rows, the dropdown has n−1 options, most recent prior first with "(most recent)".
- [ ] Badge value for gross = (current − prior) ÷ |prior|, one decimal, correct sign and color; tooltip shows the prior date and value.
- [ ] Changing the dropdown changes every badge; changing page filters changes no badge.
- [ ] A history row lacking `sdr` renders blank SDR badges, not NaN.

## G. States and responsiveness

- [ ] Loading skeleton appears before data; no layout jump when data lands.
- [ ] Snapshot older than 8 days shows the stale chip (temporarily edit `as_of` on a test snapshot to verify).
- [ ] At 1024px wide every grid is one column; at 390px tiles stack and the filter bar collapses behind a Filters button; the drawer is full width.
- [ ] Keyboard: tab reaches every tile, chip, and the Reset button; focus ring visible; Escape closes popovers and the drawer.
- [ ] `prefers-reduced-motion`: drawer appears without sliding.

## H. Access

- [ ] A Hub user outside the allowed group cannot open the page or read `GtmDeal` / `GtmSnapshot` through the SDK.
- [ ] A Hub user in the group sees the page but no Refresh button; `revops_admin` sees Refresh and the run history.

## I. Performance

- [ ] Page interactive within 2 s on a normal laptop with ~950 deal rows loaded; filter changes re-render within 150 ms.
- [ ] Deal rows load with one query per population (`snapshot_id` + `population`), not per deal.
