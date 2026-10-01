"""Phase 1a: ONE bulk pass of lightweight call metadata (parties + CRM context; no content, no transcripts) for the full cohort window, month by month, resumable.
Output: data/raw/calls_extensive/YYYY-MM.jsonl (+ .done marker). Contains PII (party names/emails) — local only.
Usage: python src/01_pull_calls.py [--from 2023-04-01] [--to 2026-10-07]
"""
import argparse, json, datetime as dt
import pandas as pd
from gong_client import GongClient
from config import COHORT, RAW, WINDOW_BEFORE_CREATE, WINDOW_AFTER_CLOSE
from pull_spec import LIGHT_SELECTOR

def months(start, end):
    cur = dt.date(start.year, start.month, 1)
    while cur <= end:
        nxt = dt.date(cur.year + (cur.month == 12), cur.month % 12 + 1, 1)
        yield cur, min(nxt, end + dt.timedelta(days=1))
        cur = nxt

def main():
    c = pd.read_csv(COHORT, dtype=str)
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="fr", default=(pd.to_datetime(c.create_date).min() - pd.Timedelta(days=WINDOW_BEFORE_CREATE)).date().isoformat())
    ap.add_argument("--to", dest="to", default=(pd.to_datetime(c.close_date).max() + pd.Timedelta(days=WINDOW_AFTER_CLOSE)).date().isoformat())
    a = ap.parse_args()
    g = GongClient(); outdir = RAW / "calls_extensive"
    total = 0
    for m0, m1 in months(dt.date.fromisoformat(a.fr), dt.date.fromisoformat(a.to)):
        tag = m0.strftime("%Y-%m"); f = outdir / f"{tag}.jsonl"; done = outdir / f"{tag}.done"
        if done.exists():
            continue
        body = {"filter": {"fromDateTime": f"{m0}T00:00:00Z", "toDateTime": f"{m1}T00:00:00Z"}, "contentSelector": LIGHT_SELECTOR}
        n = 0
        with open(f, "w", encoding="utf-8") as fh:
            for call in g.paginate_post("/v2/calls/extensive", body, "calls"):
                fh.write(json.dumps(call, ensure_ascii=False) + "\n"); n += 1
        done.write_text(str(n)); total += n
        print(f"[{tag}] {n} calls")
    print(f"[ok] Pulled {total} new call records. Re-run is safe (completed months are skipped).")

if __name__ == "__main__":
    main()
