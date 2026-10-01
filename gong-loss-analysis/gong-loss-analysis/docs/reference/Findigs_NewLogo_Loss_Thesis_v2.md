# Why Findigs Loses New Logo Deals — Thesis (v2)

**Scope:** 845 closed New Logo deals (74 won, 771 lost), close date 2025-10-01 → 2026-09-30. Open deals are excluded.
**Workbook:** `Findigs_NewLogo_Loss_Analysis_v2.xlsx`. Tab references are in brackets.
**Version:** 2, 2026-10-01. Supersedes v1 (2026-09-30).

**What changed from v1**

- SDR ownership now uses the approved coalesce rule:
  - Deals created before 2026-07-14 → `sdr_owner_new`.
  - All other deals → `sdr_owner`.
- **v1's SDR finding and its #1 recommendation are retracted.** The 3.9% vs 41% gap was produced by reading `sdr_owner` on migrated records. On Salesforce-migrated deals, that field agrees with the source of truth only 9.9% of the time.
- New sections:
  - Leaky-bucket view
  - Top loss reasons by funnel tier
  - Loss-reason trends: monthly area chart, trailing 3-month share, first vs last 6 months

---

## Bottom line

Findigs wins 8.8% of closed New Logo deals (95% CI 7.0–10.9%) [Summary_KPIs]. Deals that reach Negotiation win 49% of the time. The bucket leaks before that:

| Where deals go | Share of all closed records |
|---|---|
| Lost from Intro & Challenge | 39.9% |
| Lost from Discovery / Demo | 30.3% |
| Lost from Business Case or later | 21.1% |
| Won | 8.8% |

[Funnel]

Three things concentrate the losses:

- **Mid-Market.** 2 wins in 134 deals.
- **Q3 2026.** Win rate fell to 2.6%.
- **Prospect disengagement, which is growing.** Ghosting and no-shows went from 28% to 43% of losses between the first and last six months.

Price objections are shrinking as a share of losses. SDR identity is not a significant driver once ownership is read correctly.

---

## Leaky bucket — where deals exit

Each row is the share of all 845 closed records that went to Closed Lost from that stage [Funnel, leaky-bucket chart].

| Exit stage → Closed Lost | Count | % of closed records | Cumulative % lost |
|---|---|---|---|
| Intro & Challenge | 337 | 39.9% | 39.9% |
| Discovery / Demo | 256 | 30.3% | 70.2% |
| Business Case & Stakeholder Alignment | 103 | 12.2% | 82.4% |
| Negotiation & Execution | 71 | 8.4% | 90.8% |
| Trial | 4 | 0.5% | 91.2% |
| *Closed Won (reference)* | *74* | *8.8%* | — |

70% of all closed records are lost before a business case is built.

## Top closed-lost reasons by funnel tier

Ranked by formula on [TOFU_MOFU_BOFU] using raw `reason_lost__c` values. Percentages are of the tier's losses and of all 771 losses.

| Rank | **TOFU** (Intro, n=337) | **MOFU** (Discovery + Business Case, n=359) | **BOFU** (Negotiation + Trial, n=75) |
|---|---|---|---|
| 1 | Unresponsive — 124 (36.8% · 16.1% of all) | Bad Timing — 95 (26.5% · 12.3%) | Price Conscious — 18 (24.0% · 2.3%) |
| 2 | Other — 70 (20.8% · 9.1%) | Unresponsive — 83 (23.1% · 10.8%) | Unresponsive — 17 (22.7% · 2.2%) |
| 3 | Demo didn't happen — 48 (14.2% · 6.2%) | Price Conscious — 71 (19.8% · 9.2%) | Other — 12 (16.0% · 1.6%) |
| 4 | Bad Timing — 37 (11.0% · 4.8%) | Other — 51 (14.2% · 6.6%) | Bad Timing — 10 (13.3% · 1.3%) |
| 5 | Price Conscious — 13 (3.9% · 1.7%) | Competitor — 25 (7.0% · 3.2%) | Product Gaps — 9 (12.0% · 1.2%) |

---

## Key findings

### TOFU — booking and show rate

1. **The Intro stage leaks the most.** 39.9% of all closed records are lost there. 72% of TOFU losses are Unresponsive, Other, or Demo didn't happen [Funnel, TOFU_MOFU_BOFU]. *Fact.*

2. **Disengagement is rising.** Unresponsive, Demo didn't happen, and DQ'd account together went from 28.0% of losses (90/322) in Oct–Mar to 42.8% (192/449) in Apr–Sep [Loss_Reason_Trends].
   - The two new picklist values only exist from July 2026, so part of their rise is recoding from Unresponsive and Other.
   - The combined family still grows, and Unresponsive alone rose 49% in count.
   - Notes on 74 lost deals say the demo never happened under other reason codes [Data_Quality].
   - *Fact (shift); inference: show-rate and engagement quality are deteriorating, not just being relabeled.*

3. **SDR identity is not a significant driver once ownership is read correctly.**
   - Win rate across the 8 SDRs with n ≥ 30: p = 0.87.
   - SMB-only win rate across SDRs: 6.7%–16.2%, with no significant difference.
   - Discovery reach varies from 49% to 73% (p = 0.045). That is directional given multiple comparisons; Olivija Stephens (49.4%) and Charlie ODonoghue (52.7%) sit at the low end [Rep, Stats].
   - Emma Ferer and Liam Sirgo own only post-migration deals (49 closed, 1 won, all closed in Q3). That is too few to judge, and it overlaps the Q3 decline.
   - *Fact.*

4. **Data-provider-sourced deals won 0 of 53** (DA - Data provider), vs OB - SDR 8.1% (n=457) and IB - Organic Search 14.3% (n=49) [Loss_Reasons]. *Fact.*

### MOFU — Discovery and business case

5. **Discovery is the second-largest exit (30.3% of closed records).** The top MOFU reasons are Bad Timing, Unresponsive, and Price Conscious [TOFU_MOFU_BOFU]. *Fact.*

6. **Price surfaces early, but its share is falling.**
   - 71 of 102 Price losses are at MOFU.
   - Price's share of all losses halved: 18.6% in the first six months, 9.4% in the last six. Its trailing 3-month share fell from 19% to 6% [Loss_Reason_Trends].
   - *Fact; cause unknown.* Possible explanations are a pricing or packaging change, or price objections now being coded as Bad Timing. Bad Timing's 3-month share rose from 15% to 24% over Jun–Sep.

7. **Mid-Market barely converts.**
   - 2 wins in 134 deals (1.5%, CI 0.4–5.3%) vs SMB 10.1%; p = 0.001.
   - Mid-Market reaches Discovery at the same rate as SMB (59.7% vs 60.4%) but reaches Negotiation at 7.5% vs 19.4% [Segment, Stats].
   - It carries 55% of counted lost dollars.
   - Enterprise (n=12) is directional only.
   - *Fact.*

### BOFU — Negotiation and Trial

8. **BOFU is not the problem.** 75 losses, and 49.3% of deals that reach Negotiation win. Price is the top BOFU reason (24%) [Funnel, TOFU_MOFU_BOFU]. *Fact.*

### Cross-cutting

9. **Q3 2026 win rate collapsed.**
   - 5 wins from 194 closes (2.6%) vs 10.6% prior. Opportunity win rate fell from 17.0% to 4.9%. Both p ≤ 0.002 [Stats].
   - Deals created after the migration have produced 1 win in 86 closes.
   - Censoring from excluding open deals can't explain the size of the drop: only 9 open deals sit at Negotiation or Trial.
   - *Fact; cause unknown.*

10. **Deal-owner Discovery conversion differs; deal-owner win rate does not.**
    - Win rate by owner: p = 0.69.
    - Discovery reach by owner: p = 0.009. Ian McLaughlin is at 49.5% vs 63.3% for everyone else.
    - Reese Ryan's opportunity win rate is 20.8% vs 12.9% (p = 0.04, directional) [Stats].

11. **Dead deals linger.** Lost deals sit 27–53 days median in their final stage. Advancing deals move in 2–8 days, which suggests stages are often updated in batches [Funnel]. *Inference.*

---

## Loss-reason trends (first 6 months vs last 6 months)

Total losses rose 39% (322 → 449), so the share column is the cleaner signal [Loss_Reason_Trends].

| Reason | Oct–Mar | Apr–Sep | Count Δ | Share Δ (pts) |
|---|---|---|---|---|
| Unresponsive | 90 | 134 | +49% | +1.9 |
| Bad Timing | 58 | 84 | +45% | +0.7 |
| Other | 63 | 70 | +11% | −4.0 |
| Price Conscious | 60 | 42 | −30% | −9.3 |
| Demo didn't happen | 0 | 48 | new (Jul) | +10.7 |
| Product Gaps | 16 | 25 | +56% | +0.6 |
| Competitor | 17 | 21 | +24% | −0.6 |
| PMS Integration | 8 | 9 | +13% | −0.5 |
| Too Small | 10 | 6 | −40% | −1.8 |
| DQ'd account | 0 | 10 | new (Jul) | +2.2 |

The workbook also shows a stacked monthly area chart of counts, the trailing 3-month share as a line chart, and a reasons × months heatmap.

## What the missing data tells us

- **SDR ownership was split across two fields.** They agree on only 10% of pre-migration records [Data_Quality]. Any SDR report built on `sdr_owner` alone is wrong for 90% of the history.
- **Competitive losses are under-recorded.** 139 lost deals name a competitor, but only 38 are coded Competitor. AppFolio (51) and Yardi (32) are PMS platforms with bundled screening.
- **Dollars carry little signal.** 79% of post-Intro deals still carry the auto-calculated amount.
- **The reason picklist changed mid-window.** Demo didn't happen and DQ'd account were added in July. 74 notes describe no-shows under other codes.
- **Stage history is 88% Salesforce-backfilled.** 107 deals skipped a stage, and 17 have stage dates out of order.

## Field and definition decisions that affect the findings

| Decision | Effect under the alternative |
|---|---|
| SDR owner (correct) coalesce vs `sdr_owner` alone | The `sdr_owner` reading shows a fabricated 3.9% vs 41% SDR gap (p < 0.001). Corrected: no significant difference (p = 0.87). |
| `units__c` segment bands vs `segment` field | Mid-Market win rate would be 4.9% instead of 1.5% |
| Highest-stage-reached rule | 28 wins and 56 losses would otherwise be mis-staged |
| Intro-only $ excluded | $ win rate is 13.8%; it would be ~7.6% with Intro amounts included |
| Raw reason values in trend charts | Bucketed view (Unresponsive split pre/post Discovery) is on [Loss_Reasons] |

## Recommendations

| # | Action | Finding | Owner | Expected impact |
|---|---|---|---|---|
| 1 | Show-rate program: confirmation cadence, 24-hour reminders, same-week reschedule SLA. Track show rate as an SDR KPI. | 1, 2 | SDR lead / Marketing Ops | Targets the fastest-growing loss family (28% → 43% of losses) |
| 2 | Decide the Mid-Market motion: dedicated coverage and a longer cycle, a different offer, or deprioritize. | 7 | CRO / Sales / Product | 132 low-yield losses; 55% of counted lost $ |
| 3 | Diagnose Q3 before FY27 quotas lock. Review post-migration deal creation, cutover process changes, and lost-opportunity notes. | 9 | RevOps / CRO | Planning risk: 1 win from 86 post-migration deals |
| 4 | Introduce price at Business Case with an ROI frame. Also check whether price objections are being recoded as Bad Timing. | 6 | Sales / Enablement | 71 MOFU price losses; validates the falling price share |
| 5 | Pause or ICP-filter DA - Data provider outreach. | 4 | SDR lead / RevOps | 0/53 wins |
| 6 | Discovery-conversion coaching for owners below 55% Discovery reach (Ian McLaughlin). Review SDR booking criteria with Olivija Stephens and Charlie ODonoghue. | 3, 10 | Sales manager / SDR lead | Directional gains at the largest leak points |
| 7 | **CRM: SDR field consolidation.** Backfill `sdr_owner` from `sdr_owner_new` on pre-migration records (after review), then deprecate `sdr_owner_new`. Until then, every SDR report must use the coalesce rule. Update the hubspot-hygiene-agent's Demo Completed / SDR commission check and the GTM dashboard's SDR section if they read `sdr_owner` on migrated deals. | 3, missing data | RevOps | Removes a 90%-wrong attribution risk |
| 8 | **CRM: loss reasons.** Require `close_lost_notes`. Require a Competitor / incumbent field when the reason is Competitor, Price, or Product Gaps. Add "No problem to solve" and "Wrong decision-maker" values. | 2, missing data | RevOps | Clean reason trends |
| 9 | **CRM: deprecate dead fields.** `closed_lost_reason`, `stage_lost__c`, `closed_date__c`, `reason_lost_notes__c`, `hs_acv`, `hs_arr`, `hs_tcv`, `acv`. | Field register | RevOps | Removes split-field risk |
| 10 | **CRM: hygiene.** Updated amount required at Business Case. 30-day no-activity close-out rule at MOFU. | 11 | RevOps / Sales | Meaningful $; truer pipeline |
| 11 | **Notion:** add Win rate, Loss reason, Funnel tier, and the SDR owner (correct) rule to Data Definitions. Correct the HubSpot Schema page. | Phase 1 | RevOps | Definitions match the workbook |

## Worth digging into

- **Q3 cause.** Candidates: cutover disruption, hygiene close-outs, fewer qualified meetings, a pricing change, or the new SDR cohort. Data needed: post-migration deal-creation process and July 13–17 stage history.
- **Price share halving.** Was there a real pricing or packaging change, or are reps coding price as Bad Timing? Data needed: pricing change log and a notes review of Bad Timing losses after June.
- **Which downstream tools read `sdr_owner`.** The GTM dashboard SDR section and the hygiene agent's commission reconciliation may carry the same attribution error.
- **PMS-bundled screening as the real competitor.** Needs reliable competitor capture.
- **Mid-Market's two wins.** What was different about them?
- **Reese Ryan's opportunity win rate** (p = 0.04). Confirm with another quarter.

<details>
<summary><strong>Sources & methodology</strong></summary>

- **Data:** HubSpot portal 243635806, DEAL object.
  - Saved-view CSV export pulled 2026-09-30: 845 rows, matching reporting API counts (74/771).
  - `sdr_owner_new` was added 2026-10-01 from the HubSpot reporting API (845/845 matched by Record ID). Owner IDs were resolved to names via the owners lookup.
- **SDR rule:** `createdate` < Parameters migration date (2026-07-14) → `sdr_owner_new`; otherwise → `sdr_owner`. This assigns 759 records to `sdr_owner_new` and 86 to `sdr_owner`.
  - 11 pre-migration records are not Salesforce-sourced: 9 Integration records with 2024–25 create dates, and 2 CRM UI records created 2026-07-13. They follow the create-date rule as specified. They are flagged on [Data_Quality].
- **Definitions:** Notion Data Definitions (2026-09-22) and HubSpot Schema (2026-09-14), with decisions approved 2026-09-30 and 2026-10-01 [Definitions, Field_Decision_Register].
- **Cleaning:** Formula-driven [Clean_Deals]. Blanks are labeled Unknown/Blank and counted. Nothing imputed. 0 duplicate IDs.
- **Statistics:** Wilson 95% intervals; pooled two-proportion z-tests; chi-square across owners and SDRs with n ≥ 30 [Stats]. Single tests near p = 0.05 are treated as directional.
- **Trends:**
  - Monthly counts use close month.
  - The trailing 3-month share is Σ reason count over months m−2..m divided by Σ all losses over the same months.
  - First 6 months = Oct 2025–Mar 2026; last 6 months = Apr–Sep 2026.
- **Charts:** Count charts show count and % of total in their category labels.
  - Multi-series charts (stacked area by reason, stacked exit-point bars) pair with % tables or companion % charts rather than per-point % labels.
- **Limitations:**
  - Open deals are excluded.
  - Salesforce-backfilled stage history.
  - Picklist values were added in July 2026.
  - Weak competitor capture after cutover.
  - Amount is largely auto-calculated.
  - Enterprise n = 12.

</details>
