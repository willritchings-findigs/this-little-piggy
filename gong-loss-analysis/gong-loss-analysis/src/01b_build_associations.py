"""Phase 1b: build data/deal_associations.csv for ALL cohort deals in one batched pass (~25 HubSpot API requests total,
never per deal). Read-only. Requires a HubSpot private-app token with crm.objects.deals.read, crm.objects.companies.read,
crm.objects.contacts.read, crm.schemas.deals.read  ->  HUBSPOT_ACCESS_TOKEN in .env.
Also auto-detects the deal property holding the legacy Salesforce Opportunity ID.
Output columns: deal_id, legacy_sf_opportunity_id, company_ids, company_domains, company_names, contact_emails, contact_names
(contains PII: gitignored, local only; names are used ONLY to strengthen transcript redaction)."""
import os, re, time
import pandas as pd, requests
from config import COHORT, DEAL_ASSOC

BASE = "https://api.hubapi.com"
TOK = os.environ.get("HUBSPOT_ACCESS_TOKEN")

def req(method, path, **kw):
    for attempt in range(6):
        r = requests.request(method, BASE + path, headers={"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"}, timeout=60, **kw)
        if r.status_code == 429 or r.status_code >= 500: time.sleep(2 ** attempt); continue
        r.raise_for_status(); return r.json()
    raise RuntimeError(f"HubSpot request failed: {path}")

def chunks(x, n):
    for i in range(0, len(x), n): yield x[i:i + n]

def detect_legacy_prop():
    props = req("GET", "/crm/v3/properties/deals")["results"]
    cands = [p["name"] for p in props if re.search(r"salesforce|sfdc|opportunity_?id|opp_?id", p["name"] + " " + p.get("label", ""), re.I)]
    print(f"[info] candidate legacy-ID properties: {cands}")
    pref = [c for c in cands if re.search(r"opportunity", c, re.I)] or cands
    return pref[0] if pref else None

def main():
    if not TOK: raise SystemExit("HUBSPOT_ACCESS_TOKEN not set — see CLAUDE_CODE_PROMPT.md Phase 1b for the MCP fallback (batch tools only).")
    deals = pd.read_csv(COHORT, dtype=str).deal_id.tolist()
    legacy = os.environ.get("HUBSPOT_LEGACY_SF_PROP") or detect_legacy_prop()
    print(f"[info] using legacy SF opportunity property: {legacy}")
    out = {d: {"deal_id": d, "legacy_sf_opportunity_id": "", "company_ids": [], "contact_ids": []} for d in deals}
    if legacy:
        for ch in chunks(deals, 100):   # 9 requests
            for r in req("POST", "/crm/v3/objects/deals/batch/read", json={"properties": [legacy], "inputs": [{"id": d} for d in ch]})["results"]:
                out[r["id"]]["legacy_sf_opportunity_id"] = (r["properties"].get(legacy) or "").strip()
    for to, key in [("companies", "company_ids"), ("contacts", "contact_ids")]:
        for ch in chunks(deals, 1000):  # 1 request each
            for r in req("POST", f"/crm/v4/associations/deals/{to}/batch/read", json={"inputs": [{"id": d} for d in ch]}).get("results", []):
                out[str(r["from"]["id"])][key] = [str(t["toObjectId"]) for t in r.get("to", [])]
    comp_ids = sorted({c for v in out.values() for c in v["company_ids"]}); cont_ids = sorted({c for v in out.values() for c in v["contact_ids"]})
    comp, cont = {}, {}
    for ch in chunks(comp_ids, 100):
        for r in req("POST", "/crm/v3/objects/companies/batch/read", json={"properties": ["domain", "website", "name"], "inputs": [{"id": c} for c in ch]})["results"]:
            p = r["properties"]; dom = (p.get("domain") or re.sub(r"^https?://(www\.)?", "", p.get("website") or "").split("/")[0]).lower()
            comp[r["id"]] = (dom, p.get("name") or "")
    for ch in chunks(cont_ids, 100):
        for r in req("POST", "/crm/v3/objects/contacts/batch/read", json={"properties": ["email", "firstname", "lastname"], "inputs": [{"id": c} for c in ch]})["results"]:
            p = r["properties"]; cont[r["id"]] = ((p.get("email") or "").lower(), " ".join(x for x in [p.get("firstname"), p.get("lastname")] if x))
    rows = []
    for d, v in out.items():
        rows.append({"deal_id": d, "legacy_sf_opportunity_id": v["legacy_sf_opportunity_id"], "company_ids": ";".join(v["company_ids"]),
                     "company_domains": ";".join(sorted({comp[c][0] for c in v["company_ids"] if c in comp and comp[c][0]})),
                     "company_names": ";".join(sorted({comp[c][1] for c in v["company_ids"] if c in comp and comp[c][1]})),
                     "contact_emails": ";".join(sorted({cont[c][0] for c in v["contact_ids"] if c in cont and cont[c][0]})),
                     "contact_names": ";".join(sorted({cont[c][1] for c in v["contact_ids"] if c in cont and cont[c][1]}))})
    df = pd.DataFrame(rows); df.to_csv(DEAL_ASSOC, index=False)
    fill = {c: f"{(df[c] != '').mean():.0%}" for c in df.columns if c != "deal_id"}
    print(f"[ok] {len(df)} deals; fill rates: {fill}; companies {len(comp)}, contacts {len(cont)}")

if __name__ == "__main__":
    main()
