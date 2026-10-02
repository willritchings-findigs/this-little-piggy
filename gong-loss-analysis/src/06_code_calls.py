"""Blind LLM coding of prepared meeting transcripts. A coding counts as done only if made under the CURRENT prompt_version,
so a prompt edit automatically re-queues stale codings (no manual deletes, no double work).
Usage:
  python src/06_code_calls.py --dry-run                         # counts + token estimate, no API calls
  python src/06_code_calls.py --calibration 60 --yes            # Phase 3: fixed stratified sample, coded by BOTH models (sync)
  python src/06_code_calls.py --all --batch --yes               # Phase 4: everything else via Message Batches API
  python src/06_code_calls.py --collect                         # Phase 4: retrieve batch results (+ sync retry of failures)
  python src/06_code_calls.py --all --yes [--workers 4]         # sync alternative to --batch
"""
import argparse, json, re, glob, datetime as dt
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import pandas as pd
from config import PREPARED, CODED, OUT, SCHEMA, PROMPTS, ANTHROPIC_MODEL, ANTHROPIC_RELIABILITY_MODEL, COHORT
from llm import split_template, build_params, call_tool, submit_batch, collect_batch

SCHEMA_CALL = json.loads((SCHEMA / "call_coding_schema.json").read_text())
TEMPLATE = (PROMPTS / "call_coding_prompt.md").read_text(encoding="utf-8")
PROMPT_VERSION = re.search(r"prompt_version:\s*(\S+)", TEMPLATE).group(1)
ICP_RAW = (PROMPTS / "icp_persona_context.md").read_text(encoding="utf-8")
ICP = re.sub(r"<!--.*?-->", "", ICP_RAW, flags=re.S).strip()
def require_icp():
    if "PHASE 0 TODO" in ICP_RAW or not ICP:
        raise SystemExit("prompts/icp_persona_context.md is still the Phase 0 TODO — fill it from Notion before any coding.")
STATIC, USER_T = split_template(TEMPLATE.replace("{{ICP_PERSONA_CONTEXT}}", ICP))
CAL_FILE = OUT / "calibration_calls.csv"

def prepared_ids():
    return sorted(Path(p).name.replace(".meta.json", "") for p in glob.glob(str(PREPARED / "*.meta.json")))

def is_current(out_dir, cid):
    f = out_dir / f"{cid}.json"
    if not f.exists(): return False
    try: return json.loads(f.read_text(encoding="utf-8")).get("prompt_version") == PROMPT_VERSION
    except Exception: return False

def user_text(cid):
    meta = json.loads((PREPARED / f"{cid}.meta.json").read_text())
    tx = (PREPARED / f"{cid}.txt").read_text(encoding="utf-8")
    view = {k: v for k, v in meta.items() if k != "deal_ref"}
    return USER_T.replace("{{CALL_METADATA}}", json.dumps(view)).replace("{{TRANSCRIPT}}", tx), meta

def write(out_dir, cid, meta, model, coding, usage):
    rec = {"call_id": cid, "deal_id": meta["deal_ref"], "prompt_version": PROMPT_VERSION, "model": model,
           "coded_at": dt.datetime.utcnow().isoformat() + "Z", "usage": usage, "coding": coding}
    (out_dir / f"{cid}.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")

def code_sync(cid, model, out_dir):
    ut, meta = user_text(cid)
    if meta.get("transcript_empty"):
        return write(out_dir, cid, meta, model, {"_skipped": "empty_transcript"}, {})
    coding, usage = call_tool(build_params(STATIC, ut, SCHEMA_CALL, "record_call_coding", model), SCHEMA_CALL)
    write(out_dir, cid, meta, model, coding, usage)

def calibration_sample(n):
    if CAL_FILE.exists():   # fixed across prompt iterations so before/after comparisons are like-for-like
        return list(pd.read_csv(CAL_FILE, dtype=str).call_id)
    m = pd.read_csv(OUT / "call_deal_map.csv", dtype={"deal_id": str, "call_id": str})
    m = m[m.call_id.isin(prepared_ids())].merge(pd.read_csv(COHORT, dtype=str)[["deal_id", "outcome", "segment"]], on="deal_id")
    m = m.drop_duplicates("deal_id")   # one call per deal -> more deal diversity
    m["stratum"] = m.outcome + "|" + m.stage_at_call + "|" + m.segment
    per = max(1, n // max(1, m.stratum.nunique()))
    s = pd.concat([g.sample(min(len(g), per), random_state=7) for _, g in m.groupby("stratum")])
    if len(s) < n: s = pd.concat([s, m[~m.call_id.isin(s.call_id)].sample(min(n - len(s), len(m) - len(s)), random_state=7)])
    s = s.head(n); s[["call_id", "deal_id", "stratum"]].to_csv(CAL_FILE, index=False)
    return list(s.call_id)

def run_sync(ids, model, out_dir, workers):
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(code_sync, i, model, out_dir): i for i in ids}
        for f in as_completed(futs):
            try:
                f.result(); done += 1
                if done % 25 == 0: print(f"  coded {done}/{len(ids)}")
            except Exception as e: print(f"[error] {futs[f]}: {e}")
    print(f"[ok] coded {done}/{len(ids)} -> {out_dir}")

def main():
    ap = argparse.ArgumentParser()
    for f in ["--dry-run", "--all", "--batch", "--collect", "--yes"]: ap.add_argument(f, action="store_true")
    ap.add_argument("--calibration", type=int); ap.add_argument("--call-ids-file"); ap.add_argument("--model", default=ANTHROPIC_MODEL)
    ap.add_argument("--out-dir", default=str(CODED / "calls")); ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args(); out_dir = Path(a.out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    tag = f"calls_{PROMPT_VERSION}"
    if not a.dry_run: require_icp()
    assert "{{" not in STATIC, "unfilled placeholder in static prompt"
    if a.collect:
        def on_result(cid, coding, usage):
            _, meta = user_text(cid); write(out_dir, cid, meta, a.model, coding, usage)
        failed = collect_batch(tag, SCHEMA_CALL, on_result)
        if failed: run_sync(failed, a.model, out_dir, a.workers)
        return
    if a.calibration:
        ids = calibration_sample(a.calibration)
        todo1 = [i for i in ids if not is_current(CODED / "calls", i)]; todo2 = [i for i in ids if not is_current(CODED / "reliability", i)]
        print(f"[info] calibration set {len(ids)} calls; primary to code {len(todo1)}, second-model to code {len(todo2)} (prompt {PROMPT_VERSION})")
        if not a.yes and input("Proceed? [y/N] ").strip().lower() != "y": return
        run_sync(todo1, ANTHROPIC_MODEL, CODED / "calls", a.workers); run_sync(todo2, ANTHROPIC_RELIABILITY_MODEL, CODED / "reliability", a.workers)
        return
    ids = list(pd.read_csv(a.call_ids_file, dtype=str).call_id) if a.call_ids_file else prepared_ids()
    todo = [i for i in ids if not is_current(out_dir, i)]
    chars = sum(len(user_text(i)[0]) for i in todo)
    print(f"[info] calls to code: {len(todo)} (prompt {PROMPT_VERSION}, model {a.model}). Per-call variable input ≈ {chars/4/max(1,len(todo)):,.0f} tokens; "
          f"total variable ≈ {chars/4:,.0f} tokens + cached static ≈ {len(STATIC)/4:,.0f} tokens/call + output ~2-4k tokens/call")
    if a.dry_run or not (a.all or a.call_ids_file): return
    if not a.yes and input("Proceed? [y/N] ").strip().lower() != "y": return
    if a.batch:
        reqs, empties = [], 0
        for cid in todo:
            ut, meta = user_text(cid)
            if meta.get("transcript_empty"):
                write(out_dir, cid, meta, a.model, {"_skipped": "empty_transcript"}, {}); empties += 1; continue
            reqs.append((cid, build_params(STATIC, ut, SCHEMA_CALL, "record_call_coding", a.model)))
        print(f"[info] empties recorded: {empties}"); submit_batch(tag, reqs)
        print("[next] run: python src/06_code_calls.py --collect   (safe to re-run; polls until batches end)")
    else:
        run_sync(todo, a.model, out_dir, a.workers)

if __name__ == "__main__":
    main()
