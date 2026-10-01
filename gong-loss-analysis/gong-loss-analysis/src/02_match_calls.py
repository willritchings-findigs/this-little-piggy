"""Phase 1b: match Gong calls to cohort deals with explicit, tiered match methods and confidence.
Inputs : data/raw/calls_extensive/*.jsonl, data/cohort_deals.csv, data/deal_associations.csv (built in Phase 1 via HubSpot), data/internal_roster.csv
Outputs: data/outputs/calls_flat.csv (no names/emails), data/outputs/call_deal_map.csv, data/outputs/match_log.csv
Match tiers (highest wins):
  M1 crm_deal   : call CRM context contains a Deal/Opportunity whose id == deal_id or the deal's legacy Salesforce Opportunity id
  M2 contact    : an external participant email is a contact associated to the deal, call inside deal window
  M3 company    : an external participant email domain (non-freemail) matches a company associated to the deal, inside window
  M4 crm_account: call CRM context Account/Company id matches the deal's associated company id, inside window
Window = [create_date - WINDOW_BEFORE_CREATE, close_date + WINDOW_AFTER_CLOSE].
A call matching >1 deal at its best tier is assigned to the deal whose create..close span contains the call; if still tied -> 'ambiguous' (excluded from primary analysis, logged).
"""
import json, glob, hashlib
import pandas as pd, numpy as np
from config import RAW, OUT, COHORT, DEAL_ASSOC, ROSTER, WINDOW_BEFORE_CREATE, WINDOW_AFTER_CLOSE, MIN_MEETING_SECONDS, FREEMAIL

def h(s):  # stable pseudonymous id for an external person (no PII stored)
    return hashlib.sha256(str(s).lower().encode()).hexdigest()[:12] if s else ""

def load_calls():
    rows, parties, ctx = [], [], []
    internal_domains = set(json.loads((RAW / "internal_domains.json").read_text())) if (RAW / "internal_domains.json").exists() else set()
    for f in sorted(glob.glob(str(RAW / "calls_extensive" / "*.jsonl"))):
        for line in open(f, encoding="utf-8"):
            c = json.loads(line); md = c.get("metaData", {}) or {}
            cid = str(md.get("id"))
            rows.append({"call_id": cid, "started": md.get("started") or md.get("scheduled"), "duration_s": md.get("duration"),
                         "primary_user_id": str(md.get("primaryUserId", "")), "direction": md.get("direction"), "system": md.get("system"),
                         "scope": md.get("scope"), "media": md.get("media"), "purpose": md.get("purpose"), "is_private": md.get("isPrivate")})
            for p in c.get("parties", []) or []:
                em = (p.get("emailAddress") or "").lower(); dom = em.split("@")[-1] if "@" in em else ""
                aff = p.get("affiliation") or ("Internal" if dom in internal_domains else "Unknown")
                if aff == "Unknown" and dom and dom not in internal_domains: aff = "External"
                parties.append({"call_id": cid, "speaker_id": str(p.get("speakerId", "")), "user_id": str(p.get("userId", "") or ""),
                                "affiliation": aff, "email_hash": h(em), "domain": dom, "title": p.get("title") or "", "_email": em})
            for s in c.get("context", []) or []:
                for o in s.get("objects", []) or []:
                    ctx.append({"call_id": cid, "system": s.get("system"), "object_type": (o.get("objectType") or "").lower(), "object_id": str(o.get("objectId", ""))})
    calls = pd.DataFrame(rows).drop_duplicates("call_id")
    calls["started"] = pd.to_datetime(calls.started, utc=True, errors="coerce").dt.tz_convert(None)
    return calls, pd.DataFrame(parties), pd.DataFrame(ctx)

def main():
    cohort = pd.read_csv(COHORT, dtype=str)
    for col in ["create_date", "close_date", "date_intro", "date_discovery", "date_business_case", "date_negotiation", "date_trial"]:
        cohort[col] = pd.to_datetime(cohort[col])
    cohort["w0"] = cohort.create_date - pd.Timedelta(days=WINDOW_BEFORE_CREATE)
    cohort["w1"] = cohort.close_date + pd.Timedelta(days=WINDOW_AFTER_CLOSE)
    assoc = pd.read_csv(DEAL_ASSOC, dtype=str).fillna("") if DEAL_ASSOC.exists() else pd.DataFrame(columns=["deal_id","legacy_sf_opportunity_id","company_ids","company_domains","contact_emails"])
    if not DEAL_ASSOC.exists(): print("[warn] data/deal_associations.csv missing — only M1 (crm_deal) matching possible. Build it in Phase 1 step 1b.")
    calls, parties, ctx = load_calls()
    print(f"[info] calls loaded: {len(calls)}; parties: {len(parties)}; crm context rows: {len(ctx)}")

    ext = parties[parties.affiliation == "External"]
    calls["n_external"] = calls.call_id.map(ext.groupby("call_id").size()).fillna(0).astype(int)
    calls["n_internal"] = calls.call_id.map(parties[parties.affiliation == "Internal"].groupby("call_id").size()).fillna(0).astype(int)

    cands = []
    # M1
    dealobj = ctx[ctx.object_type.isin(["deal", "opportunity"])]
    idmap = {d: d for d in cohort.deal_id}
    for _, a in assoc.iterrows():
        if a.get("legacy_sf_opportunity_id"):
            for sid in str(a.legacy_sf_opportunity_id).split(";"):
                if sid.strip(): idmap[sid.strip()] = a.deal_id
    m1 = dealobj[dealobj.object_id.isin(idmap)].assign(deal_id=lambda x: x.object_id.map(idmap), tier=1, method="crm_deal")
    cands.append(m1[["call_id", "deal_id", "tier", "method"]])
    # M2/M3/M4 need associations + window
    cw = calls.set_index("call_id").started
    def in_window(df):
        df = df.merge(cohort[["deal_id", "w0", "w1"]], on="deal_id")
        df["started"] = df.call_id.map(cw)
        return df[(df.started >= df.w0) & (df.started <= df.w1)][["call_id", "deal_id", "tier", "method"]]
    if len(assoc):
        em = assoc.assign(e=assoc.contact_emails.str.lower().str.split(";")).explode("e")
        em = em[em.e.str.strip() != ""][["deal_id", "e"]]
        m2 = ext.merge(em, left_on="_email", right_on="e")[["call_id", "deal_id"]].assign(tier=2, method="contact")
        cands.append(in_window(m2))
        dm = assoc.assign(d=assoc.company_domains.str.lower().str.split(";")).explode("d")
        dm = dm[(dm.d.str.strip() != "") & (~dm.d.isin(FREEMAIL))][["deal_id", "d"]]
        m3 = ext[~ext.domain.isin(FREEMAIL)].merge(dm, left_on="domain", right_on="d")[["call_id", "deal_id"]].assign(tier=3, method="company")
        cands.append(in_window(m3))
        cm = assoc.assign(ci=assoc.company_ids.str.split(";")).explode("ci")
        cm = cm[cm.ci.str.strip() != ""][["deal_id", "ci"]]
        acc = ctx[ctx.object_type.isin(["account", "company"])]
        m4 = acc.merge(cm, left_on="object_id", right_on="ci")[["call_id", "deal_id"]].assign(tier=4, method="crm_account")
        cands.append(in_window(m4))
    cand = pd.concat(cands).drop_duplicates()
    best = cand.groupby("call_id").tier.min().rename("best")
    cand = cand.merge(best, on="call_id"); cand = cand[cand.tier == cand.best]
    cand = cand.merge(cohort[["deal_id", "create_date", "close_date"]], on="deal_id")
    cand["started"] = cand.call_id.map(cw)
    cand["in_span"] = (cand.started >= cand.create_date) & (cand.started <= cand.close_date)
    log = []
    keep = []
    for cid, g in cand.groupby("call_id"):
        if g.deal_id.nunique() == 1:
            keep.append(g.iloc[0]); continue
        g2 = g[g.in_span]
        if g2.deal_id.nunique() == 1:
            keep.append(g2.iloc[0]); log.append({"call_id": cid, "issue": "multi_deal_resolved_by_span", "deals": ";".join(g.deal_id.unique())})
        else:
            log.append({"call_id": cid, "issue": "ambiguous_excluded", "deals": ";".join(g.deal_id.unique())})
    m = pd.DataFrame(keep)[["call_id", "deal_id", "tier", "method"]] if keep else pd.DataFrame(columns=["call_id","deal_id","tier","method"])
    # M1 calls outside window: keep but flag
    m = m.merge(calls, on="call_id", how="left").merge(cohort, on="deal_id", how="left")
    m["days_from_create"] = (m.started - m.create_date).dt.days
    m["days_to_close"] = (m.close_date - m.started).dt.days
    m["outside_window"] = (m.started < m.w0) | (m.started > m.w1)
    m["after_close"] = m.started > m.close_date + pd.Timedelta(days=WINDOW_AFTER_CLOSE)
    m = m[~m.after_close]   # post-close calls (e.g. implementation) excluded from loss analysis
    stage_cols = [("date_intro", "Intro & Challenge"), ("date_discovery", "Discovery / Demo"), ("date_business_case", "Business Case & Stakeholder Alignment"), ("date_negotiation", "Negotiation & Execution"), ("date_trial", "Trial")]
    def stage_at(r):
        st = "Pre-deal (before Intro)"
        for col, name in stage_cols:
            if pd.notna(r[col]) and r[col] <= r.started: st = name
        return st
    m["stage_at_call"] = m.apply(stage_at, axis=1)
    m["is_meeting"] = (m.n_external > 0) & (m.duration_s.fillna(0) >= MIN_MEETING_SECONDS)
    m["match_confidence"] = m.tier.map({1: "high", 2: "high", 3: "medium", 4: "medium"})
    m = m.sort_values(["deal_id", "started"])
    m["call_seq"] = m.groupby("deal_id").cumcount() + 1
    roster = pd.read_csv(ROSTER, dtype=str).fillna("")
    m["primary_user_role"] = m.primary_user_id.map(dict(zip(roster.gong_user_id, roster.role))).fillna("unknown")
    keepcols = ["call_id", "deal_id", "method", "tier", "match_confidence", "started", "duration_s", "direction", "system", "scope", "media", "purpose",
                "primary_user_id", "primary_user_role", "n_external", "n_internal", "is_meeting", "stage_at_call", "days_from_create", "days_to_close", "outside_window", "call_seq"]
    m[keepcols].to_csv(OUT / "call_deal_map.csv", index=False)
    calls.to_csv(OUT / "calls_flat.csv", index=False)
    pd.DataFrame(log).to_csv(OUT / "match_log.csv", index=False)
    # external party roles per matched call (titles + pseudonymous ids only)
    ext[ext.call_id.isin(m.call_id)][["call_id", "speaker_id", "email_hash", "domain", "title"]].to_csv(OUT / "external_parties.csv", index=False)
    print(f"[ok] matched calls: {len(m)} across {m.deal_id.nunique()} deals; by method: {m.method.value_counts().to_dict()}; ambiguous excluded: {sum(1 for l in log if l['issue']=='ambiguous_excluded')}")

if __name__ == "__main__":
    main()
