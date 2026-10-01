"""Phase 4: aggregate codings to ONE ROW PER DEAL, then test features won-vs-lost inside comparable funnel frames,
with Wilson CIs, sample-size flags, BH-FDR q-values, IPW-weighted prevalence, reliability gating and concentration checks.
Outputs: reports/03_transcript_analysis.xlsx, data/outputs/deal_features.csv, data/outputs/quote_bank.csv, reports/04_findings_register_template.csv
"""
import json, glob
from pathlib import Path
import pandas as pd, numpy as np
from config import CODED, OUT, REPORTS, COHORT, FINDINGS, N_REPORTABLE, N_DIRECTIONAL
from stats_utils import wilson, flag, compare_props, bh_qvalues

PAIN_ORD = {"not_discussed": 0, "implied": 1, "explicit_unquantified": 2, "explicit_quantified": 3}
DM = ("economic_buyer", "decision_maker")
# feature -> reliability fields it depends on (gating)
DEPENDS = {"dm_present_any": ["any_decision_maker_present"], "dm_present_by_first_meeting": ["any_decision_maker_present"],
           "pain_explicit_any": ["pain.status"], "pain_prospect_articulated": ["pain.who_articulated"], "pain_quantified_any": ["pain.status"],
           "compelling_event_any": ["compelling_event.status"], "compelling_event_dated": ["compelling_event.status"],
           "price_on_first_meeting": [], "price_before_pain": ["price.pain_established_before_price"], "price_raised_by_findigs_first": ["price.first_raised_by"],
           "price_strong_objection": ["price.reaction"], "deep_discovery_any": ["discovery_depth_band"], "economic_buyer_covered": ["meddpicc.economic_buyer"],
           "decision_process_covered": ["meddpicc.decision_process"], "metrics_covered": ["meddpicc.metrics"],
           "last_next_step_specific": ["next_step.status"], "stalling_or_reversing_any": ["momentum"], "negative_or_skeptical_any": ["reception.overall_sentiment"],
           "competitor_mentioned": ["competitors"], "pms_bundled_screening": ["competitors", "objection_categories"], "hard_blocker_any": ["objection_categories"],
           "etf_commitment_objection": ["objection_categories"], "pilot_request": ["objection_categories"], "pms_integration_objection": ["objection_categories"],
           "unanswered_prospect_question_any": ["prospect_question_categories"], "friction_send_info_or_circle_back": [], "multi_external_attendee_meeting": [],
           "long_gap_21d": [], "price_discussed_any": []}
DISC_FEATS = {"disc_implication_q": [], "disc_need_payoff_q": [], "disc_decision_process_q": [], "disc_current_vendor_q": [], "disc_open_probing_30pct": [],
              "disc_depth_4plus": ["discovery_depth_band"], "disc_price_before_pain": ["price.pain_established_before_price"],
              "disc_prospect_pain_articulated": ["pain.who_articulated"], "disc_specific_next_step": ["next_step.status"]}
DEPENDS.update(DISC_FEATS)

def load_codes():
    calls = {}
    for f in glob.glob(str(CODED / "calls" / "*.json")):
        r = json.loads(open(f, encoding="utf-8").read())
        if "_skipped" not in r["coding"]: calls[r["call_id"]] = r
    deals = {}
    for f in glob.glob(str(CODED / "deals" / "*.json")):
        r = json.loads(open(f, encoding="utf-8").read()); deals[r["deal_id"]] = r["synthesis"]
    return calls, deals

def deal_features(m, calls, deals):
    rows, quotes = [], []
    for d, g in m.groupby("deal_id"):
        g = g.sort_values("started"); cs = [(r, calls[r.call_id]["coding"]) for _, r in g.iterrows() if r.call_id in calls]
        if not cs: continue
        held = [(r, c) for r, c in cs if c["meeting_occurred"] == "yes"]
        f = {"deal_id": d, "n_calls_coded": len(cs), "n_meetings_held": len(held),
             "no_show_calls": sum(c["meeting_occurred"] == "no_show_or_empty_room" for _, c in cs)}
        f["any_meeting_held"] = len(held) > 0
        if held:
            r0, c0 = held[0]
            f["first_meeting_stage"] = r0.stage_at_call
            f["first_meeting_personas"] = ";".join(sorted({a["persona"] for a in c0["external_attendees"]}))
            f["dm_present_by_first_meeting"] = any(a["decision_authority"] in DM for a in c0["external_attendees"])
            f["price_on_first_meeting"] = bool(c0["price"]["discussed"])
            f["max_external_attendees"] = max(len(c["external_attendees"]) for _, c in held)
            f["multi_external_attendee_meeting"] = f["max_external_attendees"] >= 2
            f["dm_present_any"] = any(a["decision_authority"] in DM for _, c in held for a in c["external_attendees"])
            best_pain = max(PAIN_ORD[c["pain"]["status"]] for _, c in held)
            f["pain_explicit_any"] = best_pain >= 2; f["pain_quantified_any"] = best_pain == 3
            f["pain_prospect_articulated"] = any(c["pain"]["who_articulated"] in ("prospect", "findigs_rep_suggested_prospect_agreed") for _, c in held)
            f["compelling_event_any"] = any(c["compelling_event"]["status"] in ("dated", "undated") for _, c in held)
            f["compelling_event_dated"] = any(c["compelling_event"]["status"] == "dated" for _, c in held)
            f["max_discovery_depth"] = max(c["discovery_depth_score"] for _, c in held); f["deep_discovery_any"] = f["max_discovery_depth"] >= 4
            for el in ["economic_buyer", "decision_process", "metrics", "champion", "decision_criteria", "paper_process", "competition"]:
                f[f"{el}_covered"] = any(c["meddpicc"][el]["status"] != "not_covered" for _, c in held)
            f["meddpicc_elements_covered"] = sum(any(c["meddpicc"][el]["status"] != "not_covered" for _, c in held) for el in c0["meddpicc"])
            pc = [(r, c) for r, c in held if c["price"]["discussed"]]
            f["price_discussed_any"] = bool(pc)
            if pc:
                p = pc[0][1]["price"]
                f["price_raised_by_findigs_first"] = p["first_raised_by"] == "findigs"; f["price_before_pain"] = p["pain_established_before_price"] == "no"
                f["price_value_framing"] = p["value_or_roi_framed"]; f["price_strong_objection"] = any(c["price"]["reaction"] == "strong_objection" for _, c in pc)
                f["first_price_stage"] = pc[0][0].stage_at_call
            pq = [q for _, c in held for q in c["prospect_questions"]]
            f["prospect_questions_n"] = len(pq)
            f["prospect_q_clear_share"] = (sum(q["answer_quality"] == "answered_clearly" for q in pq) / len(pq)) if pq else np.nan
            f["unanswered_prospect_question_any"] = any(q["answer_quality"] in ("deflected_or_unanswered", "inaccurate_or_contradictory") for q in pq)
            obj = [o for _, c in held for o in c["objections"]]
            cats = {o["category"] for o in obj}
            f["objection_categories"] = ";".join(sorted(cats)); f["hard_blocker_any"] = any(o["severity"] == "hard_blocker" for o in obj)
            f["etf_commitment_objection"] = "contract_terms_etf_commitment" in cats; f["pilot_request"] = "pilot_or_trial_request" in cats
            f["pms_integration_objection"] = "pms_integration_gap" in cats
            comps = [x for _, c in held for x in c["competitors_mentioned"]]
            f["competitor_mentioned"] = bool(comps); f["competitor_names"] = ";".join(sorted({x["name"].strip() for x in comps}))
            f["pms_bundled_screening"] = any(x["context"] == "bundled_with_pms" for x in comps) or "pms_bundled_screening" in cats
            fr = {s["signal"] for _, c in held for s in c["reception"]["friction_signals"]}
            f["friction_signals"] = ";".join(sorted(fr)); f["friction_send_info_or_circle_back"] = bool(fr & {"send_me_info_instead", "circle_back_later"})
            f["negative_or_skeptical_any"] = any(c["reception"]["overall_sentiment"] in ("negative", "skeptical") for _, c in held)
            f["stalling_or_reversing_any"] = any(c["momentum"] in ("stalling", "reversing") for _, c in held)
            stall = [r.call_seq for r, c in held if c["momentum"] in ("stalling", "reversing")]
            f["first_stall_seq"] = min(stall) if stall else np.nan
            f["last_next_step_specific"] = held[-1][1]["next_step"]["status"] in ("specific_dated_with_attendees", "specific_undated")
            ts = [r.started for r, _ in held]
            gaps = [(ts[i + 1] - ts[i]).days for i in range(len(ts) - 1)]
            f["max_gap_days"] = max(gaps) if gaps else np.nan
            f["long_gap_21d"] = bool(gaps) and max(gaps) > 21
            f["last_meeting_date"] = ts[-1]
            dc = [(r, c) for r, c in held if r.stage_at_call == "Discovery / Demo"]   # RQ3: Discovery-stage behaviour
            if dc:
                qs = [q for _, c in dc for q in c["findigs_questions"]]
                f["disc_calls"] = len(dc)
                f["disc_implication_q"] = any(q["category"] == "implication" for q in qs)
                f["disc_need_payoff_q"] = any(q["category"] == "need_payoff" for q in qs)
                f["disc_decision_process_q"] = any(q["category"] in ("decision_process", "authority") for q in qs)
                f["disc_current_vendor_q"] = any(q["category"] == "current_vendor" for q in qs)
                f["disc_open_probing_30pct"] = (sum(q["form"] == "open_probing" for q in qs) / len(qs) >= 0.30) if qs else False
                f["disc_depth_4plus"] = max(c["discovery_depth_score"] for _, c in dc) >= 4
                f["disc_price_before_pain"] = any(c["price"]["discussed"] and c["price"]["pain_established_before_price"] == "no" for _, c in dc)
                f["disc_prospect_pain_articulated"] = any(c["pain"]["who_articulated"] in ("prospect", "findigs_rep_suggested_prospect_agreed") for _, c in dc)
                f["disc_specific_next_step"] = any(c["next_step"]["status"] in ("specific_dated_with_attendees", "specific_undated") for _, c in dc)
            f["deal_breakers"] = ";".join(sorted({b["classification"] for _, c in held for b in c["deal_breaker_signals"]}))
            f["structural_deal_breaker"] = "structural_must_accept" in f["deal_breakers"]
            for r, c in held:   # quote bank (evidence already ≤25 words & redacted)
                for o in c["objections"]: quotes.append({"deal_id": d, "call_id": r.call_id, "stage_at_call": r.stage_at_call, "type": "objection", "category": o["category"], "severity": o["severity"], "handling": o["handling"], "quote": o["evidence"]})
                for q in c["prospect_questions"]: quotes.append({"deal_id": d, "call_id": r.call_id, "stage_at_call": r.stage_at_call, "type": "prospect_question", "category": q["category"], "severity": q["answer_quality"], "handling": "", "quote": q["evidence"]})
                for s in c["reception"]["friction_signals"]: quotes.append({"deal_id": d, "call_id": r.call_id, "stage_at_call": r.stage_at_call, "type": "friction", "category": s["signal"], "severity": "", "handling": "", "quote": s["evidence"]})
        s = deals.get(d)
        if s:
            f.update({"syn_primary_driver": s["primary_driver_transcript"], "syn_secondary_driver": s["secondary_driver_transcript"],
                      "syn_inflection_type": s["momentum_inflection"]["type"], "syn_inflection_seq": s["momentum_inflection"]["call_sequence"],
                      "syn_stakeholder_pattern": s["stakeholder_pattern"], "syn_qualified_first_meeting": s["qualified_at_first_meeting"],
                      "syn_avoidability": s["avoidability"], "syn_primary_lever": s["primary_lever"], "syn_confidence": s["confidence"]})
        rows.append(f)
    return pd.DataFrame(rows), pd.DataFrame(quotes)

def compare(df, feats, frame_name, rel, weights):
    out = []
    for f in feats:
        if f not in df: continue
        sub = df[df[f].notna()]
        w = sub[sub.outcome == "Won"]; l = sub[sub.outcome == "Lost"]
        kw, nw, kl, nl = int(w[f].astype(bool).sum()), len(w), int(l[f].astype(bool).sum()), len(l)
        p, test = compare_props(kw, nw, kl, nl)
        lw = l.merge(weights, on="deal_id", how="left")
        wprev = (lw[f].astype(bool) * lw.weight).sum() / lw.weight.sum() if len(lw) and lw.weight.notna().any() else np.nan
        gates = [rel.get(x, "not_assessed") for x in DEPENDS.get(f, [])]
        gate = "excluded" if "excluded" in gates else ("directional" if "directional" in gates or "not_assessed" in gates else "reportable")
        top_owner_share = (l[l[f].astype(bool)].deal_owner.value_counts(normalize=True).iloc[0] if kl else np.nan)
        out.append({"frame": frame_name, "feature": f, "won_k": kw, "won_n": nw, "won_rate": kw / nw if nw else np.nan, "won_ci": "%.0f–%.0f%%" % tuple(100 * x for x in wilson(kw, nw)) if nw else "",
                    "lost_k": kl, "lost_n": nl, "lost_rate": kl / nl if nl else np.nan, "lost_ci": "%.0f–%.0f%%" % tuple(100 * x for x in wilson(kl, nl)) if nl else "",
                    "diff_lost_minus_won": (kl / nl - kw / nw) if nl and nw else np.nan, "p": p, "test": test,
                    "lost_rate_ipw_weighted": wprev, "won_n_flag": flag(nw), "lost_n_flag": flag(nl), "reliability_gate": gate,
                    "top_owner_share_of_lost_with_feature": top_owner_share,
                    "concentration_flag": bool(top_owner_share > 0.40) if kl >= 5 else False})
    r = pd.DataFrame(out)
    if len(r): r["q_bh"] = bh_qvalues(r.p.values)
    return r

def verdict(row):
    if row.reliability_gate == "excluded": return "EXCLUDED (unreliable coding)"
    if min(row.won_n, row.lost_n) < N_DIRECTIONAL: return "ANECDOTAL (n<10 in a group)"
    sig = row.q_bh < 0.10 if pd.notna(row.q_bh) else False
    strength = "REPORTABLE" if min(row.won_n, row.lost_n) >= N_REPORTABLE and row.reliability_gate == "reportable" else "DIRECTIONAL"
    if not sig: return f"{strength}: no discriminating difference (common to won and lost)"
    return f"{strength}: discriminating ({'more' if row.diff_lost_minus_won > 0 else 'less'} common in lost)" + (" — CONCENTRATED in one owner" if row.concentration_flag else "")

def main():
    cohort = pd.read_csv(COHORT, dtype=str)
    m = pd.read_csv(OUT / "call_deal_map.csv", dtype={"deal_id": str, "call_id": str}); m["started"] = pd.to_datetime(m.started)
    calls, deals = load_codes()
    feats, quotes = deal_features(m, calls, deals)
    df = feats.merge(cohort, on="deal_id", how="left")
    weights = pd.read_csv(OUT / "deal_weights.csv", dtype={"deal_id": str})[["deal_id", "weight"]]
    rel_path = OUT / "field_reliability.csv"
    rel = dict(zip(*pd.read_csv(rel_path)[["field", "gate"]].values.T)) if rel_path.exists() else {}
    if not rel: print("[warn] no field_reliability.csv — every feature will be gated 'directional'. Run 08_reliability_check.py first.")
    df.to_csv(OUT / "deal_features.csv", index=False); quotes.to_csv(OUT / "quote_bank.csv", index=False)
    held = df[df.any_meeting_held == True]
    bin_feats = [k for k in DEPENDS] + ["structural_deal_breaker", "champion_covered", "decision_criteria_covered", "paper_process_covered"]
    frames = {
        "F_all_held": held,                                                          # any deal with >=1 held meeting
        "F_opportunity": held[held.highest_stage_idx.astype(int) >= 2],              # reached Discovery+ (removes TOFU selection confound)
        "F_negotiation": held[held.highest_stage_idx.astype(int) >= 4],              # reached Negotiation+ (late-stage blockers)
        "F_mid_market_opp": held[(held.segment == "Mid-Market") & (held.highest_stage_idx.astype(int) >= 2)],
    }
    comp = pd.concat([compare(fr, bin_feats, name, rel, weights) for name, fr in frames.items()], ignore_index=True)
    comp["verdict"] = comp.apply(verdict, axis=1)
    lost = df[(df.outcome == "Lost") & (df.any_meeting_held == True)]
    # T9 / RQ1: silence before close-out
    df["days_last_meeting_to_close"] = (pd.to_datetime(df.close_date) - pd.to_datetime(df.get("last_meeting_date"))).dt.days
    # RQ3: Discovery behaviour — deals that ADVANCED past Discovery (reached BC+ or won) vs deals that DIED at Discovery
    dd = df[df.get("disc_calls", pd.Series(dtype=float)).fillna(0) > 0].copy()
    dd["outcome"] = np.where((dd.highest_stage_idx.astype(int) >= 3) | (dd.outcome == "Won"), "Won", "Lost")   # 'Won' = advanced, 'Lost' = died at Discovery
    rq3 = compare(dd, list(DISC_FEATS), "RQ3 Discovery calls: advanced (=won cols) vs died at Discovery (=lost cols)", rel, weights)
    if len(rq3): rq3["verdict"] = rq3.apply(verdict, axis=1)
    # T3: are 'Bad Timing' losses really timing? compare Bad Timing opportunities vs other lost opportunities
    lo = lost[lost.highest_stage_idx.astype(int) >= 2].copy()
    lo["outcome"] = np.where(lo.reason_lost == "Bad Timing", "Lost", "Won")   # 'Lost' cols = Bad Timing, 'Won' cols = other lost opps
    lo["price_objection"] = lo.objection_categories.fillna("").str.contains("price")
    lo["no_compelling_event"] = ~lo.compelling_event_any.astype(bool)
    lo["no_pain_objection"] = lo.objection_categories.fillna("").str.contains("no_pain_status_quo")
    DEPENDS.update({"price_objection": ["objection_categories"], "no_compelling_event": ["compelling_event.status"], "no_pain_objection": ["objection_categories"]})
    t3 = compare(lo, ["price_objection", "no_compelling_event", "no_pain_objection", "price_strong_objection"], "T3: Bad Timing losses (=lost cols) vs other lost opportunities (=won cols)", rel, weights)
    if len(t3): t3["verdict"] = t3.apply(verdict, axis=1)
    # RQ7: CRM reason vs blind transcript driver
    cmap = json.loads((Path(__file__).resolve().parents[1] / "schema" / "crm_reason_to_driver_map.json").read_text())
    def agree(r):
        drv = r.get("syn_primary_driver")
        if not isinstance(drv, str): return "no_synthesis"
        if drv == "insufficient_evidence": return "insufficient_evidence"
        if r.reason_lost == "Other": return "crm_other (transcript driver: " + drv + ")"
        ok = cmap.get(r.reason_lost, [])
        return "agrees" if drv in ok else ("partially" if r.get("syn_secondary_driver") in ok else "contradicts")
    if len(lost): lost = lost.assign(crm_agreement=lost.apply(agree, axis=1))
    crm_agree = pd.crosstab(lost.reason_lost, lost.crm_agreement, margins=True) if "crm_agreement" in lost else pd.DataFrame()
    # Exploratory-promotion rule: does each F_opportunity difference replicate in both halves of the window?
    opp = held[held.highest_stage_idx.astype(int) >= 2]
    h1 = compare(opp[pd.to_datetime(opp.close_date) < "2026-04-01"], bin_feats, "H1", rel, weights)[["feature", "diff_lost_minus_won", "lost_n", "won_n"]]
    h2 = compare(opp[pd.to_datetime(opp.close_date) >= "2026-04-01"], bin_feats, "H2", rel, weights)[["feature", "diff_lost_minus_won", "lost_n", "won_n"]]
    rep = h1.merge(h2, on="feature", suffixes=("_H1", "_H2"))
    rep["replicates_both_halves"] = (np.sign(rep.diff_lost_minus_won_H1) == np.sign(rep.diff_lost_minus_won_H2)) & (rep[["lost_n_H1", "won_n_H1", "lost_n_H2", "won_n_H2"]].min(axis=1) >= 10)
    tabs = {"README": pd.DataFrame({"note": [
        "One row per deal (deals with >=1 held, coded meeting). Calls never counted individually in deal-level rates.",
        "Frames: F_all_held, F_opportunity (reached Discovery+), F_negotiation (reached Negotiation+), F_mid_market_opp.",
        "Every lost-deal pattern is shown with its prevalence in WON deals. 'No discriminating difference' = the behaviour happens in wins too, so it is not a loss driver.",
        "q_bh = Benjamini-Hochberg FDR across all tests in this tab; verdict uses q<0.10. lost_rate_ipw_weighted extrapolates to the full cohort using coverage weights.",
        "reliability_gate comes from 08_reliability_check (kappa). Excluded features must not appear in the paper.",
        "Anecdotal rows (n<10 in a group): quotes only, no rates in the paper."]}),
        "won_vs_lost": comp,
        "driver_by_tier": pd.crosstab([lost.funnel_tier_exit], lost.get("syn_primary_driver", pd.Series(dtype=str)), margins=True) if "syn_primary_driver" in lost else pd.DataFrame(),
        "crm_vs_transcript": pd.crosstab(lost.reason_lost, lost.get("syn_primary_driver", pd.Series(dtype=str)), margins=True) if "syn_primary_driver" in lost else pd.DataFrame(),
        "crm_agreement": crm_agree, "rq3_discovery": rq3, "t3_bad_timing": t3, "replication_halves": rep,
        "t9_silence": df[df.any_meeting_held == True].groupby("outcome").agg(deals=("deal_id", "size"), median_max_gap=("max_gap_days", "median"),
                        median_days_last_meeting_to_close=("days_last_meeting_to_close", "median"), share_gap_over_21d=("long_gap_21d", "mean")).reset_index(),
        "inflection_timing": lost.groupby("syn_inflection_type").agg(deals=("deal_id", "size"), median_inflection_seq=("syn_inflection_seq", "median")).reset_index() if "syn_inflection_type" in lost else pd.DataFrame(),
        "first_meeting_personas": df[df.any_meeting_held == True].assign(p=lambda x: x.first_meeting_personas.str.split(";")).explode("p").reset_index(drop=True).pipe(lambda x: pd.crosstab(x.p, x.outcome, margins=True)),
        "prospect_questions": quotes[quotes.type == "prospect_question"].pipe(lambda q: pd.crosstab(q.category, q.severity, margins=True)) if len(quotes) else pd.DataFrame(),
        "objections": quotes[quotes.type == "objection"].pipe(lambda q: pd.crosstab([q.category, q.severity], q.handling, margins=True)) if len(quotes) else pd.DataFrame(),
        "friction": quotes[quotes.type == "friction"].pipe(lambda q: q.groupby("category").deal_id.nunique().rename("deals").reset_index()) if len(quotes) else pd.DataFrame(),
        "competitors": lost.assign(c=lost.competitor_names.fillna("").str.split(";")).explode("c").reset_index(drop=True).query("c != ''").c.value_counts().rename("lost_deals").reset_index() if "competitor_names" in lost else pd.DataFrame(),
        "deal_breakers": lost.assign(b=lost.deal_breakers.fillna("").str.split(";")).explode("b").reset_index(drop=True).query("b != ''").b.value_counts().rename("lost_deals").reset_index() if "deal_breakers" in lost else pd.DataFrame(),
        "q3_vs_prior": compare(held.assign(outcome=np.where(held.close_quarter == "2026-Q3", "Lost", "Won")), bin_feats, "Q3_2026 (as 'lost') vs prior (as 'won')", rel, weights),
    }
    with pd.ExcelWriter(REPORTS / "03_transcript_analysis.xlsx") as xw:
        for k, v in tabs.items():
            (v if len(v) else pd.DataFrame({"note": ["no data"]})).to_excel(xw, sheet_name=k[:31], index=k in ("driver_by_tier", "crm_vs_transcript", "crm_agreement", "first_meeting_personas", "prospect_questions", "objections"))
    reg = pd.read_csv(FINDINGS)
    for c in ["transcript_evidence_refs", "verdict (Reinforces / Contradicts / Supplements / Not testable)", "confidence", "rationale", "paper_edit"]: reg[c] = ""
    reg.to_csv(REPORTS / "04_findings_register_template.csv", index=False)
    print(f"[ok] deals with coded meetings: {len(held)} (won {int((held.outcome=='Won').sum())}, lost {int((held.outcome=='Lost').sum())}). Wrote reports/03_transcript_analysis.xlsx")

if __name__ == "__main__":
    main()
