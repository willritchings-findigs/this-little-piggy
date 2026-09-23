#!/usr/bin/env python3
"""
Findigs GTM executive dashboard — build step.

Reads:   config.json, data/snapshot.json, data/controls.json,
         data/deals_open.json, data/deals_won.json, data/deals_created.json, data/swan_scores.json
Writes:  output/findigs_gtm_executive_dashboard_<as_of>.html, output/tieout.md, runs/runs.jsonl

Exit codes: 0 = built and reconciled; 2 = tie-out failure (nothing written to output/);
            3 = schema/config problem. The refresh skill treats any non-zero exit as "stop and report".

Usage: python build.py [--as-of YYYY-MM-DD] [--no-run-log]
"""
import argparse, json, os, sys
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta, date
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
P = lambda *a: os.path.join(HERE, *a)

def load(name):
    with open(P(name), encoding="utf-8") as f:
        return json.load(f)

def fail(code, msg):
    print(f"BUILD FAILED: {msg}", file=sys.stderr)
    sys.exit(code)

# ----------------------------------------------------------------------------- inputs
ap = argparse.ArgumentParser()
ap.add_argument("--as-of", help="override as-of date (YYYY-MM-DD, ET). Default: snapshot.json as_of")
ap.add_argument("--no-run-log", action="store_true")
args = ap.parse_args()

CFG = load("config.json")
SNAP = load("data/snapshot.json")
CTL = load("data/controls.json")
OPEN_RAW = load("data/deals_open.json")
WON_RAW = load("data/deals_won.json")
CREATED_RAW = load("data/deals_created.json")
SWAN = {str(r["deal_id"]): int(r["swan_score"]) for r in load("data/swan_scores.json")}

ET = ZoneInfo(CFG["timezone"])
AS_OF = args.as_of or SNAP["as_of"]
F = CFG["fields"]
WON_IDS = set(CFG["terminal_stages"]["won"]); LOST_IDS = set(CFG["terminal_stages"]["lost"])
PIPES = {v["id"]: v for v in CFG["pipelines"].values()}
IN_SCOPE = {v["id"] for v in CFG["pipelines"].values() if v["in_scope"]}
NL_ID = CFG["pipelines"]["new_logo"]["id"]
STAGE = {s["id"]: s for s in SNAP["stages"]}
OWNERS = SNAP["owners"]
TOL = CFG["tie_out_tolerance_usd"]
SDR_CFG = CFG["sdr_section"]
CHANNEL_LOOKUP = {v.lower(): bucket for bucket, values in SDR_CFG["channel_mapping"]["buckets"].items() for v in values}
BLANK_CHANNEL = SDR_CFG["channel_mapping"]["blank_label"]
def channel_bucket(raw):
    if not raw: return BLANK_CHANNEL
    return CHANNEL_LOOKUP.get(raw.lower(), BLANK_CHANNEL)

# ----------------------------------------------------------------------------- fiscal windows
y, m, d = (int(x) for x in AS_OF.split("-"))
q = (m - 1) // 3
q_start = date(y, 3 * q + 1, 1)
q_end = (date(y + (q == 3), (3 * q + 4) % 12 or 12, 1) - timedelta(days=1)) if q < 3 else date(y, 12, 31)
fy_start, fy_end = date(y, 1, 1), date(y, 12, 31)
pq_start = date(y - 1, 10, 1) if q == 0 else date(y, 3 * (q - 1) + 1, 1)
pq_end = q_start - timedelta(days=1)
iso = lambda dt: dt.strftime("%Y-%m-%d")
WIN = {"qtd": {"start": iso(q_start), "end": iso(q_end), "label": f"Q{q+1} FY{y}"},
       "ytd": {"start": iso(fy_start), "end": iso(fy_end), "label": f"FY{y}"},
       "priorQ": {"start": iso(pq_start), "end": iso(pq_end), "label": f"Q{q or 4} FY{y if q else y-1}"}}

# ----------------------------------------------------------------------------- helpers
def et_date(s):
    if not s: return None
    s = s.replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None: dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(ET).strftime("%Y-%m-%d")

def num(v):
    if v in (None, ""): return None
    try: return float(v)
    except ValueError: return None

def seg(units):
    for b in CFG["segment_rule"]["bands"]:
        if units >= b["min"] and (b["max"] is None or units <= b["max"]): return b["label"]
    return "Unknown"

def owner_name(oid):
    o = OWNERS.get(str(oid))
    if not o: fail(3, f"owner id {oid} not in snapshot.json owners map — resolve via search_owners and re-run")
    return o["name"] + ("" if o.get("active", True) else " (inactive)")

def stage_of(sid):
    if sid not in STAGE: fail(3, f"dealstage {sid} not in snapshot.json stages — pipeline configuration changed; re-run discovery")
    return STAGE[sid]

usd = lambda v: "${:,.2f}".format(v)

# ----------------------------------------------------------------------------- derive Tier 1-3 deals
def derive_deal(r, won):
    p = r["properties"]; sid = p["dealstage"]; st = stage_of(sid)
    if p["pipeline"] not in IN_SCOPE: fail(3, f"deal {r['id']} in out-of-scope pipeline {p['pipeline']}")
    amt = num(p.get(F["bookings_amount"])); units = num(p.get(F["units"]))
    if amt is None: fail(3, f"deal {r['id']} has null {F['bookings_amount']}")
    if units is None: fail(3, f"deal {r['id']} has null {F['units']}")
    prob = num(p.get(F["stage_probability"])); prob = st["probability"] if prob is None else prob
    stored = num(p.get(F["weighted_stored"]))
    if won: weighted, fallback = amt, False
    elif sid in LOST_IDS: weighted, fallback = 0.0, False
    elif stored is not None: weighted, fallback = stored, False
    else: weighted, fallback = round(amt * prob, 2), True
    close = et_date(p.get(F["close_date"])); created = et_date(p.get(F["create_date"]))
    acv = num(p.get(F["acv_comparison_field"]))
    return dict(id=str(r["id"]), name=p["dealname"], pipe="N" if p["pipeline"] == NL_ID else "U", pipeLabel=PIPES[p["pipeline"]]["label"],
                stageId=sid, stage=st["label"], stageProb=st["probability"], owner=owner_name(p[F["owner"]]), ownerId=str(p[F["owner"]]),
                amount=amt, units=int(units), segRaw=p.get(F["raw_segment"], "") or "", seg=seg(units), close=close, created=created,
                prob=prob, weighted=weighted, wtdFallback=fallback, wtdNull=False, probWeighted=round(amt * prob, 2), won=won, acv=acv,
                pastDue=(not won and close is not None and close < AS_OF), migration=(created is not None and created < CFG["migration"]["date_cutoff"]))

deals = [derive_deal(r, False) for r in OPEN_RAW] + [derive_deal(r, True) for r in WON_RAW]
open_ = [x for x in deals if not x["won"]]; won = [x for x in deals if x["won"]]
if any(x["stageId"] in WON_IDS or x["stageId"] in LOST_IDS for x in open_): fail(3, "deals_open.json contains closed deals")
if any(x["stageId"] not in WON_IDS for x in won): fail(3, "deals_won.json contains a non-won stage")

# ----------------------------------------------------------------------------- derive pipeline-generation deals
SRC_GROUP = {"IB": "Inbound", "OB": "Outbound", "EV": "Event", "RE": "Referral", "DA": "Data provider", "UK": "Unknown"}
def derive_created(r):
    p = r["properties"]; sid = p["dealstage"]; st = stage_of(sid)
    if p["pipeline"] != NL_ID: fail(3, f"created deal {r['id']} not in New Logo pipeline")
    amt = num(p.get(F["bookings_amount"])); units = num(p.get(F["units"]))
    if amt is None or units is None: fail(3, f"created deal {r['id']} has null amount or units")
    prob = num(p.get(F["stage_probability"])); prob = st["probability"] if prob is None else prob
    stored = num(p.get(F["weighted_stored"]))
    if sid in WON_IDS: w, fb = amt, False
    elif sid in LOST_IDS: w, fb = 0.0, False
    elif stored is not None: w, fb = stored, False
    else: w, fb = round(amt * prob, 2), True
    parent = p.get(F["source_parent"]) or "Unassigned"
    rs = p.get(F["record_source"]) or "UNKNOWN"
    sw = SWAN.get(str(r["id"]))
    src = p.get(F["source"])
    if not src: fail(3, f"created deal {r['id']} has null {F['source']} — the no-null assumption used to infer 'Outbound SDR' no longer holds; pull the field for every deal")
    sdr_owner_id = p.get("sdr_owner") or None
    is_opp = sdr_owner_id is not None
    meeting_booked = p.get("demo_booked__c") or None
    meeting_held = (p.get("demo_completed__c") == "Yes")
    chan_raw = (p.get("deal_source_group") or "").lower() or "null"
    return dict(id=str(r["id"]), name=p["dealname"], pipe="N", pipeLabel="New Logo", stageId=sid, stage=st["label"], owner=owner_name(p[F["owner"]]), ownerId=str(p[F["owner"]]),
                amount=amt, units=int(units), seg=seg(units), close=et_date(p.get(F["close_date"])), created=et_date(p.get(F["create_date"])),
                src=src, srcParent=parent, srcGroup=SRC_GROUP.get(parent[:2], "Unassigned"), recSrc=rs, migrated=(rs == CFG["migration"]["record_source_value"]),
                hsScore=num(p.get("hs_deal_score")), swan=sw, band=("No Swan score" if sw is None else f"Swan {sw}"),
                won=sid in WON_IDS, lost=sid in LOST_IDS, weighted=w, wtdFallback=fb, pastDue=False, migration=(rs == CFG["migration"]["record_source_value"]),
                sdrOwnerId=sdr_owner_id, isOpp=is_opp, sdrOwner=(owner_name(sdr_owner_id) if is_opp else None), sdrOwnerReal=(is_opp and sdr_owner_id != "8309346"),
                meetingBooked=meeting_booked, meetingHeld=meeting_held, chanRaw=chan_raw, channel=channel_bucket(p.get("deal_source_group")))

pg = [derive_created(r) for r in CREATED_RAW]

# ----------------------------------------------------------------------------- aggregates
og = sum(x["amount"] for x in open_); ow = sum(x["weighted"] for x in open_); owp = sum(x["probWeighted"] for x in open_)
fb = [x for x in open_ if x["wtdFallback"]]; ow_stored = sum(x["weighted"] for x in open_ if not x["wtdFallback"]); ow_fb = sum(x["weighted"] for x in fb)
wa = sum(x["amount"] for x in won); wu = sum(x["units"] for x in won); wacv = sum(x["acv"] for x in won if x["acv"] is not None)
n_mig = sum(1 for x in won if x["migration"]); n_clean = len(won) - n_mig
past_due = [x for x in open_ if x["pastDue"]]
overrides = [x for x in open_ if abs(x["prob"] - x["stageProb"]) > 1e-9]
inw = lambda dt, w: dt is not None and w["start"] <= dt <= w["end"]
q_open = [x for x in open_ if inw(x["close"], WIN["qtd"])]; y_open = [x for x in open_ if inw(x["close"], WIN["ytd"])]
q_won = [x for x in won if inw(x["close"], WIN["qtd"])]
top8 = sorted(open_, key=lambda x: -x["amount"])[:8]; top8_amt = sum(x["amount"] for x in top8)

pg_total = sum(x["amount"] for x in pg); pg_mig = [x for x in pg if x["migrated"]]; pg_nat = [x for x in pg if not x["migrated"]]
q3 = [x for x in pg if inw(x["created"], WIN["qtd"])]; q3_mig = [x for x in q3 if x["migrated"]]
zero_amt = [x for x in pg if x["amount"] == 0]; scored = [x for x in pg if x["swan"] is not None]
null_parent = [x for x in pg if x["srcParent"] == "Unassigned"]; no_close = [x for x in pg if not x["close"]]
mig_dates = sorted(x["created"] for x in pg_mig); nat_dates = sorted(x["created"] for x in pg_nat)

# ----------------------------------------------------------------------------- SDR section aggregates
win30 = {"start": iso(date(y, m, d) - timedelta(days=29)), "end": AS_OF}
opps = [x for x in pg if x["isOpp"]]
opp_total_amt = sum(x["amount"] for x in opps)
sdr_by_owner = defaultdict(lambda: {"n": 0, "a": 0.0})
for x in opps:
    b = sdr_by_owner[x["sdrOwnerId"]]; b["n"] += 1; b["a"] += x["amount"]
sdr_by_channel = defaultdict(lambda: {"n": 0, "a": 0.0})
for x in opps:
    b = sdr_by_channel[x["chanRaw"]]; b["n"] += 1; b["a"] += x["amount"]
booked_30d = [x for x in pg if x["meetingBooked"] and win30["start"] <= x["meetingBooked"] <= win30["end"]]
held_30d = [x for x in booked_30d if x["meetingHeld"]]
held_to_opp_30d = [x for x in held_30d if x["isOpp"]]
opp_30d = [x for x in opps if inw(x["created"], win30)]
opp_30d_by_owner = defaultdict(int)
for x in opp_30d:
    if x["sdrOwnerReal"]: opp_30d_by_owner[x["sdrOwnerId"]] += 1
booked_30d_by_seg = defaultdict(lambda: {"booked": 0, "held": 0})
for x in booked_30d:
    booked_30d_by_seg[x["seg"]]["booked"] += 1
    if x["meetingHeld"]: booked_30d_by_seg[x["seg"]]["held"] += 1
sdr_pipeline_qtd_by_seg = defaultdict(float); sdr_pipeline_ytd_by_seg = defaultdict(float)
for x in opps:
    if inw(x["created"], WIN["qtd"]): sdr_pipeline_qtd_by_seg[x["seg"]] += x["amount"]
    if inw(x["created"], WIN["ytd"]): sdr_pipeline_ytd_by_seg[x["seg"]] += x["amount"]
stage_by_channel = defaultdict(lambda: defaultdict(int))
for x in opps:
    stage_by_channel[x["stageId"]][x["channel"]] += 1

# ----------------------------------------------------------------------------- tie-out (hard gate)
tie = []
def check(label, ours, ctl, fmt=usd, money=True):
    ok = (abs(ours - ctl) <= TOL) if money else (ours == ctl)
    tie.append(dict(m=label, a=fmt(ours), b=fmt(ctl), d=("0.00 — reconciles" if ok and money else ("0 — reconciles" if ok else fmt(ours - ctl))), ok=ok))
check("Open deal count", len(open_), CTL["open_count"], fmt=str, money=False)
check("Open gross pipeline (Σ amount)", og, CTL["open_gross"])
check(f"Stored weighted_amount, populated open deals only ({len(open_)-len(fb)})", ow_stored, CTL["open_weighted_amount_stored"])
tie.append(dict(m="Weighted open pipeline as displayed (stored + fallback)", a=usd(ow), b=f"{usd(CTL['open_weighted_amount_stored'])} stored + {usd(ow_fb)} fallback", d="composed, not a single API figure", ok=True))
check("Reference only: Σ amount × hs_deal_stage_probability vs Σ hs_projected_amount", owp, CTL["open_hs_projected_amount"])
check("Closed-won FY count", len(won), CTL["won_count"], fmt=str, money=False)
check("Closed-won FY bookings (Σ amount)", wa, CTL["won_amount"])
check("Closed-won FY units (Σ units__c)", wu, CTL["won_units"], fmt=lambda v: f"{v:,}", money=False)
check("Closed-won FY Σ acv (populated only)", wacv, CTL["won_acv"])
pg_tie = []
def pcheck(label, ours, ctl, fmt=usd, money=True):
    ok = (abs(ours - ctl) <= TOL) if money else (ours == ctl)
    pg_tie.append(dict(m=label, a=fmt(ours), b=fmt(ctl), d=("0.00 — reconciles" if ok and money else ("0 — reconciles" if ok else fmt(ours - ctl))), ok=ok))
pcheck("Created FY count", len(pg), CTL["created_count"], fmt=str, money=False)
pcheck("Created FY Σ amount", pg_total, CTL["created_amount"])
for k, v in CTL["created_by_record_source"].items():
    sub = [x for x in pg if x["recSrc"] == k]
    pcheck(f"Record source {k} count", len(sub), v["n"], fmt=str, money=False); pcheck(f"Record source {k} Σ amount", sum(x["amount"] for x in sub), v["a"])
for k, v in CTL["created_by_drill_down"].items():
    sub = [x for x in pg if x["src"] == k]
    pcheck(f"{F['source']} = {k} count", len(sub), v["n"], fmt=str, money=False); pcheck(f"{F['source']} = {k} Σ amount", sum(x["amount"] for x in sub), v["a"])
for k, v in CTL["created_swan"].items():
    sub = [x for x in pg if (x["swan"] is None if k == "null" else x["swan"] == int(k))]
    pcheck(f"Swan score {k} count", len(sub), v["n"], fmt=str, money=False); pcheck(f"Swan score {k} Σ amount", sum(x["amount"] for x in sub), v["a"])
sdr_tie = []
def scheck(label, ours, ctl, fmt=usd, money=True):
    ok = (abs(ours - ctl) <= TOL) if money else (ours == ctl)
    sdr_tie.append(dict(m=label, a=fmt(ours), b=fmt(ctl), d=("0.00 — reconciles" if ok and money else ("0 — reconciles" if ok else fmt(ours - ctl))), ok=ok))
SDR_CTL = CTL["sdr"]
scheck("SDR opportunity count (createdate FY)", len(opps), SDR_CTL["opp_count"], fmt=str, money=False)
scheck("SDR opportunity Σ amount", opp_total_amt, SDR_CTL["opp_amount"])
for oid, v in SDR_CTL["by_owner"].items():
    b = sdr_by_owner.get(oid, {"n": 0, "a": 0.0})
    scheck(f"SDR opportunities, owner {owner_name(oid)}, count", b["n"], v["n"], fmt=str, money=False)
    scheck(f"SDR opportunities, owner {owner_name(oid)}, Σ amount", b["a"], v["a"])
for ch, v in SDR_CTL["by_channel"].items():
    b = sdr_by_channel.get(ch, {"n": 0, "a": 0.0})
    scheck(f"SDR opportunities, channel {ch}, count", b["n"], v["n"], fmt=str, money=False)
    scheck(f"SDR opportunities, channel {ch}, Σ amount", b["a"], v["a"])
scheck("Meetings booked, trailing 30d", len(booked_30d), SDR_CTL["meeting_booked_30d"], fmt=str, money=False)
scheck("Meetings held, trailing 30d cohort", len(held_30d), SDR_CTL["meeting_held_30d"], fmt=str, money=False)
scheck("Opportunities created, trailing 30d", len(opp_30d), SDR_CTL["opp_30d_count"], fmt=str, money=False)
for oid, n in SDR_CTL["opp_30d_by_owner"].items():
    scheck(f"Opportunities created trailing 30d, owner {owner_name(oid)}", opp_30d_by_owner.get(oid, 0), n, fmt=str, money=False)

failures = [t for t in tie + pg_tie + sdr_tie if not t["ok"]]
if failures:
    for t in failures: print(f"  MISMATCH  {t['m']}: pulled {t['a']} vs control {t['b']} (delta {t['d']})", file=sys.stderr)
    fail(2, f"{len(failures)} tie-out check(s) did not reconcile. Nothing written.")

# ----------------------------------------------------------------------------- stage metadata for the template
stages_meta = [dict(id=s["id"], label=s["label"], prob=s["probability"], pipe=("N" if s["pipeline"] == NL_ID else "U"), closed=(s["won"] or s["lost"]))
               for s in sorted(SNAP["stages"], key=lambda s: (s["pipeline"] != NL_ID, s["order"])) if s["pipeline"] in IN_SCOPE]

# ----------------------------------------------------------------------------- methodology + DQ (dynamic counts)
kpis = [
    dict(k="Bookings QTD", p=["amount", "dealstage", "closedate", "pipeline"], f=f"dealstage IN won stages AND closedate {WIN['qtd']['start']}..{WIN['qtd']['end']} (ET)", formula="Σ amount", x="Renewal pipeline; Closed Lost", n=f"{len(q_won)} deals"),
    dict(k="Bookings YTD", p=["amount", "dealstage", "closedate", "pipeline"], f=f"dealstage IN won stages AND closedate {WIN['ytd']['start']}..{WIN['ytd']['end']} (ET)", formula="Σ amount", x="Renewal pipeline; Closed Lost", n=f"{len(won)} deals"),
    dict(k="Average sales price", p=["amount"], f="same as Bookings YTD", formula="Σ amount ÷ count", x="none beyond scope", n=f"{len(won)} deals"),
    dict(k="Average sales cycle", p=["createdate", "closedate"], f="same as Bookings YTD", formula="mean(closedate − createdate) in calendar days (ET)", x=f"tile: none (migration cohort tagged); secondary figure excludes createdate < {CFG['migration']['date_cutoff']}", n=f"{len(won)} all / {n_clean} post-cutoff"),
    dict(k="New Logo bookings", p=["pipeline", "amount"], f=f"Bookings YTD AND pipeline = {NL_ID}", formula="Σ amount; % = ÷ Bookings YTD", x="—", n=f"{sum(1 for x in won if x['pipe']=='N')} deals"),
    dict(k="Upsell / Expansion bookings", p=["pipeline", "amount"], f=f"Bookings YTD AND pipeline = {CFG['pipelines']['upsell_expansion']['id']}", formula="Σ amount; % = ÷ Bookings YTD", x="—", n=f"{sum(1 for x in won if x['pipe']=='U')} deals"),
    dict(k="Gross open pipeline", p=["amount", "dealstage", "pipeline"], f="pipeline in scope AND dealstage NOT IN terminal stages", formula="Σ amount", x="Renewal pipeline", n=f"{len(open_)} deals"),
    dict(k="Weighted open pipeline", p=["weighted_amount", "amount", "hs_deal_stage_probability"], f="same as Gross open pipeline", formula="Σ weighted, where weighted = weighted_amount if populated, else amount × hs_deal_stage_probability", x="—", n=f"{len(open_)} deals ({len(open_)-len(fb)} stored, {len(fb)} fallback)"),
    dict(k="Current-quarter forecast", p=["amount", "weighted_amount", "hs_deal_stage_probability", "closedate"], f=f"Bookings QTD + open deals with closedate in {WIN['qtd']['label']}", formula="Σ won amount + Σ open weighted", x=f"open deals closing outside the quarter ({len(open_)-len(q_open)})", n=f"{len(q_won)} won + {len(q_open)} open"),
    dict(k="Current-year forecast", p=["amount", "weighted_amount", "hs_deal_stage_probability", "closedate"], f=f"Bookings YTD + open deals with closedate in {WIN['ytd']['label']}", formula="Σ won amount + Σ open weighted", x=f"open deals closing outside the year ({len(open_)-len(y_open)})", n=f"{len(won)} won + {len(y_open)} open"),
]
dq = [
    dict(id="DQ-1", sev="Medium", text=f"Two ACV-style amount fields: native <code>amount</code> and custom <code>acv</code>. <code>acv</code> is populated on {sum(1 for x in won if x['acv'] is not None)} of {len(won)} closed-won FY deals (sum {usd(wacv)} vs {usd(wa)}); <code>hs_acv</code> is zero everywhere. No <code>__c</code>-suffixed amount field exists.", n=f"{sum(1 for x in won if x['acv'] is None)} won deals blank", handling="<code>amount</code> used throughout (confirmed decision). Delta documented in methodology."),
    dict(id="DQ-2", sev="High" if n_clean < 10 else "Low", text=f"{n_clean} of {len(won)} closed-won FY deals were created on or after the {CFG['migration']['date_cutoff']} migration cutoff; the other {n_mig} carry Salesforce-migrated create dates.", n=f"{n_mig} of {len(won)}", handling="Sales-cycle tile computed on all deals per confirmed definition, tagged 'migration cohort included'; post-cutoff mean shown with its n and a data-gap marker when n is 0."),
    dict(id="DQ-3", sev="High", text="No authoritative SMB / Mid-Market / Enterprise field. Deal <code>segment</code> is free text and collapses Mid-Market with Enterprise; company <code>segment</code> and <code>unit_range</code> option values no longer match their labels; company <code>client_segment</code> uses a fourth taxonomy; Notion pages disagree on the Mid-Market ceiling.", n="4 conflicting sources", handling="Segment derived from <code>units__c</code> with confirmed thresholds. Raw value shown alongside. Recommend a single governed enumeration on the deal object."),
    dict(id="DQ-4", sev="Medium", text=f"<code>weighted_amount</code> is populated on only {len(open_)-len(fb)} of {len(open_)} open deals ({usd(ow_stored)}). The {len(fb)} blank deals carry {usd(sum(x['amount'] for x in fb))} gross and fall back to amount × <code>hs_deal_stage_probability</code> ({usd(ow_fb)}). The stored field has no description in the portal and does not equal amount × stage probability on every populated deal, so the displayed weighted total mixes two methods.", n=f"{len(fb)} of {len(open_)} open deals · {usd(ow_fb)} fallback", handling="Confirmed rule: stored value when present, fallback otherwise; Closed Won = 100% of amount, Closed Lost = $0. Tiles show the stored / fallback split; fallback deals are marked in the table and drilldowns."),
    dict(id="DQ-5", sev="Low", text=f"<code>hs_forecast_amount</code> equals <code>amount</code> on every open deal; forecast probability is not configured in this portal.", n=f"{len(open_)} open deals", handling="Not used."),
    dict(id="DQ-6", sev="Low", text="Manual stage-probability override: " + (", ".join(f"{x['name']} ({x['prob']} vs stage default {x['stageProb']})" for x in overrides) or "none"), n=f"{len(overrides)} deal(s)", handling="Deal-level probability used as stored (affects fallback weighting only)."),
    dict(id="DQ-7", sev="Medium" if past_due else "Low", text="Open deals with close dates in the past: " + ("; ".join(f"{x['name']} ({x['close']})" for x in sorted(past_due, key=lambda x: x['close'])) or "none") + ".", n=f"{len(past_due)} deals · {usd(sum(x['amount'] for x in past_due))}", handling="Kept in gross and weighted pipeline; those dated within the current quarter still count toward the quarter forecast. Tagged 'past due' in table and drilldowns. Recommend rep review."),
    dict(id="DQ-8", sev="Medium", text=f"Pipeline concentration: the 8 largest open deals total {usd(top8_amt)} of {usd(og)} gross ({top8_amt/og*100:.0f}%); owners: {', '.join(sorted({x['owner'] for x in top8}))}.", n="8 deals", handling="No adjustment. Owner and segment filters isolate the effect; weighted view is the more conservative read."),
    dict(id="DQ-9", sev="Low", text="Stage probabilities were read from deal records (observed values by stage), not from pipeline settings, which the connector does not expose.", n=f"{len([s for s in stages_meta if not s['closed']])} open stages", handling="Documented in methodology. Verify against Settings → Objects → Deals → Pipelines if probabilities change."),
    dict(id="DQ-10", sev="Low", text=f"A third deal pipeline, Renewal (<code>{CFG['pipelines']['renewal']['id']}</code>), exists in the portal.", n="1 pipeline", handling="Excluded by confirmed decision; not represented in any tile."),
    dict(id="DQ-11", sev="Low", text="Deal owners are resolved via the owners API each run; inactive owners are labeled. " + (f"Inactive owners in scope: {', '.join(sorted({x['owner'] for x in deals if '(inactive)' in x['owner']}))}." if any('(inactive)' in x['owner'] for x in deals) else "No inactive owners in scope."), n=f"{len({x['ownerId'] for x in deals})} owners", handling="Names resolved and applied."),
    dict(id="DQ-12", sev="Medium", text="SDR section 'opportunity' (<code>sdr_owner IS NOT NULL</code>) is a Findigs-specific definition, not a HubSpot-governed concept; it is deliberately broader than 'reached a later pipeline stage'.", n=f"{len(opps)} of {len(pg)} pipeline-generation deals", handling="Documented in methodology. Confirmed 2026-09-23."),
    dict(id="DQ-13", sev="Low", text=f"HubSpot's owner id 8309346 ('Unassigned') is used as an actual <code>sdr_owner</code> value on some deals, distinct from a true-null <code>sdr_owner</code>. It counts toward opportunity count/amount but is excluded from the per-SDR chart's real-person rows.", n=f"{sdr_by_owner.get('8309346', {'n': 0})['n']} deals", handling="Flagged via <code>sdrOwnerReal=false</code> on affected records; per-SDR chart filters on that flag, aggregate tiles do not."),
    dict(id="DQ-14", sev="Low", text="Bare scalar COUNT(*) aggregates against HubSpot's reporting API undercounted on the narrow/recent 30-day SDR control window (49 vs 50 opportunities created; 55/26 vs 58/28 meetings booked/held). GROUP BY-shaped queries and direct record-level pulls agreed with each other at the higher, correct values and were used as the controls.", n="3 metrics affected", handling="Documented for future refreshes: always cross-validate trailing-30-day scalar aggregates against a GROUP BY query or record pull before trusting them as controls."),
    dict(id="DQ-15", sev="Medium", text="SDR-section pipeline-generated-vs-goal by segment has no real goal yet — no quota file has been supplied.", n="3 segments", handling="Placeholder goal = 0 for every segment (config <code>sdr_section.pipeline_goals</code>); build treats goal = 0 as 'no goal configured' and suppresses percent-to-goal. Replace the config block once a quota workbook exists."),
]

meta = dict(
    portal=CFG["portal_id"], asOf=AS_OF, refreshed=SNAP["pulled_at_et"],
    windows=dict(qtd=dict(start=WIN["qtd"]["start"], end=WIN["qtd"]["end"]), ytd=dict(start=WIN["ytd"]["start"], end=WIN["ytd"]["end"])),
    pipes={"N": dict(id=NL_ID, label="New Logo"), "U": dict(id=CFG["pipelines"]["upsell_expansion"]["id"], label="Upsell / Expansion")},
    stages=stages_meta, dq=dq,
    meth=dict(kpis=kpis, amountWon=wa, acvWon=wacv, acvPopulatedWon=sum(1 for x in won if x["acv"] is not None),
              acvEqualsOpen=sum(1 for x in open_ if x["acv"] == x["amount"]), acvBlankOpen=sum(1 for x in open_ if x["acv"] is None),
              nWon=len(won), nMigration=n_mig, nClean=n_clean,
              controls=dict(open_weighted=CTL["open_hs_projected_amount"], open_gross=CTL["open_gross"], weighted_custom=CTL["open_weighted_amount_stored"]),
              wtdNullCount=len(fb), wtdNullAmt=sum(x["amount"] for x in fb), wtdNullProbWeighted=sum(x["probWeighted"] for x in fb), wtdPopCount=len(open_)-len(fb),
              owProb=owp, ow=ow, owStored=ow_stored, owFallback=ow_fb, wtdRefreshed=SNAP.get("supplemental_pulled_at_et", SNAP["pulled_at_et"]),
              tieout=[{k: v for k, v in t.items() if k != "ok"} for t in tie]),
    pg=dict(asOf=AS_OF, qtd=WIN["qtd"], ytd=WIN["ytd"], priorQ=WIN["priorQ"],
            migCutoffLastSF=(mig_dates[-1] if mig_dates else None), migCutoffFirstNative=(nat_dates[0] if nat_dates else None),
            counts=dict(total=len(pg), mig=len(pg_mig), nat=len(pg_nat), migAmt=sum(x["amount"] for x in pg_mig), natAmt=sum(x["amount"] for x in pg_nat), totalAmt=pg_total,
                        q3=len(q3), q3Mig=len(q3_mig), q3MigAmt=sum(x["amount"] for x in q3_mig), scored=len(scored), scoredAmt=sum(x["amount"] for x in scored),
                        zeroAmt=len(zero_amt), zeroAmtNames=[x["name"] for x in zero_amt], nullSrc=0, nullSrcAmt=0, nullSrcNames=[],
                        noClose=len(no_close), nullOwner=0, nullAmt=0, nullParentSrc=len(null_parent), nullParentSrcNames=[x["name"] for x in null_parent],
                        driftNote=" ".join(SNAP.get("notes", []))),
            controls=[{k: v for k, v in t.items() if k != "ok"} for t in pg_tie]),
    sdr=dict(asOf=AS_OF, population=SDR_CFG["population"], qtd=WIN["qtd"], ytd=WIN["ytd"], win30=win30,
             oppCount=len(opps), oppAmount=opp_total_amt,
             byOwner={oid: dict(n=v["n"], a=v["a"], name=owner_name(oid)) for oid, v in sdr_by_owner.items()},
             byChannelRaw={k: dict(n=v["n"], a=v["a"]) for k, v in sdr_by_channel.items()},
             booked30d=len(booked_30d), held30d=len(held_30d), heldToOpp30d=len(held_to_opp_30d),
             bookedBySeg=dict(booked_30d_by_seg),
             opp30dCount=len(opp_30d), opp30dByOwner={oid: dict(n=n, name=owner_name(oid)) for oid, n in opp_30d_by_owner.items()},
             pipelineBySegQtd={k: round(v, 2) for k, v in sdr_pipeline_qtd_by_seg.items()},
             pipelineBySegYtd={k: round(v, 2) for k, v in sdr_pipeline_ytd_by_seg.items()},
             stageByChannel={sid: dict(chans) for sid, chans in stage_by_channel.items()},
             goals=SDR_CFG["pipeline_goals"]["by_segment"], goalsStatus=SDR_CFG["pipeline_goals"]["status"],
             channelMapping=SDR_CFG["channel_mapping"], meetingDefs=SDR_CFG["meeting_definitions"], oppDef=SDR_CFG["opportunity_definition"],
             controls=[{k: v for k, v in t.items() if k != "ok"} for t in sdr_tie]),
)

# ----------------------------------------------------------------------------- render
with open(P("template.html"), encoding="utf-8") as f: tpl = f.read()
payload = "const DEALS = " + json.dumps(deals, ensure_ascii=False, separators=(",", ":")) + ";\nconst PG = " + json.dumps(pg, ensure_ascii=False, separators=(",", ":")) + ";\nconst META = " + json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + ";"
if "/*__DATA__*/" not in tpl: fail(3, "template.html is missing the /*__DATA__*/ placeholder")
html = tpl.replace("/*__DATA__*/", payload)
os.makedirs(P("output"), exist_ok=True)
out_name = CFG["distribution"]["file_name_pattern"].format(as_of=AS_OF)
with open(P("output", out_name), "w", encoding="utf-8") as f: f.write(html)

# tieout.md
lines = [f"# Tie-out — as of {AS_OF} (pulled {SNAP['pulled_at_et']})", "",
         "## Record counts", f"- Open (both pipelines): {len(open_)}", f"- Closed-won FY: {len(won)}", f"- New Logo created FY: {len(pg)}", "",
         "## Headline (unfiltered)",
         f"- Bookings QTD {usd(sum(x['amount'] for x in q_won))} ({len(q_won)}) · YTD {usd(wa)} ({len(won)})",
         f"- Gross open {usd(og)} · weighted {usd(ow)} (stored {usd(ow_stored)} on {len(open_)-len(fb)}, fallback {usd(ow_fb)} on {len(fb)})",
         f"- Forecast quarter {usd(sum(x['amount'] for x in q_won) + sum(x['weighted'] for x in q_open))} · year {usd(wa + sum(x['weighted'] for x in y_open))}",
         f"- Pipeline created QTD {usd(sum(x['amount'] for x in q3))} ({len(q3)}) · YTD {usd(pg_total)} ({len(pg)})", "",
         "## Tier 1–3 tie-out", "| Measure | Pulled | Control | Delta |", "|---|---|---|---|"] + [f"| {t['m']} | {t['a']} | {t['b']} | {t['d']} |" for t in tie] + \
        ["", "## Pipeline generation tie-out", "| Measure | Pulled | Control | Delta |", "|---|---|---|---|"] + [f"| {t['m']} | {t['a']} | {t['b']} | {t['d']} |" for t in pg_tie] + \
        ["", "## SDR section tie-out", "| Measure | Pulled | Control | Delta |", "|---|---|---|---|"] + [f"| {t['m']} | {t['a']} | {t['b']} | {t['d']} |" for t in sdr_tie] + \
        ["", "## Data quality flags", "| ID | Severity | Count |", "|---|---|---|"] + [f"| {d['id']} | {d['sev']} | {d['n']} |" for d in dq] + \
        ["", f"Output: `output/{out_name}`"]
with open(P("output", "tieout.md"), "w", encoding="utf-8") as f: f.write("\n".join(lines) + "\n")

if not args.no_run_log:
    os.makedirs(P("runs"), exist_ok=True)
    run = dict(as_of=AS_OF, pulled=SNAP["pulled_at_et"], built=datetime.now(ET).strftime("%Y-%m-%d %H:%M ET"), open_n=len(open_), won_n=len(won), created_n=len(pg),
               open_gross=round(og, 2), open_weighted=round(ow, 2), weighted_fallback_n=len(fb), won_amount=round(wa, 2), created_amount=round(pg_total, 2),
               past_due_n=len(past_due), swan_coverage=round(len(scored) / len(pg), 3) if pg else None, dq_high=sum(1 for d in dq if d["sev"] == "High"), output=out_name,
               sdr_opp_n=len(opps), sdr_opp_amount=round(opp_total_amt, 2), sdr_booked_30d=len(booked_30d), sdr_held_30d=len(held_30d), sdr_opp_30d=len(opp_30d))
    with open(P("runs", "runs.jsonl"), "a", encoding="utf-8") as f: f.write(json.dumps(run) + "\n")

n_tie_total = len(tie) + len(pg_tie) + len(sdr_tie)
print(f"OK  {out_name}  open={len(open_)} won={len(won)} created={len(pg)} sdr_opp={len(opps)}  gross={usd(og)} weighted={usd(ow)} won={usd(wa)}  tie-out {n_tie_total}/{n_tie_total} reconciled")
