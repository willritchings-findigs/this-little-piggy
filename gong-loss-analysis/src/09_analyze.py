"""Phase 5: three-tier analysis. ONE ROW PER DEAL; every comparison is won-vs-lost inside a comparable funnel frame,
with Wilson CIs, n flags, BH-FDR q-values, weighted prevalence, validity gates and concentration checks.
  Tier A  deterministic features (all covered deals)      gate = agreement with Tier C on the sample calls   weights = coverage IPW
  Tier B  Gong-brief coding (all deals with briefs)       gate = agreement with Tier C on overlap deals      weights = coverage IPW
  Tier C  deep transcript coding (designed sample)        gate = calibration kappa (08)                       weights = coverage IPW x sampling weight
Outputs: reports/03_transcript_analysis.xlsx, data/outputs/deal_features.csv, data/outputs/quote_bank.csv, reports/04_findings_register_template.csv
"""
import json, glob
from pathlib import Path
import pandas as pd, numpy as np
from scipy import stats
from config import CODED, OUT, REPORTS, COHORT, FINDINGS, N_REPORTABLE, N_DIRECTIONAL, ROOT
from stats_utils import wilson, flag, compare_props, bh_qvalues, cohen_kappa

PAIN_ORD = {"not_discussed": 0, "implied": 1, "explicit_unquantified": 2, "explicit_quantified": 3}
DM = ("economic_buyer", "decision_maker")
SPECIFIC = ("specific_dated_with_attendees", "specific_undated")

# ---------- Tier C feature -> calibration fields it depends on ----------
DEP_C = {"dm_present_any": ["any_decision_maker_present"], "dm_present_by_first_meeting": ["any_decision_maker_present"],
         "pain_explicit_any": ["pain.status"], "pain_prospect_articulated": ["pain.who_articulated"], "pain_quantified_any": ["pain.status"],
         "compelling_event_any": ["compelling_event.status"], "compelling_event_dated": ["compelling_event.status"],
         "price_on_first_meeting": [], "price_before_pain": ["price.pain_established_before_price"], "price_raised_by_findigs_first": ["price.first_raised_by"],
         "price_strong_objection": ["price.reaction"], "deep_discovery_any": ["discovery_depth_band"], "economic_buyer_covered": ["meddpicc.economic_buyer"],
         "decision_process_covered": ["meddpicc.decision_process"], "metrics_covered": ["meddpicc.metrics"], "champion_covered": [], "decision_criteria_covered": [], "paper_process_covered": [],
         "last_next_step_specific": ["next_step.status"], "stalling_or_reversing_any": ["momentum"], "negative_or_skeptical_any": ["reception.overall_sentiment"],
         "competitor_mentioned": ["competitors"], "pms_bundled_screening": ["competitors", "objection_categories"], "hard_blocker_any": ["objection_categories"],
         "etf_commitment_objection": ["objection_categories"], "pilot_request": ["objection_categories"], "pms_integration_objection": ["objection_categories"],
         "unanswered_prospect_question_any": ["prospect_question_categories"], "friction_send_info_or_circle_back": [], "multi_external_attendee_meeting": [],
         "structural_deal_breaker": []}   # gap/silence features come from Tier A (all calls), never from the <=3 selected calls
DISC_C = {"disc_implication_q": [], "disc_need_payoff_q": [], "disc_decision_process_q": [], "disc_current_vendor_q": [], "disc_open_probing_30pct": [],
          "disc_depth_4plus": ["discovery_depth_band"], "disc_price_before_pain": ["price.pain_established_before_price"],
          "disc_prospect_pain_articulated": ["pain.who_articulated"], "disc_specific_next_step": ["next_step.status"]}
INTRO_C = {"intro_meeting_held": ["meeting_occurred"], "intro_prospect_pain": ["pain.who_articulated"], "intro_pain_explicit": ["pain.status"],
           "intro_dm_present": ["any_decision_maker_present"], "intro_specific_next_step": ["next_step.status"], "intro_price_discussed": [],
           "intro_friction": [], "intro_negative_or_skeptical": ["reception.overall_sentiment"], "intro_compelling_event": ["compelling_event.status"],
           "intro_no_pain_status_quo_objection": ["objection_categories"]}
# ---------- Tier A binary features and the Tier C call field used to validate each ----------
A_VALID = {"A_price_mentioned": ("price_mentioned", lambda c: c["price"]["discussed"]),
           "A_price_first_by_findigs": ("price_first_by_findigs", lambda c: c["price"]["first_raised_by"] == "findigs" if c["price"]["discussed"] else np.nan),
           "A_price_before_pain": ("price_before_prospect_pain", lambda c: c["price"]["pain_established_before_price"] == "no" if c["price"]["discussed"] else False),
           "A_competitor_named": ("competitors_named", lambda c: len(c["competitors_mentioned"]) > 0),
           "A_pms_bundled_proxy": ("pms_bundled_screening_proxy", lambda c: any(x["context"] == "bundled_with_pms" for x in c["competitors_mentioned"]) or any(o["category"] == "pms_bundled_screening" for o in c["objections"])),
           "A_contract_terms": ("contract_terms", lambda c: any(o["category"] == "contract_terms_etf_commitment" for o in c["objections"])),
           "A_pilot": ("pilot", lambda c: any(o["category"] == "pilot_or_trial_request" for o in c["objections"])),
           "A_friction_send_info": ("friction_send_info", lambda c: any(s["signal"] == "send_me_info_instead" for s in c["reception"]["friction_signals"])),
           "A_friction_circle_back": ("friction_circle_back", lambda c: any(s["signal"] == "circle_back_later" for s in c["reception"]["friction_signals"])),
           "A_friction_defer": ("friction_defer", lambda c: any(s["signal"] == "defer_to_someone_else" for s in c["reception"]["friction_signals"])),
           "A_next_step_language": ("next_step_language_last_20pct", lambda c: c["next_step"]["status"] in SPECIFIC)}
A_EXTRA = ["A_multi_prospect_speakers", "A_long_gap_21d"]          # objective (no validation needed)
A_NUMERIC = ["A_talk_share_findigs", "A_findigs_q_per_meeting", "A_prospect_q_per_meeting", "A_max_gap_days", "A_meetings"]
B_FEATS = {"B_dm_engaged": "dm_present_any", "B_pricing_discussed": "price_discussed_any", "B_pilot": "pilot_request", "B_contract_terms": "etf_commitment_objection",
           "B_last_next_step_specific": "last_next_step_specific", "B_structural_breaker": "structural_deal_breaker", "B_competitor": "competitor_mentioned"}

def gate_from_kappa(k, agree):
    if pd.isna(k): return "directional" if (not pd.isna(agree) and agree >= 0.8) else "not_assessed"
    return "reportable" if k >= 0.6 else ("directional" if k >= 0.4 else "excluded")

def load_json_dir(d, key):
    out = {}
    for f in glob.glob(str(d / "*.json")):
        r = json.loads(open(f, encoding="utf-8").read())
        out[r.get("call_id") or r["deal_id"]] = r
    return out

# ---------------- feature builders ----------------
def tier_c_features(m, calls, deals):
    rows, quotes = [], []
    for d, g in m.groupby("deal_id"):
        g = g.sort_values("started"); cs = [(r, calls[r.call_id]["coding"]) for _, r in g.iterrows() if r.call_id in calls and "_skipped" not in calls[r.call_id]["coding"]]
        if not cs: continue
        held = [(r, c) for r, c in cs if c["meeting_occurred"] == "yes"]
        f = {"deal_id": d, "C_calls_coded": len(cs), "C_meetings_held": len(held), "C_any_meeting_held": len(held) > 0}
        ic = [(r, c) for r, c in cs if r.stage_at_call == "Intro & Challenge"]   # T1 / H01: the Intro-stage call (incl. no-shows)
        if ic:
            ih = [(r, c) for r, c in ic if c["meeting_occurred"] == "yes"]
            f["intro_calls"] = len(ic); f["intro_meeting_held"] = bool(ih)
            if ih:
                f["intro_prospect_pain"] = any(c["pain"]["who_articulated"] in ("prospect", "findigs_rep_suggested_prospect_agreed") for _, c in ih)
                f["intro_pain_explicit"] = any(PAIN_ORD[c["pain"]["status"]] >= 2 for _, c in ih)
                f["intro_dm_present"] = any(a["decision_authority"] in DM for _, c in ih for a in c["external_attendees"])
                f["intro_specific_next_step"] = any(c["next_step"]["status"] in SPECIFIC for _, c in ih)
                f["intro_price_discussed"] = any(c["price"]["discussed"] for _, c in ih)
                f["intro_friction"] = any(c["reception"]["friction_signals"] for _, c in ih)
                f["intro_negative_or_skeptical"] = any(c["reception"]["overall_sentiment"] in ("negative", "skeptical") for _, c in ih)
                f["intro_compelling_event"] = any(c["compelling_event"]["status"] in ("dated", "undated") for _, c in ih)
                f["intro_no_pain_status_quo_objection"] = any(o["category"] == "no_pain_status_quo" for _, c in ih for o in c["objections"])
                f["intro_personas"] = ";".join(sorted({a["persona"] for _, c in ih for a in c["external_attendees"]}))
        if held:
            r0, c0 = held[0]
            f["first_meeting_personas"] = ";".join(sorted({a["persona"] for a in c0["external_attendees"]}))
            f["dm_present_by_first_meeting"] = any(a["decision_authority"] in DM for a in c0["external_attendees"])
            f["price_on_first_meeting"] = bool(c0["price"]["discussed"])
            f["multi_external_attendee_meeting"] = max(len(c["external_attendees"]) for _, c in held) >= 2
            f["dm_present_any"] = any(a["decision_authority"] in DM for _, c in held for a in c["external_attendees"])
            bp = max(PAIN_ORD[c["pain"]["status"]] for _, c in held); f["pain_explicit_any"] = bp >= 2; f["pain_quantified_any"] = bp == 3
            f["pain_prospect_articulated"] = any(c["pain"]["who_articulated"] in ("prospect", "findigs_rep_suggested_prospect_agreed") for _, c in held)
            f["compelling_event_any"] = any(c["compelling_event"]["status"] in ("dated", "undated") for _, c in held)
            f["compelling_event_dated"] = any(c["compelling_event"]["status"] == "dated" for _, c in held)
            f["deep_discovery_any"] = max(c["discovery_depth_score"] for _, c in held) >= 4
            for el in ["economic_buyer", "decision_process", "metrics", "champion", "decision_criteria", "paper_process"]:
                f[f"{el}_covered"] = any(c["meddpicc"][el]["status"] != "not_covered" for _, c in held)
            pc = [(r, c) for r, c in held if c["price"]["discussed"]]
            f["price_discussed_any"] = bool(pc)
            if pc:
                p = pc[0][1]["price"]; f["price_raised_by_findigs_first"] = p["first_raised_by"] == "findigs"; f["price_before_pain"] = p["pain_established_before_price"] == "no"
                f["price_strong_objection"] = any(c["price"]["reaction"] == "strong_objection" for _, c in pc)
            pq = [q for _, c in held for q in c["prospect_questions"]]
            f["unanswered_prospect_question_any"] = any(q["answer_quality"] in ("deflected_or_unanswered", "inaccurate_or_contradictory") for q in pq)
            obj = [o for _, c in held for o in c["objections"]]; cats = {o["category"] for o in obj}
            f["objection_categories"] = ";".join(sorted(cats)); f["hard_blocker_any"] = any(o["severity"] == "hard_blocker" for o in obj)
            f["etf_commitment_objection"] = "contract_terms_etf_commitment" in cats; f["pilot_request"] = "pilot_or_trial_request" in cats; f["pms_integration_objection"] = "pms_integration_gap" in cats
            comps = [x for _, c in held for x in c["competitors_mentioned"]]
            f["competitor_mentioned"] = bool(comps); f["competitor_names"] = ";".join(sorted({x["name"].strip() for x in comps}))
            f["pms_bundled_screening"] = any(x["context"] == "bundled_with_pms" for x in comps) or "pms_bundled_screening" in cats
            fr = {s["signal"] for _, c in held for s in c["reception"]["friction_signals"]}
            f["friction_send_info_or_circle_back"] = bool(fr & {"send_me_info_instead", "circle_back_later"})
            f["negative_or_skeptical_any"] = any(c["reception"]["overall_sentiment"] in ("negative", "skeptical") for _, c in held)
            f["stalling_or_reversing_any"] = any(c["momentum"] in ("stalling", "reversing") for _, c in held)
            f["last_next_step_specific"] = held[-1][1]["next_step"]["status"] in SPECIFIC
            f["deal_breakers"] = ";".join(sorted({b["classification"] for _, c in held for b in c["deal_breaker_signals"]})); f["structural_deal_breaker"] = "structural_must_accept" in f["deal_breakers"]
            dc = [(r, c) for r, c in held if r.stage_at_call == "Discovery / Demo"]
            if dc:
                qs = [q for _, c in dc for q in c["findigs_questions"]]; f["disc_calls"] = len(dc)
                f["disc_implication_q"] = any(q["category"] == "implication" for q in qs); f["disc_need_payoff_q"] = any(q["category"] == "need_payoff" for q in qs)
                f["disc_decision_process_q"] = any(q["category"] in ("decision_process", "authority") for q in qs); f["disc_current_vendor_q"] = any(q["category"] == "current_vendor" for q in qs)
                f["disc_open_probing_30pct"] = (sum(q["form"] == "open_probing" for q in qs) / len(qs) >= 0.30) if qs else False
                f["disc_depth_4plus"] = max(c["discovery_depth_score"] for _, c in dc) >= 4
                f["disc_price_before_pain"] = any(c["price"]["discussed"] and c["price"]["pain_established_before_price"] == "no" for _, c in dc)
                f["disc_prospect_pain_articulated"] = any(c["pain"]["who_articulated"] in ("prospect", "findigs_rep_suggested_prospect_agreed") for _, c in dc)
                f["disc_specific_next_step"] = any(c["next_step"]["status"] in SPECIFIC for _, c in dc)
            for r, c in held:
                for o in c["objections"]: quotes.append({"deal_id": d, "call_id": r.call_id, "stage_at_call": r.stage_at_call, "type": "objection", "category": o["category"], "detail": o["severity"] + "/" + o["handling"], "quote": o["evidence"]})
                for q in c["prospect_questions"]: quotes.append({"deal_id": d, "call_id": r.call_id, "stage_at_call": r.stage_at_call, "type": "prospect_question", "category": q["category"], "detail": q["answer_quality"], "quote": q["evidence"]})
                for s in c["reception"]["friction_signals"]: quotes.append({"deal_id": d, "call_id": r.call_id, "stage_at_call": r.stage_at_call, "type": "friction", "category": s["signal"], "detail": "", "quote": s["evidence"]})
        s = deals.get(d, {}).get("synthesis")
        if s:
            f.update({"syn_primary_driver": s["primary_driver_transcript"], "syn_secondary_driver": s["secondary_driver_transcript"], "syn_inflection_type": s["momentum_inflection"]["type"],
                      "syn_inflection_seq": s["momentum_inflection"]["call_sequence"], "syn_stakeholder_pattern": s["stakeholder_pattern"], "syn_qualified_first_meeting": s["qualified_at_first_meeting"],
                      "syn_avoidability": s["avoidability"], "syn_primary_lever": s["primary_lever"], "syn_confidence": s["confidence"]})
        rows.append(f)
    return pd.DataFrame(rows), pd.DataFrame(quotes)

def tier_a_features(a, m):
    a = a[a.transcript_empty.astype(str).str.lower() != "true"].merge(m[["call_id", "started"]], on="call_id", how="left").sort_values(["deal_id", "started"])
    rows = []
    for d, g in a.groupby("deal_id"):
        g = g.copy(); g["started"] = pd.to_datetime(g.started)
        pr = g[g.price_mentioned.astype(str).str.lower() == "true"]
        b = lambda col: bool(g[col].astype(str).str.lower().eq("true").any()) if col in g else False
        gaps = g.started.diff().dt.days.dropna()
        rows.append({"deal_id": d, "A_meetings": len(g), "A_price_mentioned": b("price_mentioned"),
                     "A_price_first_by_findigs": (str(pr.price_first_by_findigs.iloc[0]).lower() == "true") if len(pr) else np.nan,
                     "A_price_before_pain": (str(pr.price_before_prospect_pain.iloc[0]).lower() == "true") if len(pr) else np.nan,
                     "A_competitor_named": bool(g.competitors_named.fillna("").astype(str).str.len().gt(0).any()), "A_pms_bundled_proxy": b("pms_bundled_screening_proxy"),
                     "A_contract_terms": b("contract_terms"), "A_pilot": b("pilot"), "A_friction_send_info": b("friction_send_info"), "A_friction_circle_back": b("friction_circle_back"),
                     "A_friction_defer": b("friction_defer"), "A_next_step_language": str(g.next_step_language_last_20pct.iloc[-1]).lower() == "true",
                     "A_multi_prospect_speakers": bool((pd.to_numeric(g.n_prospect_speakers_active, errors="coerce") >= 2).any()),
                     "A_long_gap_21d": bool((gaps > 21).any()), "A_max_gap_days": gaps.max() if len(gaps) else np.nan,
                     "A_talk_share_findigs": pd.to_numeric(g.talk_share_findigs_chars, errors="coerce").mean(),
                     "A_findigs_q_per_meeting": pd.to_numeric(g.findigs_questions, errors="coerce").mean(), "A_prospect_q_per_meeting": pd.to_numeric(g.prospect_questions, errors="coerce").mean(),
                     "A_last_meeting": g.started.max()})
    return pd.DataFrame(rows)

def tier_b_features(briefs):
    rows = []
    for d, r in briefs.items():
        c = r["coding"]
        rows.append({"deal_id": d, "B_primary_driver": c["primary_driver"], "B_secondary_driver": c["secondary_driver"], "B_inflection_type": c["momentum_inflection"]["type"],
                     "B_inflection_seq": c["momentum_inflection"]["call_sequence"], "B_dm_engaged": {"yes": True, "no": False}.get(c["decision_maker_engaged"], np.nan),
                     "B_pricing_discussed": {"yes": True, "no": False}.get(c["pricing_discussed"], np.nan), "B_pilot": {"yes": True, "no": False}.get(c["pilot_or_trial_requested"], np.nan),
                     "B_contract_terms": {"yes": True, "no": False}.get(c["contract_terms_raised"], np.nan),
                     "B_last_next_step_specific": {"specific": True, "vague": False, "none": False}.get(c["last_next_step"], np.nan),
                     "B_structural_breaker": "structural_must_accept" in c["deal_breakers"], "B_competitor": len(c["competitors"]) > 0,
                     "B_objection_categories": ";".join(sorted(c["objection_categories"])), "B_confidence": c["confidence"]})
    return pd.DataFrame(rows)

# ---------------- comparison engine ----------------
def compare(df, feats, frame, gates, wcol):
    out = []
    for f in feats:
        if f not in df: continue
        sub = df[df[f].notna()]; w = sub[sub.outcome == "Won"]; l = sub[sub.outcome == "Lost"]
        kw, nw, kl, nl = int(w[f].astype(bool).sum()), len(w), int(l[f].astype(bool).sum()), len(l)
        p, test = compare_props(kw, nw, kl, nl)
        lw = l[l[wcol].notna()] if wcol in l else l.iloc[0:0]
        wprev = (lw[f].astype(bool) * lw[wcol]).sum() / lw[wcol].sum() if len(lw) and lw[wcol].sum() > 0 else np.nan
        top = l[l[f].astype(bool)].deal_owner.value_counts(normalize=True).iloc[0] if kl else np.nan
        out.append({"frame": frame, "feature": f, "won_k": kw, "won_n": nw, "won_rate": kw / nw if nw else np.nan,
                    "won_ci": "%.0f–%.0f%%" % tuple(100 * x for x in wilson(kw, nw)) if nw else "", "lost_k": kl, "lost_n": nl, "lost_rate": kl / nl if nl else np.nan,
                    "lost_ci": "%.0f–%.0f%%" % tuple(100 * x for x in wilson(kl, nl)) if nl else "", "diff_lost_minus_won": (kl / nl - kw / nw) if nl and nw else np.nan,
                    "p": p, "test": test, "lost_rate_weighted": wprev, "validity_gate": gates.get(f, "not_assessed"),
                    "top_owner_share_of_lost_with_feature": top, "concentration_flag": bool(top > 0.40) if kl >= 5 else False})
    r = pd.DataFrame(out)
    if len(r): r["q_bh"] = bh_qvalues(r.p.values); r["verdict"] = r.apply(verdict, axis=1)
    return r

def verdict(row):
    if row.validity_gate == "excluded": return "EXCLUDED (failed validity gate)"
    if min(row.won_n, row.lost_n) < N_DIRECTIONAL: return "ANECDOTAL (n<10 in a group)"
    sig = row.q_bh < 0.10 if pd.notna(row.q_bh) else False
    strength = "REPORTABLE" if min(row.won_n, row.lost_n) >= N_REPORTABLE and row.validity_gate == "reportable" else "DIRECTIONAL"
    if not sig: return f"{strength}: no discriminating difference (common to won and lost)"
    return f"{strength}: discriminating ({'more' if row.diff_lost_minus_won > 0 else 'less'} common in lost)" + (" — CONCENTRATED in one owner" if row.concentration_flag else "")

def numeric_compare(df, cols, frame):
    out = []
    for ccol in cols:
        if ccol not in df: continue
        w = pd.to_numeric(df[df.outcome == "Won"][ccol], errors="coerce").dropna(); l = pd.to_numeric(df[df.outcome == "Lost"][ccol], errors="coerce").dropna()
        p = stats.mannwhitneyu(w, l).pvalue if len(w) >= 5 and len(l) >= 5 else np.nan
        out.append({"frame": frame, "metric": ccol, "won_n": len(w), "won_median": w.median(), "lost_n": len(l), "lost_median": l.median(), "mann_whitney_p": p, "n_flag": flag(min(len(w), len(l)))})
    return pd.DataFrame(out)

def agreement_table(pairs):
    rows = []
    for name, a, b in pairs:
        ok = [(x, y) for x, y in zip(a, b) if not (pd.isna(x) or pd.isna(y))]
        if not ok: rows.append({"feature": name, "n": 0, "pct_agree": np.nan, "kappa": np.nan, "gate": "not_assessed"}); continue
        xa = [str(bool(x)) for x, _ in ok]; xb = [str(bool(y)) for _, y in ok]
        k = cohen_kappa(xa, xb); ag = np.mean([x == y for x, y in zip(xa, xb)])
        rows.append({"feature": name, "n": len(ok), "pct_agree": ag, "kappa": k, "gate": gate_from_kappa(k, ag) if len(ok) >= 20 else "directional (n<20)"})
    return pd.DataFrame(rows)

def main():
    cohort = pd.read_csv(COHORT, dtype=str)
    m = pd.read_csv(OUT / "call_deal_map.csv", dtype={"deal_id": str, "call_id": str}); m["started"] = pd.to_datetime(m.started)
    calls = load_json_dir(CODED / "calls", "call_id"); deals = load_json_dir(CODED / "deals", "deal_id"); briefs = load_json_dir(CODED / "briefs", "deal_id")
    covw = pd.read_csv(OUT / "deal_weights.csv", dtype={"deal_id": str})[["deal_id", "weight"]].rename(columns={"weight": "w_cov"})
    sw = pd.read_csv(OUT / "tierC_sample_deals.csv", dtype={"deal_id": str})[["deal_id", "sampling_weight"]] if (OUT / "tierC_sample_deals.csv").exists() else pd.DataFrame(columns=["deal_id", "sampling_weight"])
    ta = pd.read_csv(OUT / "tierA_call_features.csv", dtype={"deal_id": str, "call_id": str})
    A = tier_a_features(ta, m); C, quotes = tier_c_features(m, calls, deals); B = tier_b_features(briefs)
    df = cohort.merge(A, on="deal_id", how="inner").merge(C, on="deal_id", how="left").merge(B, on="deal_id", how="left").merge(covw, on="deal_id", how="left").merge(sw, on="deal_id", how="left")
    df["w_C"] = df.w_cov * df.sampling_weight
    df["days_last_meeting_to_close"] = (pd.to_datetime(df.close_date) - pd.to_datetime(df.A_last_meeting)).dt.days
    df.to_csv(OUT / "deal_features.csv", index=False); quotes.to_csv(OUT / "quote_bank.csv", index=False)

    # ---- validity gates ----
    relp = OUT / "field_reliability.csv"
    rel = dict(zip(*pd.read_csv(relp)[["field", "gate"]].values.T)) if relp.exists() else {}
    gates_C = {f: ("excluded" if any(rel.get(x) == "excluded" for x in deps) else ("directional" if any(rel.get(x, "not_assessed") != "reportable" for x in deps) else "reportable"))
               for f, deps in {**DEP_C, **DISC_C, **INTRO_C}.items()}
    # Tier A vs Tier C at CALL level on sample calls
    tac = ta.set_index("call_id"); pairs = []
    sample_calls = [c for c in calls if c in tac.index and "_skipped" not in calls[c]["coding"]]
    for feat, (acol, cfun) in A_VALID.items():
        av = [(str(tac.loc[c, acol]).lower() == "true") if acol != "competitors_named" else (isinstance(tac.loc[c, acol], str) and len(tac.loc[c, acol]) > 0) for c in sample_calls]
        if acol == "price_first_by_findigs": av = [np.nan if str(tac.loc[c, "price_mentioned"]).lower() != "true" else x for c, x in zip(sample_calls, av)]
        pairs.append((feat, av, [cfun(calls[c]["coding"]) for c in sample_calls]))
    ta_val = agreement_table(pairs)
    gates_A = dict(zip(ta_val.feature, ta_val.gate)); gates_A.update({f: "reportable" for f in A_EXTRA})
    # Tier B vs Tier C at DEAL level on overlap deals
    ov = df[df.B_primary_driver.notna() & df.C_any_meeting_held.fillna(False).astype(bool)]
    tb_val = agreement_table([(bf, ov[bf].tolist(), ov[cf].tolist()) for bf, cf in B_FEATS.items() if cf in ov])
    drv = ov[ov.syn_primary_driver.notna()] if "syn_primary_driver" in ov else ov.iloc[0:0]
    if len(drv):
        k = cohen_kappa(drv.B_primary_driver.tolist(), drv.syn_primary_driver.tolist()); ag = (drv.B_primary_driver == drv.syn_primary_driver).mean()
        tb_val = pd.concat(ignore_index=True, objs=[tb_val, pd.DataFrame([{"feature": "B_primary_driver (categorical)", "n": len(drv), "pct_agree": ag, "kappa": k, "gate": gate_from_kappa(k, ag) if len(drv) >= 20 else "directional (n<20)"}])])
    gates_B = dict(zip(tb_val.feature, tb_val.gate)); gate_B_driver = gates_B.get("B_primary_driver (categorical)", "not_assessed")

    # ---- frames ----
    opp = df[df.highest_stage_idx.astype(int) >= 2]; neg = df[df.highest_stage_idx.astype(int) >= 4]
    cdf = df[df.C_any_meeting_held.fillna(False).astype(bool)]; copp = cdf[cdf.highest_stage_idx.astype(int) >= 2]
    a_feats = list(A_VALID) + A_EXTRA; b_feats = list(B_FEATS); c_feats = list(DEP_C)
    comp = pd.concat([
        compare(df, a_feats, "A | all covered deals", gates_A, "w_cov"), compare(opp, a_feats, "A | opportunities (Discovery+)", gates_A, "w_cov"),
        compare(neg, a_feats, "A | Negotiation+", gates_A, "w_cov"),
        compare(opp[opp.B_primary_driver.notna()], b_feats, "B | opportunities with briefs (Tier B covers Discovery+ deals only — rule 5)", gates_B, "w_cov"),
        compare(cdf, c_feats, "C | sample, held meetings", gates_C, "w_C"), compare(copp, c_feats, "C | sample opportunities", gates_C, "w_C"),
        compare(cdf[cdf.highest_stage_idx.astype(int) >= 4], c_feats, "C | sample Negotiation+", gates_C, "w_C"),
        compare(copp[copp.segment == "Mid-Market"], c_feats, "C | sample Mid-Market opportunities", gates_C, "w_C")], ignore_index=True)
    nums = pd.concat([numeric_compare(df, A_NUMERIC, "A | all covered"), numeric_compare(opp, A_NUMERIC, "A | opportunities")], ignore_index=True)
    # Rule-4 cap sensitivity: the same Tier A deal features computed from ALL in-scope calls vs only the <=3 selected calls.
    # If won-vs-lost differences change materially under the cap, deal-level "ever happened" features in Tier B/C are biased by the cap.
    cap_sens = pd.DataFrame()
    if (OUT / "selected_calls.csv").exists():
        sel_ids = set(pd.read_csv(OUT / "selected_calls.csv", dtype=str).call_id)
        As = tier_a_features(ta[ta.call_id.isin(sel_ids)], m)
        dsel = cohort.merge(As, on="deal_id", how="inner").merge(covw, on="deal_id", how="left")
        full = compare(df, list(A_VALID), "all calls", gates_A, "w_cov")[["feature", "won_rate", "lost_rate", "diff_lost_minus_won"]]
        capd = compare(dsel, list(A_VALID), "selected calls", gates_A, "w_cov")[["feature", "won_rate", "lost_rate", "diff_lost_minus_won"]]
        cap_sens = full.merge(capd, on="feature", suffixes=("_all_calls", "_selected_calls"))
        cap_sens["diff_shift_pts"] = (cap_sens.diff_lost_minus_won_selected_calls - cap_sens.diff_lost_minus_won_all_calls) * 100
        cap_sens["cap_bias_flag"] = cap_sens.diff_shift_pts.abs() > 5
        cap_sens["mean_in_scope_meetings_won"] = df[df.outcome == "Won"].A_meetings.mean(); cap_sens["mean_in_scope_meetings_lost"] = df[df.outcome == "Lost"].A_meetings.mean()
    # RQ3 Discovery (Tier C): advanced past Discovery vs died at Discovery
    dd = cdf[cdf.get("disc_calls", pd.Series(dtype=float)).fillna(0) > 0].copy()
    dd["outcome"] = np.where((dd.highest_stage_idx.astype(int) >= 3) | (dd.outcome == "Won"), "Won", "Lost")
    rq3 = compare(dd, list(DISC_C), "RQ3: advanced past Discovery (=won cols) vs died at Discovery (=lost cols)", gates_C, "w_C")
    # T1 / H01 (Tier C): Intro-stage calls of deals that DIED at Intro vs deals that ADVANCED past Intro (rule 5 keeps a fixed TOFU sample for exactly this)
    ii = df[df.get("intro_calls", pd.Series(dtype=float)).fillna(0) > 0].copy()   # ALL deals with a coded Intro call, incl. no-shows (that IS the T1 evidence)
    ii["outcome"] = np.where(ii.highest_stage_idx.astype(int) >= 2, "Won", "Lost")   # 'Won' cols = advanced past Intro, 'Lost' cols = died at Intro
    t1 = compare(ii, list(INTRO_C), "T1: Intro calls — advanced past Intro (=won cols) vs died at Intro (=lost cols)", gates_C, "w_C")
    t1_personas = ii.assign(p=ii.get("intro_personas", pd.Series(dtype=str)).fillna("").str.split(";")).explode("p").reset_index(drop=True).query("p != ''").pipe(lambda x: pd.crosstab(x.p, x.outcome.map({"Won": "advanced", "Lost": "died_at_intro"}), margins=True)) if "intro_personas" in ii and ii.intro_personas.notna().any() else pd.DataFrame()
    t1_source = ii.groupby(["deal_source", "outcome"]).size().unstack(fill_value=0).rename(columns={"Won": "advanced", "Lost": "died_at_intro"}) if len(ii) else pd.DataFrame()
    # T3 Bad Timing (Tier C + Tier A)
    lo = df[(df.outcome == "Lost") & (df.highest_stage_idx.astype(int) >= 2)].copy()
    lo["outcome"] = np.where(lo.reason_lost == "Bad Timing", "Lost", "Won")
    lo["C_price_objection"] = lo.objection_categories.str.contains("price", na=False).where(lo.objection_categories.notna())
    lo["C_no_compelling_event"] = (~lo.compelling_event_any.astype("boolean")).where(lo.compelling_event_any.notna())
    t3 = compare(lo, ["C_price_objection", "C_no_compelling_event", "A_price_mentioned", "A_friction_circle_back"], "T3: Bad Timing losses (=lost cols) vs other lost opportunities (=won cols)",
                 {**gates_A, "C_price_objection": gates_C.get("price_strong_objection", "directional"), "C_no_compelling_event": gates_C.get("compelling_event_any", "directional")}, "w_cov")
    # RQ7 CRM agreement (Tier C synthesis and Tier B)
    cmap = json.loads((ROOT / "schema" / "crm_reason_to_driver_map.json").read_text())
    def agree(reason, drv, drv2=None):
        if not isinstance(drv, str): return np.nan
        if drv == "insufficient_evidence": return "insufficient_evidence"
        if reason == "Other": return "crm_other"
        ok = cmap.get(reason, []); return "agrees" if drv in ok else ("partially" if drv2 in ok else "contradicts")
    lost = df[df.outcome == "Lost"].copy()
    lost["agree_C"] = [agree(r.reason_lost, r.get("syn_primary_driver"), r.get("syn_secondary_driver")) for _, r in lost.iterrows()]
    lost["agree_B"] = [agree(r.reason_lost, r.get("B_primary_driver"), r.get("B_secondary_driver")) for _, r in lost.iterrows()]
    # Split-half replication (Tier A all covered opportunities + Tier C sample opportunities)
    def halves(frame, feats, gates, wcol, label):
        h1 = compare(frame[pd.to_datetime(frame.close_date) < "2026-04-01"], feats, "H1", gates, wcol); h2 = compare(frame[pd.to_datetime(frame.close_date) >= "2026-04-01"], feats, "H2", gates, wcol)
        if not len(h1) or not len(h2): return pd.DataFrame()
        r = h1[["feature", "diff_lost_minus_won", "lost_n", "won_n"]].merge(h2[["feature", "diff_lost_minus_won", "lost_n", "won_n"]], on="feature", suffixes=("_H1", "_H2"))
        r["replicates_both_halves"] = (np.sign(r.diff_lost_minus_won_H1) == np.sign(r.diff_lost_minus_won_H2)) & (r[["lost_n_H1", "won_n_H1", "lost_n_H2", "won_n_H2"]].min(axis=1) >= 10)
        r.insert(0, "tier", label); return r
    rep = pd.concat([halves(opp, a_feats, gates_A, "w_cov", "A"), halves(copp, c_feats, gates_C, "w_C", "C")], ignore_index=True)
    q3 = compare(df.assign(outcome=np.where(df.close_quarter == "2026-Q3", "Lost", "Won")), a_feats + b_feats, "Q3 2026 (=lost cols) vs prior (=won cols)", {**gates_A, **gates_B}, "w_cov")

    tabs = {"README": pd.DataFrame({"note": [
        "One row per deal. Tier A = deterministic transcript features (all covered deals); Tier B = Gong-brief coding (all deals with briefs); Tier C = deep transcript coding (designed sample; weighted by coverage x sampling).",
        "Every lost-deal pattern is shown with its prevalence in WON deals in the same frame. 'No discriminating difference' = it happens in wins too, so it is not a loss driver.",
        "validity_gate: Tier C from calibration kappa; Tier A from agreement with Tier C on sample calls (tierA_vs_tierC); Tier B from agreement with Tier C on overlap deals (tierB_vs_tierC). EXCLUDED rows must not appear in the paper.",
        "q_bh = Benjamini-Hochberg FDR within each frame; verdict uses q<0.10. lost_rate_weighted extrapolates to the covered cohort (Tier C also undoes the sample design).",
        "Anecdotal rows (n<10 in a group): quotes only, no rates. Exploratory findings need replicates_both_halves = True to be promoted.",
        f"Tier B primary-driver gate (vs Tier C synthesis): {gate_B_driver}. Use Tier B driver distributions only if not excluded.",
        "cap_sensitivity: Tier A features recomputed on only the <=3 selected calls per deal. diff_shift_pts > 5 (cap_bias_flag) means the rule-4 cap distorts that comparison; caveat or avoid the matching Tier B/C 'any meeting' features.",
        "Silence / gap metrics (t9_silence, A_long_gap_21d, A_max_gap_days) always use ALL in-scope calls (Tier A), never the capped selection.",
        "Rule 5: Tier B excludes deals that never left Intro; Tier C holds a fixed TOFU sample (default 30, weighted). TOFU evidence = Tier A (all) + Tier C t1_intro_calls. Never describe Tier B rates as covering all losses."]}),
        "won_vs_lost": comp, "numeric_A": nums, "cap_sensitivity": cap_sens, "tierA_vs_tierC": ta_val, "tierB_vs_tierC": tb_val,
        "t1_intro_calls": t1, "t1_intro_personas": t1_personas, "t1_intro_by_source": t1_source, "rq3_discovery": rq3, "t3_bad_timing": t3, "replication_halves": rep, "q3_vs_prior": q3,
        "driver_by_tier_C": pd.crosstab(lost.funnel_tier_exit, lost.get("syn_primary_driver"), margins=True) if lost.get("syn_primary_driver") is not None and lost.syn_primary_driver.notna().any() else pd.DataFrame(),
        "driver_by_tier_B": pd.crosstab(lost.funnel_tier_exit, lost.B_primary_driver, margins=True) if lost.B_primary_driver.notna().any() else pd.DataFrame(),
        "crm_agreement_C": pd.crosstab(lost.reason_lost, lost.agree_C, margins=True) if lost.agree_C.notna().any() else pd.DataFrame(),
        "crm_agreement_B": pd.crosstab(lost.reason_lost, lost.agree_B, margins=True) if lost.agree_B.notna().any() else pd.DataFrame(),
        "t9_silence": df.groupby("outcome").agg(deals=("deal_id", "size"), median_max_gap=("A_max_gap_days", "median"), median_days_last_meeting_to_close=("days_last_meeting_to_close", "median"), share_gap_over_21d=("A_long_gap_21d", "mean")).reset_index(),
        "inflection_C": lost.groupby("syn_inflection_type").agg(deals=("deal_id", "size"), median_seq=("syn_inflection_seq", "median")).reset_index() if "syn_inflection_type" in lost else pd.DataFrame(),
        "inflection_B": lost.groupby("B_inflection_type").agg(deals=("deal_id", "size"), median_seq=("B_inflection_seq", "median")).reset_index(),
        "first_meeting_personas_C": cdf.assign(p=cdf.first_meeting_personas.fillna("").str.split(";")).explode("p").reset_index(drop=True).query("p != ''").pipe(lambda x: pd.crosstab(x.p, x.outcome, margins=True)) if "first_meeting_personas" in cdf and len(cdf) else pd.DataFrame(),
        "prospect_questions_C": quotes[quotes.type == "prospect_question"].pipe(lambda q: pd.crosstab(q.category, q.detail, margins=True)) if len(quotes) else pd.DataFrame(),
        "prospect_questions_A": pd.read_csv(OUT / "tierA_prospect_questions.csv", dtype={"deal_id": str}).merge(cohort[["deal_id", "outcome"]], on="deal_id").pipe(lambda q: pd.crosstab(q.category_guess, q.outcome, margins=True)) if (OUT / "tierA_prospect_questions.csv").exists() and (OUT / "tierA_prospect_questions.csv").stat().st_size > 50 else pd.DataFrame(),
        "objections_C": quotes[quotes.type == "objection"].pipe(lambda q: pd.crosstab(q.category, q.detail, margins=True)) if len(quotes) else pd.DataFrame(),
        "competitors_A": ta.assign(c=ta.competitors_named.fillna("").astype(str).str.split(";")).explode("c").reset_index(drop=True).query("c != ''").merge(cohort[["deal_id", "outcome"]], on="deal_id").groupby(["c", "outcome"]).deal_id.nunique().unstack(fill_value=0),
        "deal_breakers_C": lost.assign(b=lost.deal_breakers.fillna("").str.split(";")).explode("b").reset_index(drop=True).query("b != ''").b.value_counts().rename("lost_deals").reset_index() if "deal_breakers" in lost else pd.DataFrame(),
    }
    with pd.ExcelWriter(REPORTS / "03_transcript_analysis.xlsx") as xw:
        for k, v in tabs.items():
            v = v if isinstance(v, pd.DataFrame) and len(v) else pd.DataFrame({"note": ["no data"]})
            v.to_excel(xw, sheet_name=k[:31], index=not isinstance(v.index, pd.RangeIndex))
    reg = pd.read_csv(FINDINGS)
    for col in ["transcript_evidence_refs", "verdict (Reinforces / Contradicts / Supplements / Not testable)", "tier_and_confidence", "rationale", "paper_edit"]: reg[col] = ""
    reg.to_csv(REPORTS / "04_findings_register_template.csv", index=False)
    print(f"[ok] covered deals: {len(df)} (Tier B coded: {int(df.B_primary_driver.notna().sum())}; Tier C coded: {int(df.C_any_meeting_held.fillna(False).astype(bool).sum())}). "
          f"Gates — Tier A: {pd.Series(gates_A).value_counts().to_dict()}; Tier B driver: {gate_B_driver}. Wrote reports/03_transcript_analysis.xlsx")

if __name__ == "__main__":
    main()
