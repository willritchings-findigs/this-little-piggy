# Analysis plan: Gong transcript analysis of the New Logo closed-deal cohort

**Version:** 1.0 (2026-10-01). Pre-registered before any transcript is read.

**Change rule:** any change to a hypothesis, metric, or decision rule after Phase 2 must be logged in the change log at the bottom, with a date and reason. Anything added after seeing data is labeled **exploratory**.

## 1. Purpose

Use call transcripts to do four things for the findings in *Why and Where We Lose New Logo Deals*:

1. **Validate or contradict** the quantitative findings (F01–F15).
2. **Sharpen** problem statements and recommended actions (H01–H04).
3. **Surface new insights** that CRM fields cannot capture.
4. **Supply evidence** to polish the paper: rates, plus representative redacted quotes.

Transcripts are a second, independent source. They are not a replacement for the CRM analysis. Where the two disagree, the disagreement is itself a finding, and we explain which source is more credible and why.

## 2. Research questions

### RQ1. When and why do deals lose momentum or change direction?

**Measures**

- Call-level `momentum`.
- `next_step.status` on the last held meeting.
- First stalling call (`first_stall_seq`) and its stage.
- Deal synthesis `momentum_inflection` (type and call sequence).
- Gap in days between calls.
- `syn_primary_driver` by exit tier.

**Comparison:** lost deals versus won deals within the same frame. Example: of opportunities that reached Discovery, how often was the last held meeting left without a specific next step, in lost deals versus won deals?

**Output:** the inflection-type distribution by tier, the median stage and sequence at which momentum turns, and the share of losses whose last recorded call still looked healthy. That last group was lost off-recording, which is an important limitation to state.

### RQ2. Are we speaking to the right external contacts?

**Measures**

- First-meeting personas.
- `dm_present_by_first_meeting` and `dm_present_any`.
- `max_external_attendees` and multi-threading.
- `syn_stakeholder_pattern`.
- Decision authority, coded conservatively: a title alone never equals decision-maker.

**Comparisons**

- Won versus lost in `F_opportunity`.
- Mid-Market versus SMB (`F_mid_market_opp`) to test H04.
- First-meeting persona by deal source, to test F11 on data-provider deals.

### RQ3. Are we asking the wrong questions?

**Measures**

- Inventory of `findigs_questions`, split by category (situation, problem, implication, need-payoff, budget, authority, timeline, decision process, current vendor) and by form (open probing, open generic, closed qualifying, closed leading).
- `discovery_depth_score`.
- MEDDPICC element coverage.
- Answer depth that each question elicited.

**Comparison:** Discovery-stage meetings of deals that advanced versus deals that died at Discovery. The question is which question types and coverage patterns separate them.

**Guardrail:** this is observational. A difference shows association, not that the question causes the outcome. Report it as "deals that advanced were more likely to include…".

### RQ4. How do prospects receive our discovery and sales process?

**Measures**

- `reception.reception_of_discovery`.
- `reception.reception_of_demo`.
- `overall_sentiment`.
- Friction signals: send-me-info, circle back, defer to someone else, confused by process, premature pricing, demo not relevant, too many meetings, felt sold to.

**Output:** friction-signal prevalence (deals affected) by stage and outcome, and representative quotes.

### RQ5. What do prospects ask, and how well do we answer?

**Measures**

- Inventory of `prospect_questions` by category.
- `answer_quality` distribution.
- Follow-up promised versus resolved in a later call (from deal synthesis `unanswered_or_poorly_answered_prospect_questions`).

**Output:** the top 10 question categories, answer-quality mix per category, and the categories with the highest deflected or inaccurate share. These feed an FAQ / enablement backlog for Sales Enablement.

### RQ6. Are there deal breakers we must accept?

**Measures**

- `deal_breaker_signals.classification`. "Structural, must accept" versus fixable (product, terms or packaging, price, process).
- Objections with severity `hard_blocker`.
- H03: early termination fee / commitment terms and the lack of a pilot instrument, both from the September 2026 contract stack diagnostic.
- PMS-bundled screening and PMS integration gaps.

**Output:** for each blocker, how many deals (lost and won) it appears in, whether wins overcame it, and the recommended stance:

- **Qualify out early.** Structural blockers we cannot change.
- **Fix.** Product, terms, or process blockers.
- **Pricing or packaging decision for leadership.**

### RQ7. Is the CRM loss reason true?

**Measures:** CRM `reason_lost` compared with the blind transcript `syn_primary_driver`, scored using `schema/crm_reason_to_driver_map.json` (agrees / partially / contradicts / insufficient evidence). Focus areas:

- "Other" (17% of losses).
- "Bad Timing" (F09 recoding hypothesis).
- "Unresponsive" (F05, F06).

### RQ8. Competition

**Measures:** competitor and incumbent names, context (incumbent, bundled with PMS, evaluating), and prospect sentiment toward them. Compare against `who_we_lost_to__c` and the 38 deals coded Competitor (F14).

## 3. Pre-registered hypotheses and decision rules

| ID | Hypothesis | Primary test (frame) | Supports paper item |
|---|---|---|---|
| T1 | Deals lost at TOFU usually have no held first meeting, or one with no prospect-articulated pain | Share of TOFU-lost covered deals with no held meeting or `pain_prospect_articulated = false`, compared with won deals' first meeting | F05, F06, H01, Priority 1 |
| T2 | Price is discussed before pain is established more often in lost opportunities | `price_before_pain`, `price_on_first_meeting` (F_opportunity) | F08, Priority 2 |
| T3 | "Bad Timing" losses often contain price objections or no compelling event | Among Bad Timing losses: price objection present; `compelling_event_any = false` | F09, H02 |
| T4 | Lost opportunities less often establish a compelling event and less often get deep discovery | `compelling_event_any`, `deep_discovery_any`, MEDDPICC coverage (F_opportunity) | F07, H02 |
| T5 | Mid-Market losses lack decision-maker / economic-buyer engagement | `dm_present_any`, `economic_buyer_covered`, stakeholder pattern (F_mid_market_opp compared with SMB opportunities) | F10, H04, Priority 3 |
| T6 | Late-stage losses are driven by contract / commitment terms (ETF) or an unmet pilot request | `etf_commitment_objection`, `pilot_request` (F_negotiation) | F02, H03 |
| T7 | PMS-bundled screening is a larger competitive force than CRM reason codes show | `pms_bundled_screening`, competitor names compared with the CRM | F14 |
| T8 | Q3 2026 calls differ from earlier calls (process, pain, price, next steps) | `q3_vs_prior` tab | F04 |
| T9 | Deals left without a specific next step die, and dead deals have long silent gaps | `last_next_step_specific`, inter-call gaps | F13, RQ1 |

### Decision rules applied in `09_analyze.py`

- **Discriminating finding.** Requires all of the following:
  - BH-FDR q < 0.10 within the comparison table.
  - n ≥ 10 in both won and lost groups.
  - Reliability gate is not "excluded".
  - It is **reportable** only if n ≥ 30 in both groups and the gate is "reportable". Otherwise it is directional.
- **Common to won and lost.** No significant difference. The behavior is real but does not explain losses. This is a legitimate and often important result. Example: "we pitch price early in wins too".
- **Anecdotal.** n < 10 in either group. Quotes may illustrate a point, but no rate may be published.
- **Concentrated.** More than 40% of the lost deals showing a feature belong to one deal owner. Report the finding as possibly rep-specific, not systemic.
- **Exploratory findings** (not in T1–T9) are promoted to the paper only if they meet the discriminating rule **and** hold in both halves of the window (Oct–Mar and Apr–Sep), or across at least two owners. Otherwise they go to "Worth digging into".

## 4. Bias and sample-size guardrails

These are mandatory. Each one names the risk it controls.

1. **Coverage first.** Nothing is analyzed until `reports/01_coverage_report.md` is reviewed. Gong will not cover all 845 deals. TOFU no-shows often have no call, some reps record less, and pre-Gong history is absent.
2. **Missing is not random.** Coverage is expected to differ by stage, rep, period, and outcome. Test every dimension with chi-square. Where coverage is biased, stratify or apply IPW weights. Always show weighted and unweighted results side by side.
3. **Never extrapolate to unrepresented strata.** A stratum with zero covered deals is described as "not observable from transcripts". It is never filled in from neighboring strata.
4. **Absence of a recording is data, but only about the recording.** For TOFU-lost deals, "no held meeting found" supports F05/F06 only as a lower bound, because the meeting may have happened unrecorded. Never infer *why* from a missing call.
5. **Denominators are covered deals in the stated frame.** Write "among 212 lost opportunities with recorded meetings", never "X% of our losses", unless the figure is IPW-weighted and labeled as such.
6. **One deal, one vote.** Deal-level metrics aggregate calls to the deal first, so a deal with 9 calls doesn't outweigh one with 1. Call-level metrics (for example, question inventories) are labeled call-level.
7. **Always show the won-deal control.** No loss pattern is reported without its prevalence in won deals of the same frame. Won coverage will be small (at most 74, probably 30–50), so the won CI is wide. Say so.
8. **Compare like with like.** Won-vs-lost comparisons happen inside funnel frames (F_opportunity, F_negotiation) so that TOFU losses don't make lost deals look "less discovered" merely because they had fewer meetings.
9. **Blind coding.** Call coding and deal synthesis never see the outcome, CRM reason, loss notes, close date, or highest stage reached. CRM comparison happens afterward, in code.
10. **Reliability gating, before production coding.** A fixed, stratified 60-call calibration set is coded independently by the primary model and a second model, and Will hand-reviews 20 of those calls.
    - Fields with κ < 0.40 are excluded.
    - Fields with κ 0.40–0.59 are directional only.
    - If a field fails, fix the prompt, bump `prompt_version`, and re-run calibration only. The full corpus is coded once, after the gate is accepted.
11. **Multiple comparisons.** BH-FDR is applied across every feature in a table. Report q, not just p.
12. **Concentration check.** Watch for single-owner (> 40%) or single-deal dominance of a theme.
13. **Quote selection rule.** Quotes illustrate the modal pattern of a reportable finding.
    - Choose from deals in that pattern's category, across at least 3 different deals and at least 2 owners where possible.
    - Include one counter-example quote when a meaningful minority disagrees.
    - Never use a single vivid quote as evidence of prevalence.
    - Quotes are at most 25 words, redacted, and attributed only by role token and stage.
14. **Time confounding.** Gong adoption, reps, and the migration all changed over the window. Test Q3 2026 against prior quarters (T8), and check whether a finding holds in both halves before calling it systemic.
15. **Off-recording losses.** If the last recorded call looked healthy, the loss driver is "insufficient_evidence". Never guess it.
16. **Triangulate.** Each register verdict cites the CRM metric and the transcript metric. Contradictions are explained, never smoothed over.

## 5. Outputs

| File | Content |
|---|---|
| `reports/01_coverage_report.md` | Coverage, bias tests, and IPW strata (checkpoint) |
| `reports/02_reliability.md` | κ by field on the calibration set, the gate per field, and human agreement (Checkpoint 2) |
| `reports/03_transcript_analysis.xlsx` | All comparison tables |
| `reports/04_findings_register.csv` | F01–F15 and H01–H04 with verdict (Reinforces / Contradicts / Supplements / Not testable), evidence references, and confidence |
| `reports/05_transcript_findings.md` | Narrative findings by RQ, new insights, and quote bank excerpts, with a Sources & Methodology section |
| `reports/06_paper_revision_plan.md` | Section-by-section edits to the paper: what changes, why, and which evidence supports it |
| Revised paper (`.docx`) | Rebuilt from `docs/reference/paper_source/` after Will approves the revision plan |

## 6. Change log

| Date | Change | Reason |
|---|---|---|
| 2026-10-01 | v1.0 created | — |
| 2026-10-01 | v1.1: reliability moved from after the full run to a pre-production calibration gate (Phase 3); RQ3, T3, T9, RQ7 agreement scoring and split-half replication implemented in `09_analyze.py` | Avoid a full recode if a field fails; avoid ad hoc analysis code |
