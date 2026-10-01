"""OFFLINE SMOKE TEST ONLY. Generates synthetic Gong payloads + random schema-valid codings so the pipeline
(02,03,05,08,09) can be exercised without API access. Run from a throwaway copy of the project:
    python tests/make_mock_data.py && python src/02_match_calls.py && python src/03_coverage_report.py && ...
Never run inside a project folder that holds real data."""
import json, random, sys
from pathlib import Path
import pandas as pd, jsonschema
ROOT = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(ROOT / "src"))
from config import RAW, PREPARED, CODED, OUT, COHORT, ROSTER, DEAL_ASSOC, SCHEMA
random.seed(3)
def gen(s):
    if "enum" in s: return random.choice(s["enum"])
    t = s.get("type")
    if isinstance(t, list): t = random.choice([x for x in t if x != "null"]) if random.random() < .8 else "null"
    if t == "object": return {k: gen(v) for k, v in s["properties"].items()}
    if t == "array": return [gen(s["items"]) for _ in range(random.randint(0, min(3, s.get("maxItems", 3))))]
    if t == "string": return "mock"
    if t == "integer": return random.randint(s.get("minimum", 0), s.get("maximum", 5))
    if t == "number": return round(random.uniform(0, 30), 1)
    if t == "boolean": return random.random() < .5
    return None
def main():
    c = pd.read_csv(COHORT, dtype=str)
    ro = pd.read_csv(ROSTER, dtype=str).fillna(""); ro["gong_user_id"] = [str(1000 + i) for i in range(len(ro))]; ro.to_csv(ROSTER, index=False)
    (RAW / "internal_domains.json").write_text(json.dumps(["findigs.com"]))
    assoc, by_month = [], {}
    for i, r in c.iterrows():
        assoc.append({"deal_id": r.deal_id, "legacy_sf_opportunity_id": "", "company_ids": f"co{i}", "company_domains": f"pmc{i}.com", "company_names": f"Acme Residential {i}", "contact_emails": f"buyer@pmc{i}.com", "contact_names": "Pat Buyer"})
        p = 0.35 + 0.12 * int(r.highest_stage_idx)
        if random.random() > p: continue
        s0, s1 = pd.Timestamp(r.create_date), pd.Timestamp(r.close_date)
        for k in range(random.randint(1, 4)):
            t = s0 + (s1 - s0) * random.random(); cid = f"{900000+i*10+k}"
            call = {"metaData": {"id": cid, "started": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "duration": random.choice([60, 900, 1800, 2700]),
                    "primaryUserId": random.choice(ro.gong_user_id.tolist()), "direction": "Conference", "system": "Zoom", "scope": "External"},
                    "parties": [{"speakerId": "s1", "userId": ro.gong_user_id[0], "name": "Rep Person", "emailAddress": "rep@findigs.com", "affiliation": "Internal"},
                                {"speakerId": "s2", "name": "Pat Buyer", "emailAddress": random.choice([f"buyer@pmc{i}.com", f"other@pmc{i}.com"]), "title": "VP Operations", "affiliation": "External"}],
                    "context": [{"system": "HubSpot", "objects": [{"objectType": "Deal", "objectId": r.deal_id}]}] if random.random() < .5 else []}
            by_month.setdefault(t.strftime("%Y-%m"), []).append(call)
    for mth, cl in by_month.items():
        (RAW / "calls_extensive" / f"{mth}.jsonl").write_text("\n".join(json.dumps(x) for x in cl)); (RAW / "calls_extensive" / f"{mth}.done").write_text(str(len(cl)))
    pd.DataFrame(assoc).to_csv(DEAL_ASSOC, index=False)
    for cl in by_month.values():
        for x in cl:
            cid = x["metaData"]["id"]; i = (int(cid) - 900000) // 10
            (RAW / "transcripts" / f"{cid}.json").write_text(json.dumps({"callId": cid, "transcript": [
                {"speakerId": "s1", "sentences": [{"start": 0, "text": "Hi Pat, thanks for joining. Call me at 555-123-4567."}]},
                {"speakerId": "s2", "sentences": [{"start": 4000, "text": f"Sure Rep. Email pat@pmc.com. At Acme Residential {i} we get a lot of fraud."}]}]}))
    print("mock raw data written")

if __name__ == '__main__':
    main()
