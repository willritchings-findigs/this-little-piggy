"""Phase 0: confirm Gong access, fill internal roster Gong IDs, and probe the /v2/calls/extensive response shape.
Prints counts and field names only — never credentials, transcript text, or personal data.
Usage:  python src/00_setup_check.py            (connection + roster)
        python src/00_setup_check.py --probe    (also write field-structure probe)
"""
import sys, json, re, datetime as dt
import pandas as pd
from gong_client import GongClient
from config import ROSTER, RAW

def norm(s): return re.sub(r"[^a-z]", "", str(s).lower())

def structure(o, depth=0):
    if isinstance(o, dict): return {k: structure(v, depth + 1) for k, v in o.items()}
    if isinstance(o, list): return [structure(o[0], depth + 1)] if o else []
    return type(o).__name__

def main():
    g = GongClient()
    users = list(g.paginate_get("/v2/users", "users"))
    print(f"[ok] Gong connection works. Users returned: {len(users)}")
    roster = pd.read_csv(ROSTER, dtype=str).fillna("")
    by_name = {norm(f"{u.get('firstName','')}{u.get('lastName','')}"): u for u in users}
    filled = 0
    for i, r in roster.iterrows():
        u = by_name.get(norm(r["name"]))
        if u:
            if r["gong_user_id"] and r["gong_user_id"] != str(u["id"]):
                print(f"[warn] Gong ID mismatch for roster row {i} ({r['role']}); keeping API value")
            roster.at[i, "gong_user_id"] = str(u["id"]); roster.at[i, "email"] = u.get("emailAddress", ""); filled += 1
    roster.to_csv(ROSTER, index=False)
    missing = roster[roster.gong_user_id == ""]
    print(f"[ok] Roster matched {filled}/{len(roster)}. Unmatched roles: {missing.role.value_counts().to_dict()} (review names in data/internal_roster.csv)")
    # Internal email domains for affiliation fallback
    doms = sorted({u.get('emailAddress','').split('@')[-1].lower() for u in users if '@' in u.get('emailAddress','')})
    (RAW / "internal_domains.json").write_text(json.dumps(doms))
    print(f"[ok] Internal email domains: {doms}")
    if "--probe" in sys.argv:
        to = dt.datetime.utcnow(); fr = to - dt.timedelta(days=14)
        body = {"filter": {"fromDateTime": fr.strftime("%Y-%m-%dT%H:%M:%SZ"), "toDateTime": to.strftime("%Y-%m-%dT%H:%M:%SZ")},
                "contentSelector": __import__("pull_spec").LIGHT_SELECTOR}
        data = g.request("POST", "/v2/calls/extensive", json_body=body)
        calls = data.get("calls", [])
        (RAW / "probe_call_structure.json").write_text(json.dumps(structure(calls[0]) if calls else {}, indent=1))
        ctx = [o.get("objectType") for c in calls for s in (c.get("context") or []) for o in (s.get("objects") or [])]
        systems = [s.get("system") for c in calls for s in (c.get("context") or [])]
        print(f"[ok] Probe: {len(calls)} calls in last 14 days; CRM systems in context: {pd.Series(systems).value_counts().to_dict()}; object types: {pd.Series(ctx).value_counts().to_dict()}")
        print("     Field structure written to data/raw/probe_call_structure.json — compare with pull_spec.py and adjust if names differ.")
        if calls:   # verify the CONTENT tier and the transcript endpoint now, so Phase 2 cannot fail on field names
            ids = [str(c["metaData"]["id"]) for c in calls[:3]]
            cdata = g.request("POST", "/v2/calls/extensive", json_body={"filter": {"callIds": ids}, "contentSelector": __import__("pull_spec").CONTENT_SELECTOR})
            (RAW / "probe_content_structure.json").write_text(json.dumps(structure((cdata.get("calls") or [{}])[0]), indent=1))
            tdata = g.request("POST", "/v2/calls/transcript", json_body={"filter": {"callIds": ids}})
            tr = tdata.get("callTranscripts") or []
            (RAW / "probe_transcript_structure.json").write_text(json.dumps(structure(tr[0]) if tr else {}, indent=1))
            print(f"[ok] Content tier + transcript endpoint verified on {len(ids)} calls (transcripts returned: {len(tr)}). Structures in data/raw/probe_*.json")

if __name__ == "__main__":
    main()
