"""Phase 1b: match Gong calls to cohort deals with explicit, tiered match methods and confidence.
Inputs : data/raw/calls_extensive/*.jsonl, data/cohort_deals.csv, data/deal_associations.csv (built in Phase 1 via HubSpot), data/internal_roster.csv
Outputs: data/outputs/calls_flat.csv (no names/emails), data/outputs/call_deal_map.csv, data/outputs/match_log.csv
Match tiers (highest wins):
  M1 crm_deal   : call CRM context contains a Deal/Opportunity whose id == deal_id or the deal's legacy Salesforce Opportunity id
  M2 contact    : an external participant email is a contact associated to the deal, call inside deal window
  M3 company    : an external participant email domain (non-freemail) matches a company associated to the deal, inside window
  M4 crm_account: call CRM context Account/Company id matches the deal's associated company id, inside window
Window = deal create date through close date (local calendar days; scope rule 1). Matched calls outside it are kept in the map with exclusion_reason, never analysed.
Scope rules 2 (sales-process relevance) and 3 (>= MIN_MEETING_SECONDS) are applied here too; in_scope = passes all three.
A call matching >1 deal at its best tier is assigned to the deal whose create..close span contains the call; if still tied -> 'ambiguous' (excluded from primary analysis, logged).
"""
import json, glob, hashlib
import pandas as pd, numpy as np
import re
from config import RAW, OUT, COHORT, DEAL_ASSOC, ROSTER, WINDOW_BEFORE_CREATE, WINDOW_AFTER_CLOSE, MIN_MEETING_SECONDS, FREEMAIL, LOCAL_TZ, SALES_ROLES, INCLUDE_UNCERTAIN_RELEVANCE
NON_SALES_TITLE = re.compile(r"\b(implementation|onboard\w*|kick ?off|go[- ]live|training|support|ticket|qbr|quarterly business review|renewal|check[- ]in|billing|invoice|interview|internal|stand ?up|1:1|one on one|all hands|webinar|account review|cs sync|escalation)\b", re.I)

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
                         "scope": md.get("scope"), "media": md.get("media"), "purpose": md.get("purpose"), "is_private": md.get("isPrivate"), "_title": md.get("title") or ""})
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
    calls["started"] = pd.to_datetime(calls.started, utc=True, errors="coerce").dt.tz_convert(LOCAL_TZ).dt.tz_localize(None)   # local wall-clock time
    return calls, pd.DataFrame(parties), pd.DataFrame(ctx)

def main():
    cohort = pd.read_csv(COHORT, dtype=str)
    for col in ["create_date", "close_date", "date_intro", "date_discovery", "date_business_case", "date_negotiation", "date_trial"]:
        cohort[col] = pd.to_datetime(cohort[col])
    cohort["w0"] = cohort.create_date.dt.normalize() - pd.Timedelta(days=WINDOW_BEFORE_CREATE)                       # start of create day
    cohort["w1"] = cohort.close_date.dt.normalize() + pd.Timedelta(days=WINDOW_AFTER_CLOSE + 1) - pd.Timedelta(seconds=1)  # end of close day
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
    m = m.merge(calls, on="call_id", how="left").merge(cohort, on="deal_id", how="left")
    m["days_from_create"] = (m.started - m.create_date).dt.days
    m["days_to_close"] = (m.close_date - m.started).dt.days
    roster = pd.read_csv(ROSTER, dtype=str).fillna("")
    role_of = dict(zip(roster.gong_user_id, roster.role))
    roles = parties[parties.affiliation == "Internal"].assign(role=lambda x: x.user_id.map(role_of).fillna("unknown")).groupby("call_id").role.agg(lambda r: set(r))
    m["internal_roles"] = m.call_id.map(roles).apply(lambda r: r if isinstance(r, set) else set())
    m["primary_user_role"] = m.primary_user_id.map(role_of).fillna("unknown")
    m["has_sales_rep"] = m.apply(lambda r: bool(r.internal_roles & SALES_ROLES) or r.primary_user_role in SALES_ROLES, axis=1)
    m["non_sales_title"] = m._title.fillna("").apply(lambda t: bool(NON_SALES_TITLE.search(t)))
    def relevance(r):
        if str(r.scope).lower() == "internal" or r.n_external == 0: return "non_sales", "internal_only"
        if not r.has_sales_rep and r.internal_roles & {"customer_success", "revops", "other"}: return "non_sales", "no_sales_rep_post_sale_team"
        if r.non_sales_title and not r.has_sales_rep: return "non_sales", "post_sale_title_no_sales_rep"
        if r.non_sales_title and r.has_sales_rep: return "uncertain", "post_sale_title_with_sales_rep"
        if not r.has_sales_rep: return "uncertain", "no_roster_matched_rep"
        return "sales", ""
    rel = m.apply(relevance, axis=1, result_type="expand"); m["relevance"], m["relevance_reason"] = rel[0], rel[1]
    # Scope rules, evaluated in order so every exclusion has exactly one reason
    def reason(r):
        if not (r.w0 <= r.started <= r.w1): return "1_outside_create_close_window"
        if (r.duration_s or 0) < MIN_MEETING_SECONDS: return "3_shorter_than_min_seconds"
        if r.relevance == "non_sales": return "2_not_sales_process:" + r.relevance_reason
        if r.relevance == "uncertain" and not INCLUDE_UNCERTAIN_RELEVANCE: return "2_uncertain_relevance:" + r.relevance_reason
        return ""
    m["exclusion_reason"] = m.apply(reason, axis=1)
    m["in_scope"] = m.exclusion_reason == ""
    m["is_meeting"] = m.in_scope          # backward-compatible name used downstream: in-scope sales meeting
    stage_cols = [("date_intro", "Intro & Challenge"), ("date_discovery", "Discovery / Demo"), ("date_business_case", "Business Case & Stakeholder Alignment"), ("date_negotiation", "Negotiation & Execution"), ("date_trial", "Trial")]
    def stage_at(r):
        st = "Intro & Challenge"          # rule 1 guarantees the call is on/after deal creation
        for col, name in stage_cols:
            if pd.notna(r[col]) and r[col].normalize() <= r.started: st = name
        return st
    m["stage_at_call"] = m.apply(stage_at, axis=1)
    m["funnel_section_at_call"] = m.stage_at_call.map({"Intro & Challenge": "TOFU", "Discovery / Demo": "MOFU", "Business Case & Stakeholder Alignment": "MOFU", "Negotiation & Execution": "BOFU", "Trial": "BOFU"})
    m["match_confidence"] = m.tier.map({1: "high", 2: "high", 3: "medium", 4: "medium"})
    m = m.sort_values(["deal_id", "started"])
    m["call_seq"] = np.nan
    m.loc[m.in_scope, "call_seq"] = m[m.in_scope].groupby("deal_id").cumcount() + 1   # sequence among in-scope meetings
    keepcols = ["call_id", "deal_id", "method", "tier", "match_confidence", "started", "duration_s", "direction", "system", "scope", "media", "purpose",
                "primary_user_id", "primary_user_role", "n_external", "n_internal", "has_sales_rep", "relevance", "relevance_reason", "exclusion_reason", "in_scope", "is_meeting",
                "stage_at_call", "funnel_section_at_call", "days_from_create", "days_to_close", "call_seq"]
    m[keepcols].to_csv(OUT / "call_deal_map.csv", index=False)
    calls.to_csv(OUT / "calls_flat.csv", index=False)
    pd.DataFrame(log).to_csv(OUT / "match_log.csv", index=False)
    # external party roles per matched call (titles + pseudonymous ids only)
    ext[ext.call_id.isin(m.call_id)][["call_id", "speaker_id", "email_hash", "domain", "title"]].to_csv(OUT / "external_parties.csv", index=False)
    print(f"[ok] matched calls: {len(m)} across {m.deal_id.nunique()} deals; by method: {m.method.value_counts().to_dict()}; ambiguous excluded: {sum(1 for l in log if l['issue']=='ambiguous_excluded')}")
    print(f"[ok] in scope after rules 1-3: {int(m.in_scope.sum())} calls across {m[m.in_scope].deal_id.nunique()} deals; exclusions: {m.exclusion_reason.str.split(':').str[0].value_counts().drop('', errors='ignore').to_dict()}")

if __name__ == "__main__":
    main()
