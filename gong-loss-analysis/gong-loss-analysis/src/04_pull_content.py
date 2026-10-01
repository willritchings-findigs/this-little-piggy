"""Phase 2a: ONE pass that fetches everything heavy for the in-scope calls — Gong content (brief, topics, trackers,
interaction stats) AND transcripts — in batches of up to 100 call IDs per request. Resumable per call.
In scope = matched meetings (external participant + duration >= MIN_MEETING_SECONDS), optionally narrowed by
data/outputs/scope_calls.csv (written at Checkpoint 1 if Will narrows scope).
Outputs: data/raw/calls_content/<call_id>.json, data/raw/transcripts/<call_id>.json (PII — local only).
Request cost ≈ 2 x ceil(in_scope_calls / 100) + pagination. Check printed estimate before it runs.
"""
import argparse, json, math
import pandas as pd
from gong_client import GongClient
from config import OUT, RAW
from pull_spec import CONTENT_SELECTOR

BATCH = 100

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--limit", type=int); ap.add_argument("--yes", action="store_true"); a = ap.parse_args()
    (RAW / "calls_content").mkdir(exist_ok=True)
    m = pd.read_csv(OUT / "call_deal_map.csv", dtype={"deal_id": str, "call_id": str})
    m = m[m.is_meeting.astype(str).str.lower() == "true"]
    sc = OUT / "scope_calls.csv"
    if sc.exists(): m = m[m.call_id.isin(pd.read_csv(sc, dtype=str).call_id)]
    ids = sorted(m.call_id.unique())
    need_c = [c for c in ids if not (RAW / "calls_content" / f"{c}.json").exists()]
    need_t = [c for c in ids if not (RAW / "transcripts" / f"{c}.json").exists()]
    if a.limit: need_c, need_t = need_c[: a.limit], need_t[: a.limit]
    est = math.ceil(len(need_c) / BATCH) + math.ceil(len(need_t) / BATCH)
    print(f"[info] in-scope meetings: {len(ids)}; to fetch — content: {len(need_c)}, transcripts: {len(need_t)}; ≈{est} Gong requests (+pagination)")
    if not (need_c or need_t): return
    if not a.yes and input("Proceed? [y/N] ").strip().lower() != "y": return
    g = GongClient()
    for i in range(0, len(need_c), BATCH):
        b = need_c[i:i + BATCH]
        for c in g.paginate_post("/v2/calls/extensive", {"filter": {"callIds": b}, "contentSelector": CONTENT_SELECTOR}, "calls"):
            cid = str(c["metaData"]["id"]); (RAW / "calls_content" / f"{cid}.json").write_text(json.dumps(c, ensure_ascii=False), encoding="utf-8")
        for cid in b:
            p = RAW / "calls_content" / f"{cid}.json"
            if not p.exists(): p.write_text(json.dumps({"metaData": {"id": cid}, "_empty": True}))
    for i in range(0, len(need_t), BATCH):
        b = need_t[i:i + BATCH]
        for t in g.paginate_post("/v2/calls/transcript", {"filter": {"callIds": b}}, "callTranscripts"):
            (RAW / "transcripts" / f"{t['callId']}.json").write_text(json.dumps(t, ensure_ascii=False), encoding="utf-8")
        for cid in b:
            p = RAW / "transcripts" / f"{cid}.json"
            if not p.exists(): p.write_text(json.dumps({"callId": cid, "transcript": [], "_empty": True}))
    print("[ok] content + transcripts fetched (unavailable items recorded as _empty, never silently dropped)")

if __name__ == "__main__":
    main()
