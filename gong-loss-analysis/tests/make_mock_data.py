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
        sales_ids = ro[ro.role.isin(["ae", "sdr"])].gong_user_id.tolist(); cs_id = ro[ro.role == "customer_success"].gong_user_id.iloc[0]
        for k in range(random.randint(1, 5)):
            kind = random.choices(["sales", "before_create", "after_close", "short", "internal", "cs_post_sale"], [70, 6, 6, 8, 5, 5])[0]
            t = s0 + (s1 - s0) * random.random()
            if kind == "before_create": t = s0 - pd.Timedelta(days=random.randint(2, 30))
            if kind == "after_close": t = s1 + pd.Timedelta(days=random.randint(2, 30))
            t = t.normalize() + pd.Timedelta(hours=16)   # 4pm UTC = midday Eastern, so local date == UTC date in the mock
            cid = f"{900000+i*10+k}"; uid = cs_id if kind == "cs_post_sale" else random.choice(sales_ids)
            call = {"metaData": {"id": cid, "started": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "duration": 60 if kind == "short" else random.choice([900, 1800, 2700]),
                    "primaryUserId": uid, "direction": "Conference", "system": "Zoom", "scope": "Internal" if kind == "internal" else "External",
                    "title": "Implementation kickoff" if kind == "cs_post_sale" else random.choice(["Findigs intro", "Discovery call", "Demo", "Pricing review"])},
                    "parties": [{"speakerId": "s1", "userId": uid, "name": "Rep Person", "emailAddress": "rep@findigs.com", "affiliation": "Internal"}] + ([] if kind == "internal" else
                                [{"speakerId": "s2", "name": "Pat Buyer", "emailAddress": random.choice([f"buyer@pmc{i}.com", f"other@pmc{i}.com"]), "title": "VP Operations", "affiliation": "External"}]),
                    "context": [{"system": "HubSpot", "objects": [{"objectType": "Deal", "objectId": r.deal_id}]}] if random.random() < .5 else []}
            by_month.setdefault(t.strftime("%Y-%m"), []).append(call)
    for mth, cl in by_month.items():
        (RAW / "calls_extensive" / f"{mth}.jsonl").write_text("\n".join(json.dumps(x) for x in cl)); (RAW / "calls_extensive" / f"{mth}.done").write_text(str(len(cl)))
    pd.DataFrame(assoc).to_csv(DEAL_ASSOC, index=False)
    for cl in by_month.values():
        for x in cl:
            cid = x["metaData"]["id"]; i = (int(cid) - 900000) // 10
            (RAW / "calls_content").mkdir(exist_ok=True)
            if random.random() < 0.85:
                (RAW / "calls_content" / f"{cid}.json").write_text(json.dumps({"metaData": {"id": cid}, "content": {
                    "brief": f"Prospect from Acme Residential {i} discussed fraud and pricing; asked to circle back next quarter.",
                    "keyPoints": [{"text": "Concern about cost per application"}, {"text": "Uses AppFolio screening today"}],
                    "callOutcome": {"name": random.choice(["Next steps set", "No decision", "Follow-up needed"])},
                    "trackers": [{"name": "Pricing", "count": random.randint(0, 5)}, {"name": "Competitors", "count": random.randint(0, 2)}]},
                    "interaction": {"questions": {"companyCount": random.randint(2, 20), "nonCompanyCount": random.randint(0, 10)},
                                    "interactionStats": [{"name": "Talk Ratio", "value": round(random.random(), 2)}]}}))
            (RAW / "transcripts" / f"{cid}.json").write_text(json.dumps({"callId": cid, "transcript": [
                {"speakerId": "s1", "sentences": [{"start": 0, "text": "Hi Pat, thanks for joining. Call me at 555-123-4567."}]},
                {"speakerId": "s2", "sentences": [{"start": 4000, "text": f"Sure Rep. Email pat@pmc.com. At Acme Residential {i} we get a lot of fraud."}]},
            {"speakerId": "s1", "sentences": [{"start": 60000, "text": random.choice(["Pricing is $3 per application.", "Tell me about your evictions?"])}]},
            {"speakerId": "s2", "sentences": [{"start": 90000, "text": random.choice(["Does it integrate with AppFolio?", "Can you send me some info?", "We use Yardi's built-in screening.", "Let's circle back next quarter."])}]}]}))
    print("mock raw data written")

if __name__ == '__main__':
    main()
