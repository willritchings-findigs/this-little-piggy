"""Deal-level synthesis from ordered call codings — BLIND to outcome, CRM reason, loss notes, close date, highest stage.
Version-aware like 06 (re-queues only stale syntheses). Run AFTER all call codings are collected.
Usage: python src/07_synthesize_deals.py --batch --yes   then   python src/07_synthesize_deals.py --collect
       python src/07_synthesize_deals.py --yes            (sync alternative)
"""
import argparse, json, re, glob, datetime as dt
from concurrent.futures import ThreadPoolExecutor, as_completed
import pandas as pd
from config import CODED, OUT, SCHEMA, PROMPTS, ANTHROPIC_MODEL, COHORT
from llm import split_template, build_params, call_tool, submit_batch, collect_batch

SCHEMA_DEAL = json.loads((SCHEMA / "deal_synthesis_schema.json").read_text())
TEMPLATE = (PROMPTS / "deal_synthesis_prompt.md").read_text(encoding="utf-8")
PROMPT_VERSION = re.search(r"prompt_version:\s*(\S+)", TEMPLATE).group(1)
STATIC, USER_T = split_template(TEMPLATE)
GAP = {}
BLIND_CONTEXT_FIELDS = ["segment", "units", "deal_source", "created_pre_migration"]   # NO outcome / reason / notes / close date / highest stage

def load():
    m = pd.read_csv(OUT / "call_deal_map.csv", dtype={"deal_id": str, "call_id": str}); m["started"] = pd.to_datetime(m.started)
    codes = {}
    for f in glob.glob(str(CODED / "calls" / "*.json")):
        r = json.loads(open(f, encoding="utf-8").read())
        if "_skipped" not in r["coding"]: codes[r["call_id"]] = r
    global GAP
    ins = m[m.in_scope.astype(str).str.lower() == "true"].sort_values(["deal_id", "started"]); GAP = dict(zip(ins.call_id, ins.groupby("deal_id").started.diff().dt.days))
    return m[m.call_id.isin(codes)].sort_values(["deal_id", "started"]), codes

def user_text(d, m, codes, cohort):
    g = m[m.deal_id == d].copy(); g["gap"] = g.call_id.map(GAP)
    items = [{"seq": int(r.call_seq), "days_since_created": None if pd.isna(r.days_from_create) else int(r.days_from_create),
              "days_since_previous_in_scope_meeting": None if pd.isna(r.gap) else int(r.gap), "stage_at_call": r.stage_at_call,
              "duration_min": round((r.duration_s or 0) / 60, 1), "coding": codes[r.call_id]["coding"]} for _, r in g.iterrows()]
    ctx = {k: cohort.loc[d, k] for k in BLIND_CONTEXT_FIELDS if d in cohort.index}
    return USER_T.replace("{{DEAL_CONTEXT}}", json.dumps(ctx)).replace("{{CALL_CODINGS}}", json.dumps(items, ensure_ascii=False)), len(items)

def is_current(d):
    f = CODED / "deals" / f"{d}.json"
    return f.exists() and json.loads(f.read_text(encoding="utf-8")).get("prompt_version") == PROMPT_VERSION

def write(d, n, res, usage):
    (CODED / "deals" / f"{d}.json").write_text(json.dumps({"deal_id": d, "prompt_version": PROMPT_VERSION, "model": ANTHROPIC_MODEL,
        "calls_used": n, "coded_at": dt.datetime.utcnow().isoformat() + "Z", "usage": usage, "synthesis": res}, ensure_ascii=False, indent=1), encoding="utf-8")

def main():
    ap = argparse.ArgumentParser()
    for f in ["--batch", "--collect", "--yes"]: ap.add_argument(f, action="store_true")
    ap.add_argument("--workers", type=int, default=4); a = ap.parse_args()
    m, codes = load(); cohort = pd.read_csv(COHORT, dtype=str).set_index("deal_id"); tag = f"deals_{PROMPT_VERSION}"
    if a.collect:
        failed = collect_batch(tag, SCHEMA_DEAL, lambda d, res, u: write(d, user_text(d, m, codes, cohort)[1], res, u))
        for d in failed:
            ut, n = user_text(d, m, codes, cohort); res, u = call_tool(build_params(STATIC, ut, SCHEMA_DEAL, "record_deal_synthesis", ANTHROPIC_MODEL, 4000), SCHEMA_DEAL); write(d, n, res, u)
        return
    deals = [d for d in sorted(m.deal_id.unique()) if not is_current(d)]
    print(f"[info] deals to synthesise: {len(deals)} (prompt {PROMPT_VERSION})")
    if not deals or (not a.yes and input("Proceed? [y/N] ").strip().lower() != "y"): return
    if a.batch:
        submit_batch(tag, [(d, build_params(STATIC, user_text(d, m, codes, cohort)[0], SCHEMA_DEAL, "record_deal_synthesis", ANTHROPIC_MODEL, 4000)) for d in deals])
        print("[next] run: python src/07_synthesize_deals.py --collect"); return
    def one(d):
        ut, n = user_text(d, m, codes, cohort)
        res, u = call_tool(build_params(STATIC, ut, SCHEMA_DEAL, "record_deal_synthesis", ANTHROPIC_MODEL, 4000), SCHEMA_DEAL); write(d, n, res, u)
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(one, d): d for d in deals}
        for f in as_completed(futs):
            try: f.result()
            except Exception as e: print(f"[error] {futs[f]}: {e}")
    print("[ok] deal synthesis complete")

if __name__ == "__main__":
    main()
