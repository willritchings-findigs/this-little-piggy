"""Phase 2e — design the TIER C sample (deep transcript coding by Claude Code subagents) + the calibration set.
Design (stratified, recorded weights):
  * ALL covered won deals (the control group is small; never sample it down)
  * Lost deals stratified by exit tier (TOFU/MOFU/BOFU) x segment group (SMB vs MM+Ent):
      TOFU (never left Intro): FIXED --tofu-n deals (default 30; rule 5) — the minimum for a reportable died-at-Intro vs advanced comparison
      MOFU/BOFU: --opp-lost-target deals (default 115), proportional, floor --min-per-tier per tier, MM+Ent floor --min-mm (oversample)
  * Per deal, the calls chosen by 05a_select_calls.py (rule 4: <= 3, one random per funnel section reached)
Sampling weight (per deal) = covered deals in stratum / sampled deals in stratum. 09_analyze multiplies it by the coverage IPW weight.
Calibration set: CAL_N calls (one per deal) drawn from the Tier C calls, stratified by outcome x stage.
Outputs: data/outputs/tierC_sample_deals.csv, tierC_calls.csv, calibration_calls.csv, sample_design.md (+ token estimate)
Usage: python src/05c_select_sample.py [--opp-lost-target 115] [--tofu-n 30] [--min-per-tier 30] [--min-mm 30] [--cal-n 30]
"""
import argparse, json
import pandas as pd, numpy as np
from config import OUT, COHORT, PREPARED, REPORTS, TOFU_TIER_C_N

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--opp-lost-target", type=int, default=115); ap.add_argument("--min-per-tier", type=int, default=30)
    ap.add_argument("--min-mm", type=int, default=30); ap.add_argument("--cal-n", type=int, default=30); ap.add_argument("--tofu-n", type=int, default=TOFU_TIER_C_N)
    a = ap.parse_args(); rng = np.random.default_rng(20261001)
    c = pd.read_csv(COHORT, dtype=str)
    m = pd.read_csv(OUT / "call_deal_map.csv", dtype={"deal_id": str, "call_id": str})
    m = m[m.is_meeting.astype(str).str.lower() == "true"]
    prep = {p.name.replace(".meta.json", "") for p in PREPARED.glob("*.meta.json") if not json.loads(p.read_text()).get("transcript_empty")}
    m = m[m.call_id.isin(prep)]
    cov = c[c.deal_id.isin(m.deal_id)].copy()
    cov["seg_grp"] = np.where(cov.segment == "SMB", "SMB", "MM+Ent")
    cov["stratum"] = cov.outcome + "|" + cov.funnel_tier_exit + "|" + cov.seg_grp
    won = cov[cov.outcome == "Won"]; lost = cov[cov.outcome == "Lost"]
    # Allocation for lost strata.
    # Rule 5: TOFU (never left Intro) gets a FIXED a.tofu_n deals, split across segment groups in proportion to covered TOFU losses.
    # MOFU/BOFU share the rest of the lost target proportionally, with floors per tier and a Mid-Market/Enterprise floor (opportunity strata only).
    tofu_idx = sorted(s for s in lost.stratum.unique() if "|TOFU|" in s); opp_idx = sorted(s for s in lost.stratum.unique() if "|TOFU|" not in s)
    alloc = pd.Series(0, index=tofu_idx + opp_idx, dtype=int)
    nt = lost[lost.stratum.isin(tofu_idx)].groupby("stratum").size()
    for s_ in tofu_idx: alloc[s_] = int(round(a.tofu_n * nt[s_] / nt.sum())) if nt.sum() else 0
    lo = lost[lost.stratum.isin(opp_idx)]; rest = a.opp_lost_target   # independent of TOFU, so the rule-5 cut is a real saving
    for s_ in opp_idx: alloc[s_] = max(1, int(round(rest * (lo.stratum == s_).sum() / max(1, len(lo)))))
    for tier in ["MOFU", "BOFU"]:
        idx = [s_ for s_ in opp_idx if f"|{tier}|" in s_]; short = a.min_per_tier - alloc[idx].sum()
        if short > 0 and idx:
            for s_ in idx: alloc[s_] += int(np.ceil(short * (lo.stratum == s_).sum() / max(1, lo.stratum.isin(idx).sum())))
    mm = [s_ for s_ in opp_idx if s_.endswith("MM+Ent")]; short = a.min_mm - alloc[mm].sum()
    if short > 0 and mm:
        for s_ in mm: alloc[s_] += int(np.ceil(short / len(mm)))
    picks = [won.assign(sampled_with_certainty=True)]
    for s, n in alloc.items():
        g = lost[lost.stratum == s]; picks.append(g.sample(min(n, len(g)), random_state=int(rng.integers(1e9))).assign(sampled_with_certainty=n >= len(g)))
    samp = pd.concat(picks)
    w = (cov.groupby("stratum").size() / samp.groupby("stratum").size()).rename("sampling_weight")
    samp = samp.merge(w, left_on="stratum", right_index=True)
    samp[["deal_id", "outcome", "funnel_tier_exit", "segment", "stratum", "sampling_weight", "sampled_with_certainty"]].to_csv(OUT / "tierC_sample_deals.csv", index=False)
    # Tier C calls = the rule-4 selected calls (<= MAX_CALLS_PER_DEAL, one per funnel section) of the sampled deals
    sel = pd.read_csv(OUT / "selected_calls.csv", dtype={"deal_id": str, "call_id": str})
    tc = sel[sel.deal_id.isin(samp.deal_id)].rename(columns={"in_scope_meetings_available": "meetings_available"})[["deal_id", "call_id", "funnel_section", "selection", "meetings_available"]]
    tc.to_csv(OUT / "tierC_calls.csv", index=False)
    # calibration: one call per deal, stratified by outcome x stage
    t = tc.merge(m[["call_id", "stage_at_call"]], on="call_id").merge(c[["deal_id", "outcome"]], on="deal_id")
    t = t.sample(frac=1, random_state=7).drop_duplicates("deal_id")          # one call per deal
    per = max(1, a.cal_n // max(1, t.groupby(["outcome", "stage_at_call"]).ngroups))
    cal = pd.concat([g.head(per) for _, g in t.groupby(["outcome", "stage_at_call"])])
    if len(cal) < a.cal_n: cal = pd.concat([cal, t[~t.call_id.isin(cal.call_id)].sample(min(a.cal_n - len(cal), len(t) - len(cal)), random_state=7)])
    cal.head(a.cal_n)[["call_id", "deal_id"]].to_csv(OUT / "calibration_calls.csv", index=False)
    chars = sum((PREPARED / f"{i}.txt").stat().st_size for i in tc.call_id)
    L = ["# Tier C sample design\n", f"Covered deals (≥1 prepared, non-empty meeting): {len(cov)} (won {len(won)}, lost {len(lost)})",
         f"Sampled deals: {len(samp)} (won {int((samp.outcome=='Won').sum())} = all covered wins; lost {int((samp.outcome=='Lost').sum())})",
         f"Tier C meetings to code: {len(tc)} (rule 4: ≤3 per deal, one per funnel section; {tc[tc.meetings_available > 3].deal_id.nunique()} sampled deals had more in-scope meetings than the cap)",
         f"Calibration calls: {min(a.cal_n, len(cal))}", f"Estimated transcript tokens for Tier C ≈ {chars/4:,.0f} (+ ~3–4k output tokens per call); calibration second pass adds ≈ {min(a.cal_n,len(cal))} calls\n",
         "## Strata\n", samp.groupby("stratum").agg(sampled=("deal_id", "size"), weight=("sampling_weight", "first")).join(cov.groupby("stratum").size().rename("covered")).to_markdown(floatfmt=".2f")]
    (REPORTS / "01b_sample_design.md").write_text("\n".join(L), encoding="utf-8")
    print("\n".join(L[1:6]))

if __name__ == "__main__":
    main()
