"""Phase 2d — TIER A (deterministic, no LLM, every in-scope meeting) + Tier B input bundles.
Reads data/prepared/<call_id>.txt|.meta.json and data/raw/calls_content/<call_id>.json. One local pass, no API calls.
Outputs:
  data/outputs/tierA_call_features.csv    one row per call (objective features; no transcript text)
  data/outputs/tierA_prospect_questions.csv  prospect '?' sentences with keyword category (redacted text; local only, gitignored)
  data/prepared/briefs/<deal_id>.json      redacted Gong AI briefs/key points/outcomes for the deal's SELECTED calls (rule 4), chronological, BLIND (Tier B input)
  data/outputs/brief_availability.csv      share of meetings with a Gong brief, by close quarter / stage
Every proxy here is validated against Tier C full-transcript coding on the sample (09_analyze 'tierA_vs_tierC' tab) before it is reported.
"""
import json, re, glob
import pandas as pd, numpy as np
from config import PREPARED, RAW, OUT, COHORT, DEAL_ASSOC
from redact import deal_terms as build_deal_terms, make_redactor

LINE = re.compile(r"^\[(\d+):(\d{2})\] ([^:]+): (.*)$")
SENT_SPLIT = re.compile(r"(?<=[?.!])\s+")
def questions(text): return [x for x in SENT_SPLIT.split(text) if x.strip().endswith("?")]
RX = {
 "price": r"\b(price|pricing|priced|cost|costs|per unit|per door|per application|per app|fee|fees|budget|quote|proposal|invoice|\$\s?\d)",
 "pain": r"\b(fraud|fake (pay ?stubs|ids?)|identity|evict\w*|delinquen\w*|bad debt|skip(ped)? out|manual\w*|takes (us )?(too )?long|time to lease|vacanc\w*|days on market|compliance|fair housing|fcra|lawsuit|consisten\w*|bias)\b",
 "contract_terms": r"\b(early termination|termination fee|etf|minimum commitment|commitment|contract (length|term)|term length|auto[- ]?renew\w*|multi[- ]year|annual contract|cancel\w*)\b",
 "pilot": r"\b(pilot|trial|proof of concept|poc|test (it|this) (out|on)|try it on)\b",
 "friction_send_info": r"\b(send (me|us|over) (some |the |a )?(info\w*|deck|material\w*|something|details|one[- ]pager|brochure)|email (me|us) (some|the) (info|details))\b",
 "friction_circle_back": r"\b(circle back|touch base (later|again|in)|revisit (this|it)|not (a|the) (top )?priority|next (quarter|year)|after (the )?(holidays|budget|new year))\b",
 "friction_defer": r"\b(run (it|this) (by|past)|talk (to|with) my (boss|team|owner|partner|ceo|coo|cfo|vp)|need to check with|loop in (my|our))\b",
 "next_step": r"\b(calendar invite|send (you |an )?invite|book (a|the) (time|call|meeting)|schedule (a|the|our) (follow[- ]?up|call|meeting|demo)|next (monday|tuesday|wednesday|thursday|friday|week)|same time next)\b",
}
RXC = {k: re.compile(v, re.I) for k, v in RX.items()}
PMS = ["AppFolio", "Yardi", "RealPage", "Entrata", "Buildium", "Rent Manager", "Propertyware", "MRI", "ResMan", "Rentvine", "TenantCloud", "Rentec"]
SCREENERS = ["TransUnion", "SmartMove", "RentSpree", "Snappt", "SafeRent", "CoreLogic", "Checkr", "Certn", "Boom", "RentButter", "RentEngine", "Two Dots", "Vero", "ApproveShield", "Aptly", "AmRent", "Weimark", "OnSite", "Experian", "Equifax", "Zillow", "RentPrep", "MyRental", "TurboTenant", "Avail", "Plaid"]
COMP_RX = re.compile(r"\b(" + "|".join(re.escape(x) for x in PMS + SCREENERS) + r")\b", re.I)
BUNDLED_RX = re.compile(r"\b(built[- ]in|built into|comes with|included (in|with)|bundled|through (appfolio|yardi|realpage|entrata|buildium)|(appfolio|yardi|realpage|entrata|buildium)('s)? (own )?screening)\b", re.I)
QCAT = [("pricing", r"price|pricing|cost|fee|per unit|per app|budget|\$"), ("pms_integration", r"integrat|appfolio|yardi|realpage|entrata|buildium|rent manager|sync|api"),
        ("compliance", r"fair housing|fcra|complian|legal|adverse action|disparate|hud"), ("fraud", r"fraud|fake|identity|verif"),
        ("decision_logic", r"criteria|decision|score|threshold|approve|deny|conditional|rules?"), ("implementation", r"implement|onboard|set ?up|go live|launch|training|how long"),
        ("contract", r"contract|term|commit|cancel|renew|terminat"), ("pilot", r"pilot|trial|test"), ("references", r"reference|case study|who else|other (pmcs|companies|clients)|customers? like"),
        ("renter_experience", r"applicant|renter|resident|tenant experience|mobile|portal"), ("support", r"support|service|help desk|account manager"), ("data_security", r"secur|soc ?2|privacy|data")]
QCATC = [(k, re.compile(v, re.I)) for k, v in QCAT]
TITLE = [("owner_principal", r"owner|principal|founder|partner"), ("executive_c_suite", r"\b(ceo|coo|cfo|cto|president|chief)\b"), ("vp_director_operations", r"\b(vp|vice president|director|head of)\b"),
         ("regional_manager", r"regional|district|area manager"), ("property_manager", r"property manager|community manager|portfolio manager"), ("leasing_agent", r"leasing|lease"),
         ("finance_accounting", r"account|finance|controller|ar |collections"), ("it_technology", r"\bit\b|technology|systems|software|engineer"), ("compliance_legal", r"compliance|legal|counsel|risk")]

def persona(t):
    t = (t or "").lower()
    for k, rx in TITLE:
        if re.search(rx, t): return k
    return "unknown"

def parse(path):
    rows = []
    for line in open(path, encoding="utf-8"):
        m = LINE.match(line.rstrip("\n"))
        if m: rows.append((int(m.group(1)) + int(m.group(2)) / 60, m.group(3), m.group(4)))
    return rows

def main():
    cmap = pd.read_csv(OUT / "call_deal_map.csv", dtype={"deal_id": str, "call_id": str}).set_index("call_id")
    cohort = pd.read_csv(COHORT, dtype=str).set_index("deal_id")
    assoc = pd.read_csv(DEAL_ASSOC, dtype=str).fillna("") if DEAL_ASSOC.exists() else pd.DataFrame(columns=["deal_id"])
    dterms = build_deal_terms(cohort, assoc)
    feats, pq, briefs = [], [], {}
    sel = set(pd.read_csv(OUT / "selected_calls.csv", dtype=str).call_id) if (OUT / "selected_calls.csv").exists() else None   # rule 4 applies to briefs too
    intro_only = set(cohort[cohort.highest_stage_idx.astype(int) == 1].index)   # rule 5: no Tier B for deals that never left Intro (selection only; never shown to coders)
    for mp in sorted(glob.glob(str(PREPARED / "*.meta.json"))):
        meta = json.loads(open(mp).read()); cid = meta["call_id"]; did = meta["deal_ref"]
        rows = parse(PREPARED / f"{cid}.txt")
        f = {"call_id": cid, "deal_id": did, "stage_at_call": meta["stage_at_call_per_crm"], "duration_min": meta["duration_minutes"], "transcript_empty": meta["transcript_empty"]}
        ext_tokens = [p for p in meta["participants"] if p.startswith("Prospect")]
        f["n_prospect_speakers_listed"] = len(ext_tokens)
        f["prospect_personas"] = ";".join(sorted({persona(re.sub(r"^Prospect-\d+ ?\[?|\]$", "", p)) for p in ext_tokens}))
        if rows:
            fin = [r for r in rows if r[1].startswith("Findigs")]; pro = [r for r in rows if r[1].startswith("Prospect")]
            chars_f = sum(len(r[2]) for r in fin); chars_p = sum(len(r[2]) for r in pro)
            f["talk_share_findigs_chars"] = chars_f / (chars_f + chars_p) if chars_f + chars_p else np.nan
            f["findigs_questions"] = sum(len(questions(r[2])) for r in fin); f["prospect_questions"] = sum(len(questions(r[2])) for r in pro)
            f["n_prospect_speakers_active"] = len({r[1] for r in pro})
            def first(rx, side=None):
                for r in rows:
                    if (side is None or r[1].startswith(side)) and rx.search(r[2]): return r
                return None
            fp = first(RXC["price"]); pp = first(RXC["pain"], "Prospect")
            f["price_mentioned"] = fp is not None
            f["price_first_minute"] = fp[0] if fp else np.nan
            f["price_first_by_findigs"] = (fp[1].startswith("Findigs")) if fp else np.nan
            f["prospect_pain_mentioned"] = pp is not None
            f["price_before_prospect_pain"] = (fp is not None) and (pp is None or fp[0] < pp[0])
            end = rows[-1][0] if rows else 0
            for k in ["contract_terms", "pilot", "friction_send_info", "friction_circle_back", "friction_defer"]:
                f[k] = any(RXC[k].search(r[2]) for r in rows)
            f["next_step_language_last_20pct"] = any(RXC["next_step"].search(r[2]) for r in rows if r[0] >= 0.8 * end)
            comps = {m.group(1).lower() for r in rows for m in COMP_RX.finditer(r[2])}
            f["competitors_named"] = ";".join(sorted(comps)); f["pms_named"] = any(c in [x.lower() for x in PMS] for c in comps)
            f["pms_bundled_screening_proxy"] = any(BUNDLED_RX.search(r[2]) for r in rows)
            for r in pro:
                for qtxt in questions(r[2]):
                    cat = next((k for k, rx in QCATC if rx.search(qtxt)), "other")
                    pq.append({"call_id": cid, "deal_id": did, "stage_at_call": f["stage_at_call"], "minute": round(r[0], 1), "category_guess": cat, "text_redacted": qtxt[:300]})
        cp = RAW / "calls_content" / f"{cid}.json"
        if cp.exists():
            c = json.loads(cp.read_text(encoding="utf-8")); content = c.get("content") or {}; inter = c.get("interaction") or {}
            q = inter.get("questions") or {}
            f["gong_questions_company"] = q.get("companyCount"); f["gong_questions_noncompany"] = q.get("nonCompanyCount")
            for st in inter.get("interactionStats") or []:
                f["gong_" + re.sub(r"\W+", "_", str(st.get("name", "")).lower()).strip("_")] = st.get("value")
            for t in content.get("trackers") or []:
                f["tracker_" + re.sub(r"\W+", "_", str(t.get("name", "")).lower()).strip("_")] = t.get("count")
            outcome = content.get("callOutcome") or {}
            f["gong_call_outcome"] = outcome.get("name") or outcome.get("category")
            brief = content.get("brief") or ""; kps = [k.get("text", "") for k in content.get("keyPoints") or []]
            hl = [i.get("text", "") for h in content.get("highlights") or [] for i in (h.get("items") or [])]
            f["has_gong_brief"] = bool(brief or kps)
            if (brief or kps or hl) and (sel is None or cid in sel) and did not in intro_only:
                red = make_redactor(dterms.get(did, set()))
                briefs.setdefault(did, []).append({"call_id": cid, "seq": int(cmap.loc[cid].call_seq) if cid in cmap.index else None,
                    "days_since_created": meta["days_since_deal_created"], "stage_at_call": f["stage_at_call"], "duration_min": f["duration_min"],
                    "gong_brief": red(brief)[0], "key_points": [red(k)[0] for k in kps][:15], "highlights": [red(h)[0] for h in hl][:15], "gong_call_outcome": f["gong_call_outcome"]})
        else:
            f["has_gong_brief"] = False
        feats.append(f)
    fdf = pd.DataFrame(feats); fdf.to_csv(OUT / "tierA_call_features.csv", index=False)
    pd.DataFrame(pq).to_csv(OUT / "tierA_prospect_questions.csv", index=False)
    (PREPARED / "briefs").mkdir(exist_ok=True)
    ins = cmap[cmap.in_scope.astype(str).str.lower() == "true"].reset_index().sort_values(["deal_id", "started"])
    ins["started"] = pd.to_datetime(ins.started); ins["gap_prev_in_scope"] = ins.groupby("deal_id").started.diff().dt.days
    gap_of = dict(zip(ins.call_id, ins.gap_prev_in_scope)); n_ins = ins.groupby("deal_id").size()
    for did, items in briefs.items():
        items.sort(key=lambda x: (x["seq"] or 0))
        for it in items:   # gap to the previous IN-SCOPE meeting (selected or not) -> real silence, not an artefact of the cap
            g = gap_of.get(it["call_id"]); it["days_since_previous_in_scope_meeting"] = None if g is None or pd.isna(g) else int(g)
        ctx = {k: cohort.loc[did, k] for k in ["segment", "units", "deal_source", "created_pre_migration"] if did in cohort.index}   # BLIND context
        (PREPARED / "briefs" / f"{did}.json").write_text(json.dumps({"deal_ref": did, "deal_context": ctx, "in_scope_meetings_total": int(n_ins.get(did, len(items))),
            "note": "Only the selected meetings (max 3, one per funnel stage) are shown; seq = position among all in-scope meetings.", "calls": items}, ensure_ascii=False, indent=1), encoding="utf-8")
    av = fdf.merge(cohort[["close_quarter"]], left_on="deal_id", right_index=True, how="left")
    av.groupby(["close_quarter", "stage_at_call"]).has_gong_brief.agg(["size", "mean"]).rename(columns={"size": "meetings", "mean": "share_with_brief"}).to_csv(OUT / "brief_availability.csv")
    print(f"[ok] Tier A features: {len(fdf)} calls; prospect questions extracted: {len(pq)}; deals with Gong briefs (Tier B input, Discovery+ deals only — rule 5): {len(briefs)}; "
          f"meetings with a brief: {fdf.has_gong_brief.mean():.0%}")

if __name__ == "__main__":
    main()
