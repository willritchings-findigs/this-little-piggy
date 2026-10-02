"""Work-packet manager for agent-mode coding (Claude Code subagents; no API key needed).
Kinds (run in this order):
  calibration  Tier C calibration calls, primary pass            -> data/coded/calls        (agent: call-coder)
  reliability  same calls, independent second pass               -> data/coded/reliability  (agent: call-coder, independent mode)
  briefs       Tier B: every covered deal with Gong briefs       -> data/coded/briefs       (agent: brief-coder)
  calls        Tier C: remaining sample calls                    -> data/coded/calls        (agent: call-coder)
  deals        Tier C: deal synthesis for sample deals whose selected calls are all coded -> data/coded/deals (agent: deal-synthesizer)
Commands:
  python src/10_agent_packets.py --build <kind>      (re)build packets for items not yet done under the CURRENT prompt version
  python src/10_agent_packets.py --next <kind> 4     print the next 4 undone packet paths (dispatch one subagent per path)
  python src/10_agent_packets.py --status            progress for every kind (done / remaining items and packets)
Packets live in data/work/<kind>/packet_NNN.json; subagents stage raw output in data/work/<kind>/staging/ and run validate_coding.py.
"""
import argparse, json, re, glob, shutil
from pathlib import Path
import pandas as pd
from config import ROOT, PREPARED, CODED, OUT, PROMPTS, DATA

WORK = DATA / "work"
CALL_TOKEN_BUDGET = 45000      # transcript tokens per call-coding packet (keeps each subagent context comfortably small)
MAX_CALLS = 8; BRIEFS_PER_PACKET = 20; DEALS_PER_PACKET = 12

def pv(fname): return re.search(r"prompt_version:\s*(\S+)", (PROMPTS / fname).read_text(encoding="utf-8")).group(1)
SPEC = {
 "calibration": dict(prompt="prompts/call_coding_prompt.md", schema="schema/call_coding_schema.json", out="data/coded/calls", agent="call-coder", mode="primary"),
 "reliability": dict(prompt="prompts/call_coding_prompt.md", schema="schema/call_coding_schema.json", out="data/coded/reliability", agent="call-coder", mode="independent"),
 "calls":       dict(prompt="prompts/call_coding_prompt.md", schema="schema/call_coding_schema.json", out="data/coded/calls", agent="call-coder", mode="primary"),
 "briefs":      dict(prompt="prompts/deal_brief_prompt.md", schema="schema/deal_brief_schema.json", out="data/coded/briefs", agent="brief-coder", mode="primary"),
 "deals":       dict(prompt="prompts/deal_synthesis_prompt.md", schema="schema/deal_synthesis_schema.json", out="data/coded/deals", agent="deal-synthesizer", mode="primary"),
}

def done(kind, iid):
    f = ROOT / SPEC[kind]["out"] / f"{iid}.json"
    if not f.exists(): return False
    try: return json.loads(f.read_text(encoding="utf-8")).get("prompt_version") == pv(Path(SPEC[kind]["prompt"]).name)
    except Exception: return False

def items_for(kind):
    if kind in ("calibration", "reliability"):
        cal = pd.read_csv(OUT / "calibration_calls.csv", dtype=str)
        return [{"id": r.call_id, "deal_id": r.deal_id, "input_files": [f"data/prepared/{r.call_id}.meta.json", f"data/prepared/{r.call_id}.txt"]} for r in cal.itertuples()]
    if kind == "calls":
        tc = pd.read_csv(OUT / "tierC_calls.csv", dtype=str); cal = set(pd.read_csv(OUT / "calibration_calls.csv", dtype=str).call_id)
        return [{"id": r.call_id, "deal_id": r.deal_id, "input_files": [f"data/prepared/{r.call_id}.meta.json", f"data/prepared/{r.call_id}.txt"]} for r in tc.itertuples() if r.call_id not in cal]
    if kind == "briefs":
        return [{"id": Path(p).stem, "input_files": [str(Path(p).relative_to(ROOT)).replace("\\", "/")]} for p in sorted(glob.glob(str(PREPARED / "briefs" / "*.json")))]
    if kind == "deals":
        tc = pd.read_csv(OUT / "tierC_calls.csv", dtype=str); m = pd.read_csv(OUT / "call_deal_map.csv", dtype={"deal_id": str, "call_id": str}).set_index("call_id")
        inp = WORK / "deals" / "inputs"; inp.mkdir(parents=True, exist_ok=True); out = []; incomplete = 0
        ins = m[m.in_scope.astype(str).str.lower() == "true"].reset_index().sort_values(["deal_id", "started"]); ins["started"] = pd.to_datetime(ins.started)
        ins["g"] = ins.groupby("deal_id").started.diff().dt.days; gap_of = {k: (None if pd.isna(v) else int(v)) for k, v in zip(ins.call_id, ins.g)}
        for d, g in tc.groupby("deal_id"):
            if not all(done("calls", c) for c in g.call_id): incomplete += 1; continue
            rows = []
            for c in g.call_id:
                r = m.loc[c]; cod = json.loads((CODED / "calls" / f"{c}.json").read_text(encoding="utf-8"))["coding"]
                if "_skipped" in cod: continue
                rows.append({"call_id": c, "seq": int(r.call_seq), "started": r.started, "days_since_created": None if pd.isna(r.days_from_create) else int(r.days_from_create),
                             "stage_at_call": r.stage_at_call, "duration_min": round((r.duration_s or 0) / 60, 1), "coding": cod})
            rows.sort(key=lambda x: x["started"])
            for x in rows:   # gap to the previous IN-SCOPE meeting (coded or not) -> real silence, not an artefact of the 3-call cap
                x["days_since_previous_in_scope_meeting"] = gap_of.get(x.pop("call_id"))
                x.pop("started")
            ctx = json.loads((PREPARED / "briefs" / f"{d}.json").read_text())["deal_context"] if (PREPARED / "briefs" / f"{d}.json").exists() else {}
            (inp / f"{d}.json").write_text(json.dumps({"deal_ref": d, "deal_context": ctx, "in_scope_meetings_total": int(g.meetings_available.iloc[0]),
                "note": "Only the selected meetings (max 3, one per funnel stage) are shown; seq = position among all in-scope meetings.", "calls": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
            out.append({"id": d, "calls_used": len(rows), "input_files": [f"data/work/deals/inputs/{d}.json"]})
        if incomplete: print(f"[info] {incomplete} sample deals skipped: not all of their Tier C calls are coded yet")
        return out

def chunk(kind, items):
    if kind in ("briefs",): return [items[i:i + BRIEFS_PER_PACKET] for i in range(0, len(items), BRIEFS_PER_PACKET)]
    if kind == "deals": return [items[i:i + DEALS_PER_PACKET] for i in range(0, len(items), DEALS_PER_PACKET)]
    packs, cur, tok = [], [], 0
    for it in items:
        t = (ROOT / it["input_files"][1]).stat().st_size / 4
        if cur and (tok + t > CALL_TOKEN_BUDGET or len(cur) >= MAX_CALLS): packs.append(cur); cur, tok = [], 0
        cur.append(it); tok += t
    if cur: packs.append(cur)
    return packs

def build(kind):
    s = SPEC[kind]; d = WORK / kind; d.mkdir(parents=True, exist_ok=True)
    for f in d.glob("packet_*.json"): f.unlink()                     # packets are cheap to regenerate; staging is kept
    (d / "staging").mkdir(exist_ok=True)
    todo = [it for it in items_for(kind) if not done(kind, it["id"])]
    packs = chunk(kind, todo)
    for i, p in enumerate(packs, 1):
        pk = {"packet_id": f"{kind}_{i:03d}", "kind": kind, "agent": s["agent"], "mode": s["mode"], "prompt_file": s["prompt"], "schema_file": s["schema"],
              "prompt_version": pv(Path(s["prompt"]).name), "staging_dir": f"data/work/{kind}/staging", "output_dir": s["out"], "items": p}
        (d / f"packet_{i:03d}.json").write_text(json.dumps(pk, indent=1))
    print(f"[ok] {kind}: {len(todo)} items to do in {len(packs)} packets (prompt {pv(Path(s['prompt']).name)}) -> data/work/{kind}/")

def packet_done(pk): return all(done(pk["kind"], it["id"]) for it in pk["items"])

def nxt(kind, n):
    ps = [p for p in sorted((WORK / kind).glob("packet_*.json")) if not packet_done(json.loads(p.read_text()))]
    for p in ps[:n]: print(str(p.relative_to(ROOT)).replace("\\", "/"))
    if not ps: print(f"[done] no undone {kind} packets")

def status():
    for kind in SPEC:
        d = WORK / kind
        try:
            if kind == "deals":
                total = pd.read_csv(OUT / "tierC_sample_deals.csv", dtype=str).deal_id.tolist()
            else:
                total = [it["id"] for it in items_for(kind)]
        except FileNotFoundError:
            print(f"{kind:12s} inputs not ready"); continue
        nd = sum(done(kind, i) for i in total)
        pks = [json.loads(p.read_text()) for p in sorted(d.glob("packet_*.json"))] if d.exists() else []
        left = sum(not packet_done(pk) for pk in pks)
        print(f"{kind:12s} items {nd}/{len(total)} done; undone packets queued: {left}" + ("" if d.exists() else " (not built)"))

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--build", choices=list(SPEC)); ap.add_argument("--next", nargs=2, metavar=("KIND", "N")); ap.add_argument("--status", action="store_true")
    a = ap.parse_args()
    if a.build: build(a.build)
    if a.next: nxt(a.next[0], int(a.next[1]))
    if a.status: status()
