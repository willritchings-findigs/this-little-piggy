"""Phase 3 (CALIBRATION, before any production coding): reliability of the coding on a fixed stratified sample.
Two independent codings (primary vs second model, produced by 06_code_calls.py --calibration) + Will's human review.
Only codings made under the CURRENT prompt_version are scored, so iterating the prompt never mixes versions.
Usage:
  python src/08_reliability_check.py --packet   # human review packet for 20 calibration calls -> data/outputs/human_review_packet.csv
  python src/08_reliability_check.py --score    # data/outputs/field_reliability.csv + reports/02_reliability.md
Gate: kappa >= 0.60 reportable; 0.40–0.59 directional; < 0.40 -> revise prompt, bump version, re-run calibration ONLY (60 calls), re-score.
Production coding (Phase 4) starts only after the gate is accepted, so a failed field never forces a full recode.
"""
import argparse, json, glob
import pandas as pd
import re
from config import CODED, OUT, REPORTS, COHORT, PROMPTS
PV = re.search(r"prompt_version:\s*(\S+)", (PROMPTS / "call_coding_prompt.md").read_text(encoding="utf-8")).group(1)
from stats_utils import cohen_kappa

FIELDS = {  # field -> extractor
 "call_type": lambda c: c["call_type"], "meeting_occurred": lambda c: c["meeting_occurred"],
 "pain.status": lambda c: c["pain"]["status"], "pain.who_articulated": lambda c: c["pain"]["who_articulated"],
 "compelling_event.status": lambda c: c["compelling_event"]["status"],
 "price.first_raised_by": lambda c: c["price"]["first_raised_by"], "price.pain_established_before_price": lambda c: c["price"]["pain_established_before_price"],
 "price.reaction": lambda c: c["price"]["reaction"], "next_step.status": lambda c: c["next_step"]["status"], "momentum": lambda c: c["momentum"],
 "reception.overall_sentiment": lambda c: c["reception"]["overall_sentiment"],
 "discovery_depth_band": lambda c: "0-1" if c["discovery_depth_score"] <= 1 else ("2-3" if c["discovery_depth_score"] <= 3 else "4-5"),
 "any_decision_maker_present": lambda c: any(a["decision_authority"] in ("economic_buyer", "decision_maker") for a in c["external_attendees"]),
 "meddpicc.identify_pain": lambda c: c["meddpicc"]["identify_pain"]["status"], "meddpicc.economic_buyer": lambda c: c["meddpicc"]["economic_buyer"]["status"],
 "meddpicc.decision_process": lambda c: c["meddpicc"]["decision_process"]["status"], "meddpicc.metrics": lambda c: c["meddpicc"]["metrics"]["status"],
}
SETS = {"objection_categories": lambda c: {o["category"] for o in c["objections"]},
        "competitors": lambda c: {x["name"].strip().lower() for x in c["competitors_mentioned"]},
        "prospect_question_categories": lambda c: {q["category"] for q in c["prospect_questions"]}}

def load(d):
    out = {}
    for f in glob.glob(str(d / "*.json")):
        r = json.loads(open(f, encoding="utf-8").read())
        if "_skipped" not in r["coding"] and r.get("prompt_version") == PV: out[r["call_id"]] = r["coding"]
    return out

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--packet", action="store_true"); ap.add_argument("--score", action="store_true"); a = ap.parse_args()
    prim = load(CODED / "calls")
    if a.packet:
        cal = pd.read_csv(OUT / "calibration_calls.csv", dtype=str)
        hp = [c for c in cal.call_id if c in prim][:20]
        rows = []
        for cid in hp:
            c = prim[cid]
            for f, ex in FIELDS.items():
                rows.append({"call_id": cid, "field": f, "coded_value": ex(c), "reviewer_agrees (Y/N)": "", "reviewer_value_if_N": "", "note": ""})
        pd.DataFrame(rows).to_csv(OUT / "human_review_packet.csv", index=False)
        print(f"[ok] human review packet: {len(hp)} calls x {len(FIELDS)} fields -> data/outputs/human_review_packet.csv (review against data/prepared/<call_id>.txt)")
    if a.score:
        sec = load(CODED / "reliability"); ids = [i for i in sec if i in prim]
        res = []
        for f, ex in FIELDS.items():
            a1 = [str(ex(prim[i])) for i in ids]; a2 = [str(ex(sec[i])) for i in ids]
            k = cohen_kappa(a1, a2); agree = sum(x == y for x, y in zip(a1, a2)) / len(ids) if ids else float("nan")
            res.append({"field": f, "n": len(ids), "pct_agree": agree, "kappa": k, "gate": "reportable" if k >= 0.6 else ("directional" if k >= 0.4 else "excluded")})
        for f, ex in SETS.items():
            j = [len(ex(prim[i]) & ex(sec[i])) / len(ex(prim[i]) | ex(sec[i])) if (ex(prim[i]) | ex(sec[i])) else 1.0 for i in ids]
            mj = sum(j) / len(j) if j else float("nan")
            res.append({"field": f, "n": len(ids), "pct_agree": mj, "kappa": None, "gate": "reportable" if mj >= 0.6 else ("directional" if mj >= 0.4 else "excluded")})
        r = pd.DataFrame(res); r.to_csv(OUT / "field_reliability.csv", index=False)
        hp = OUT / "human_review_packet.csv"; human = ""
        if hp.exists():
            h = pd.read_csv(hp).fillna("")
            g = h[h["reviewer_agrees (Y/N)"].str.upper().isin(["Y", "N"])]
            if len(g):
                hs = g.groupby("field")["reviewer_agrees (Y/N)"].apply(lambda s: (s.str.upper() == "Y").mean()).rename("human_agree").reset_index()
                human = "\n## Human review agreement\n\n" + hs.to_markdown(index=False, floatfmt=".2f")
        (REPORTS / "02_reliability.md").write_text("# Coding reliability\n\n" + f"Calls double-coded: {len(ids)}\n\n" + r.to_markdown(index=False, floatfmt=".2f") + human +
            f"\n\nPrompt version scored: {PV}.\nGate rule: kappa ≥ 0.60 reportable; 0.40–0.59 directional; < 0.40 → revise prompt, bump version, re-run calibration only.\n\n## CHECKPOINT 3 — Will accepts the gate before production coding.\n", encoding="utf-8")
        print(r.to_string(index=False))

if __name__ == "__main__":
    main()
