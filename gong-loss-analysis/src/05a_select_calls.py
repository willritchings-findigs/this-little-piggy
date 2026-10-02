"""Phase 2c — scope rule 4: choose at most MAX_CALLS_PER_DEAL calls per deal for LLM reading (Tier B briefs + Tier C transcripts).
Per deal, among in-scope meetings with a non-empty prepared transcript:
  1. one RANDOM call from each funnel section the deal reached at call time (TOFU = Intro; MOFU = Discovery/Business Case; BOFU = Negotiation/Trial)
  2. OPTIONAL (--fill): if the deal reached < 3 sections, fill RANDOMLY up to the cap from its remaining calls.
     Default is NO fill (one call per section reached) — the fewest tokens; fill adds depth for deals that stalled early.
Seeded per deal (stable across re-runs). Tier A (no LLM) still uses ALL in-scope calls; 09_analyze measures the effect of the cap.
Output: data/outputs/selected_calls.csv
"""
import argparse, json, hashlib
import numpy as np, pandas as pd
from config import OUT, PREPARED, MAX_CALLS_PER_DEAL

ORDER = {"TOFU": 0, "MOFU": 1, "BOFU": 2}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--fill", action="store_true"); ap.add_argument("--cap", type=int, default=MAX_CALLS_PER_DEAL); a = ap.parse_args()
    m = pd.read_csv(OUT / "call_deal_map.csv", dtype={"deal_id": str, "call_id": str})
    m = m[m.in_scope.astype(str).str.lower() == "true"]
    ok = {p.name.replace(".meta.json", "") for p in PREPARED.glob("*.meta.json") if not json.loads(p.read_text()).get("transcript_empty")}
    m = m[m.call_id.isin(ok)]
    rows = []
    for d, g in m.groupby("deal_id"):
        rng = np.random.default_rng(int(hashlib.sha256(d.encode()).hexdigest()[:8], 16))
        picked = []
        for sec, gs in sorted(g.groupby("funnel_section_at_call"), key=lambda x: ORDER.get(x[0], 9)):
            if len(picked) >= a.cap: break
            picked.append((gs.call_id.iloc[int(rng.integers(len(gs)))], sec, "section_pick"))
        if a.fill:
            rest = [c for c in g.call_id if c not in {p[0] for p in picked}]
            rng.shuffle(rest)
            for c in rest[: max(0, a.cap - len(picked))]:
                picked.append((c, g.set_index("call_id").loc[c, "funnel_section_at_call"], "fill"))
        for c, sec, why in picked:
            rows.append({"deal_id": d, "call_id": c, "funnel_section": sec, "selection": why, "in_scope_meetings_available": len(g),
                         "sections_available": g.funnel_section_at_call.nunique()})
    s = pd.DataFrame(rows); s.to_csv(OUT / "selected_calls.csv", index=False)
    print(f"[ok] selected {len(s)} calls for {s.deal_id.nunique()} deals (cap {a.cap}; from {len(m)} in-scope meetings with transcripts) — "
          f"{len(s)/max(1,len(m)):.0%} of in-scope meetings; by section: {s.funnel_section.value_counts().to_dict()}; fills: {int((s.selection=='fill').sum())}")

if __name__ == "__main__":
    main()
