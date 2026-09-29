#!/usr/bin/env python3
"""
Findigs GTM executive dashboard — build step.

Reads:   config.json, data/snapshot.json, data/controls.json,
         data/deals_open.json, data/deals_won.json, data/deals_created.json, data/swan_scores.json
Writes:  output/findigs_gtm_executive_dashboard_<as_of>.html, output/tieout.md, runs/runs.jsonl

Exit codes: 0 = built and reconciled; 2 = tie-out failure (nothing written to output/);
            3 = schema/config problem. The refresh skill treats any non-zero exit as "stop and report".

Usage: python build.py [--as-of YYYY-MM-DD] [--no-run-log] [--diagnostic]

--diagnostic: for on-demand "why does this say X" questions. Writes the HTML,
tieout.md, and slack_post.txt under output/diagnostic/ instead of output/, and
never writes to data/kpi_history.json or runs/runs.jsonl — a diagnostic run must
not pollute the Compare vs baseline or the audit log. Implies --no-run-log.
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
ap.add_argument("--diagnostic", action="store_true", help="scratch output only; never writes kpi_history.json or runs.jsonl")
args = ap.parse_args()
DIAG = args.diagnostic
NO_RUN_LOG = args.no_run_log or DIAG

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
date_only = lambda s: s[:10] if s else None  # HubSpot "date" properties are UTC midnight for the intended calendar date; never ET-shift them
CHANNEL_BUCKET = {k: v for k, v in CFG["sdr_section"]["channel_buckets"].items() if k in ("Outbound", "Inbound", "Referral", "Event")}
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
    sdr_id = p.get(F["sdr_owner"]); is_sdr_opp = sdr_id is not None and sdr_id != ""
    chan_raw = p.get(F["channel_source"]) or None
    return dict(id=str(r["id"]), name=p["dealname"], pipe="N", pipeLabel="New Logo", stageId=sid, stage=st["label"], owner=owner_name(p[F["owner"]]), ownerId=str(p[F["owner"]]),
                amount=amt, units=int(units), seg=seg(units), close=et_date(p.get(F["close_date"])), created=et_date(p.get(F["create_date"])),
                src=src, srcParent=parent, srcGroup=SRC_GROUP.get(parent[:2], "Unassigned"), recSrc=rs, migrated=(rs == CFG["migration"]["record_source_value"]),
                hsScore=num(p.get("hs_deal_score")), swan=sw, band=("No Swan score" if sw is None else f"Swan {sw}"),
                won=sid in WON_IDS, lost=sid in LOST_IDS, weighted=w, wtdFallback=fb, pastDue=False, migration=(rs == CFG["migration"]["record_source_value"]),
                isSdrOpp=is_sdr_opp, sdrOwnerId=(str(sdr_id) if is_sdr_opp else None), sdrOwnerName=(owner_name(sdr_id) if is_sdr_opp else None),
                demoBooked=date_only(p.get(F["demo_booked"])), demoHeld=(p.get(F["demo_completed"]) == "Yes"),
                channelRaw=chan_raw, channel=(CHANNEL_BUCKET.get(chan_raw, "Unassigned") if is_sdr_opp else None))

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

qtd_amt = sum(x["amount"] for x in q_won)
asp = round(wa / len(won), 2) if won else None
cycle_days = [(date.fromisoformat(x["close"]) - date.fromisoformat(x["created"])).days for x in won if x["close"] and x["created"]]
cycle = round(sum(cycle_days) / len(cycle_days), 1) if cycle_days else None
nl_amt = sum(x["amount"] for x in won if x["pipe"] == "N"); ue_amt = sum(x["amount"] for x in won if x["pipe"] == "U")
fq_amt = qtd_amt + sum(x["weighted"] for x in q_open); fy_amt = wa + sum(x["weighted"] for x in y_open)

pg_total = sum(x["amount"] for x in pg); pg_mig = [x for x in pg if x["migrated"]]; pg_nat = [x for x in pg if not x["migrated"]]
q3 = [x for x in pg if inw(x["created"], WIN["qtd"])]; q3_mig = [x for x in q3 if x["migrated"]]
zero_amt = [x for x in pg if x["amount"] == 0]; scored = [x for x in pg if x["swan"] is not None]
null_parent = [x for x in pg if x["srcParent"] == "Unassigned"]; no_close = [x for x in pg if not x["close"]]
mig_dates = sorted(x["created"] for x in pg_mig); nat_dates = sorted(x["created"] for x in pg_nat)

# ----------------------------------------------------------------------------- SDR section (confirmed 2026-09-23)
sdr_window = {"start": iso(date.fromisoformat(AS_OF) - timedelta(days=29)), "end": AS_OF}
sdr_opps = [x for x in pg if x["isSdrOpp"]]; sdr_total_amt = sum(x["amount"] for x in sdr_opps)
sdr_booked = [x for x in pg if inw(x["demoBooked"], sdr_window)]
sdr_held = [x for x in sdr_booked if x["demoHeld"]]
sdr_held_opp = [x for x in sdr_held if x["isSdrOpp"]]
sdr_opp30 = [x for x in sdr_opps if inw(x["created"], sdr_window)]
sdr_goal = CFG["sdr_section"]["goal_by_segment"]

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
scheck("SDR opportunity count", len(sdr_opps), CTL["sdr_opp_count"], fmt=str, money=False)
scheck("SDR opportunity Σ amount", sdr_total_amt, CTL["sdr_opp_amount"])
for k, v in CTL["sdr_by_channel"].items():
    sub = [x for x in sdr_opps if x["channelRaw"] == (None if k == "null" else k)]
    scheck(f"deal_source_group = {k} count", len(sub), v["n"], fmt=str, money=False); scheck(f"deal_source_group = {k} Σ amount", sum(x["amount"] for x in sub), v["a"])
scheck(f"Meeting booked, trailing 30d ({sdr_window['start']}..{sdr_window['end']})", len(sdr_booked), CTL["sdr_meeting_booked_30d"], fmt=str, money=False)
scheck("Meeting held, trailing 30d (of booked cohort)", len(sdr_held), CTL["sdr_meeting_held_30d"], fmt=str, money=False)
scheck("Held → opportunity, trailing 30d", len(sdr_held_opp), CTL["sdr_opp_from_held_30d"], fmt=str, money=False)
scheck("Opportunities generated, trailing 30d (createdate)", len(sdr_opp30), CTL["sdr_opp_30d_count"], fmt=str, money=False)
scheck("Opportunities generated Σ amount, trailing 30d", sum(x["amount"] for x in sdr_opp30), CTL["sdr_opp_30d_amount"])
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
    sdr=dict(asOf=AS_OF, qtd=WIN["qtd"], ytd=WIN["ytd"], window=sdr_window, goalBySegment=sdr_goal,
             counts=dict(total=len(sdr_opps), totalAmt=sdr_total_amt, booked=len(sdr_booked), held=len(sdr_held), heldOpp=len(sdr_held_opp),
                         opp30=len(sdr_opp30), opp30Amt=sum(x["amount"] for x in sdr_opp30),
                         nonSdrCount=len(pg) - len(sdr_opps), blankChannel=sum(1 for x in sdr_opps if x["channelRaw"] is None)),
             controls=[{k: v for k, v in t.items() if k != "ok"} for t in sdr_tie],
             dq=[
                 dict(id="SDR-1", sev="Medium", text=f"<code>sdr_owner_new</code> exists alongside <code>sdr_owner</code> and diverges heavily from it on the same deals (a team-reassignment pattern, verified 2026-09-23). Every live currently-configured HubSpot saved report for SDR reporting ('Demos Booked by SDR', 'Opps Generated by SDR', 'SDR Outbound By Stage', 8 per-rep 'Quota Q3' reports) groups by <code>sdr_owner_new</code> instead; one of those tiles ('SDR Outbound By Stage') inconsistently filters on <code>sdr_owner</code> but charts by <code>sdr_owner_new</code>. Re-verified 2026-09-28: recent-deal (last 30 days) real-assignment rate favors <code>sdr_owner</code> (100% vs 88.7%).", n="7 distinct SDR owners resolved", handling="This dashboard follows the Notion-confirmed decision (<code>sdr_owner</code>). Not reconciled with the live HubSpot reports' choice of <code>sdr_owner_new</code> — flagged, not resolved."),
                 dict(id="SDR-2", sev="Medium", text=f"Three source-bucketing fields exist: <code>deal_source_drill_down</code> (used elsewhere in this dashboard for Pipeline Generation source attribution), <code>attribution_source_drill_down</code> (used by the live 'SDR Outbound By Stage' HubSpot tile), and <code>deal_source_group</code> (used here, per the confirmed decision). Verified 2026-09-28: on the 759 New Logo deals (all-time) where <code>deal_source_drill_down</code> and <code>attribution_source_drill_down</code> are both populated, they disagree 100% of the time.", n="3 fields, not interchangeable", handling="This section uses only <code>deal_source_group</code>, set independently of either drill-down field, per the confirmed decision."),
                 dict(id="SDR-3", sev="Low", text=f"The confirmed 'SDR opportunity' definition (<code>sdr_owner</code> populated, including HubSpot's 'Unassigned' placeholder) matches {len(sdr_opps)} of {len(pg)} New Logo FY deals ({len(sdr_opps)/len(pg)*100:.1f}%) — {len(pg)-len(sdr_opps)} deal(s) have a genuinely blank <code>sdr_owner</code>.", n=f"{len(pg)-len(sdr_opps)} non-SDR deal(s)", handling="Deliberately broad by confirmed decision; not narrowed to a later pipeline stage. Recorded here so the near-universal match rate is visible rather than assumed."),
                 dict(id="SDR-4", sev="High", text="No pipeline quota/goal field or file exists in HubSpot for any segment. A FY2027 capacity/quota workbook exists in Drive (checked 2026-09-28) but does not apply here: it targets FY2027 (this dashboard's fiscal year is calendar 2026), is scenario-based (Base/Conservative/Moderate/Aggressive — four different targets, no single confirmed number), and uses a different segment taxonomy (SMB floor-excluded below 500 units, plus a separate Strategic tier) than this dashboard's governed 3-band segment_rule.", n="0 of 3 segments configured", handling="Confirmed placeholder: goal = 0 for every segment, treated as 'not configured' — never estimated, never shown as $0 achievement. Replace the config block wholesale once a quota workbook confirmed for calendar FY2026 and this dashboard's segment bands is supplied."),
                 dict(id="SDR-5", sev="Low", text=f"Held → opportunity conversion in the trailing-30-day window is {len(sdr_held_opp)} of {len(sdr_held)} ({'100%' if sdr_held and len(sdr_held_opp)==len(sdr_held) else (str(round(len(sdr_held_opp)/len(sdr_held)*100,1))+'%' if sdr_held else 'no held meetings in window')}) — a near-mechanical consequence of SDR-3's near-universal <code>sdr_owner</code> population, not necessarily a meaningful efficiency signal.", n=f"{len(sdr_held_opp)} of {len(sdr_held)}", handling="Shown as confirmed; this flag exists so the tile isn't read as a meaningful efficiency metric without this context."),
                 dict(id="SDR-6", sev="Low", text=f"<code>deal_source_group</code> is blank on {sum(1 for x in sdr_opps if x['channelRaw'] is None)} of {len(sdr_opps)} SDR opportunities in this FY2026 New Logo population — much lower than the ~72% blank rate observed 2026-09-28 across the full historical (all-time, all-pipeline) SDR-owned population; the field appears to be reliably populated on recent New Logo deals specifically.", n=f"{sum(1 for x in sdr_opps if x['channelRaw'] is None)} of {len(sdr_opps)}", handling="Bucketed as 'Unassigned', never estimated."),
                 dict(id="SDR-7", sev="Low", text="<code>demo_completed_date__c</code> has 0 population on any deal created since 2026-08-01 (re-verified 2026-09-28) — dead field since the Salesforce migration cutover.", n="0 recent records", handling="Not used. 'Meeting held' is a status flag (<code>demo_completed__c</code> = 'Yes') with no reliable date of its own."),
             ]),
)

# ----------------------------------------------------------------------------- Compare vs history (compact, no deal-level data)
out_name = CFG["distribution"]["file_name_pattern"].format(as_of=AS_OF)
hist_entry = dict(asOf=AS_OF, file=out_name,
                   tier1=dict(qtd=round(qtd_amt, 2), ytd=round(wa, 2), asp=asp, cycle=cycle, nl=round(nl_amt, 2), ue=round(ue_amt, 2),
                              gross=round(og, 2), wtd=round(ow, 2), fq=round(fq_amt, 2), fy=round(fy_amt, 2)),
                   pg=dict(cqtd=round(sum(x["amount"] for x in q3), 2), cytd=round(pg_total, 2), nqtd=len(q3), nytd=len(pg)),
                   sdr=dict(booked30=len(sdr_booked), held30=len(sdr_held), opp30=len(sdr_opp30),
                            heldopp30=(round(len(sdr_held_opp) / len(sdr_held), 4) if sdr_held else None)))
HIST_PATH = P("data", "kpi_history.json")
history = load("data/kpi_history.json") if os.path.exists(HIST_PATH) else []
history = [h for h in history if h["asOf"] != AS_OF] + [hist_entry]
history.sort(key=lambda h: h["asOf"])
HIST_WINDOW_WEEKS = CFG.get("compare_vs", {}).get("history_window_weeks")
if HIST_WINDOW_WEEKS:
    cutoff = iso(date.fromisoformat(AS_OF) - timedelta(weeks=HIST_WINDOW_WEEKS))
    history = [h for h in history if h["asOf"] >= cutoff]
cur_idx = next(i for i, h in enumerate(history) if h["asOf"] == AS_OF)
prior_entry = history[cur_idx - 1] if cur_idx > 0 else None
if not DIAG:
    with open(HIST_PATH, "w", encoding="utf-8") as f: json.dump(history, f, ensure_ascii=False, separators=(",", ":"))

# ----------------------------------------------------------------------------- render
OUT_DIR = P("output", "diagnostic") if DIAG else P("output")
with open(P("template.html"), encoding="utf-8") as f: tpl = f.read()
payload = "const DEALS = " + json.dumps(deals, ensure_ascii=False, separators=(",", ":")) + ";\nconst PG = " + json.dumps(pg, ensure_ascii=False, separators=(",", ":")) + ";\nconst META = " + json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + ";\nconst HISTORY = " + json.dumps(history, ensure_ascii=False, separators=(",", ":")) + ";"
if "/*__DATA__*/" not in tpl: fail(3, "template.html is missing the /*__DATA__*/ placeholder")
html = tpl.replace("/*__DATA__*/", payload)
os.makedirs(OUT_DIR, exist_ok=True)
with open(os.path.join(OUT_DIR, out_name), "w", encoding="utf-8") as f: f.write(html)

# tieout.md
lines = [f"# Tie-out — as of {AS_OF} (pulled {SNAP['pulled_at_et']})", "",
         "## Record counts", f"- Open (both pipelines): {len(open_)}", f"- Closed-won FY: {len(won)}", f"- New Logo created FY: {len(pg)}", "",
         "## Headline (unfiltered)",
         f"- Bookings QTD {usd(sum(x['amount'] for x in q_won))} ({len(q_won)}) · YTD {usd(wa)} ({len(won)})",
         f"- Gross open {usd(og)} · weighted {usd(ow)} (stored {usd(ow_stored)} on {len(open_)-len(fb)}, fallback {usd(ow_fb)} on {len(fb)})",
         f"- Forecast quarter {usd(sum(x['amount'] for x in q_won) + sum(x['weighted'] for x in q_open))} · year {usd(wa + sum(x['weighted'] for x in y_open))}",
         f"- Pipeline created QTD {usd(sum(x['amount'] for x in q3))} ({len(q3)}) · YTD {usd(pg_total)} ({len(pg)})",
         f"- SDR opportunities {usd(sdr_total_amt)} ({len(sdr_opps)}) · trailing 30d: booked {len(sdr_booked)}, held {len(sdr_held)}, opportunities {len(sdr_opp30)}", "",
         "## Tier 1–3 tie-out", "| Measure | Pulled | Control | Delta |", "|---|---|---|---|"] + [f"| {t['m']} | {t['a']} | {t['b']} | {t['d']} |" for t in tie] + \
        ["", "## Pipeline generation tie-out", "| Measure | Pulled | Control | Delta |", "|---|---|---|---|"] + [f"| {t['m']} | {t['a']} | {t['b']} | {t['d']} |" for t in pg_tie] + \
        ["", "## SDR section tie-out", "| Measure | Pulled | Control | Delta |", "|---|---|---|---|"] + [f"| {t['m']} | {t['a']} | {t['b']} | {t['d']} |" for t in sdr_tie] + \
        ["", "## Data quality flags", "| ID | Severity | Count |", "|---|---|---|"] + [f"| {d['id']} | {d['sev']} | {d['n']} |" for d in dq] + \
        ["", "## SDR section data quality flags", "| ID | Severity | Count |", "|---|---|---|"] + [f"| {d['id']} | {d['sev']} | {d['n']} |" for d in meta['sdr']['dq']] + \
        ["", f"Output: `output/{'diagnostic/' if DIAG else ''}{out_name}`"]
with open(os.path.join(OUT_DIR, "tieout.md"), "w", encoding="utf-8") as f: f.write("\n".join(lines) + "\n")

# ----------------------------------------------------------------------------- slack_post.txt (model never types a number into Slack)
def pct_delta(cur, base):
    if base in (None, 0) or cur is None: return None
    return (cur - base) / base * 100

MC_THRESHOLD = CFG.get("compare_vs", {}).get("material_change_threshold_pct", 10)
material = []
if prior_entry:
    checks = [
        ("Bookings QTD", hist_entry["tier1"]["qtd"], prior_entry["tier1"]["qtd"]),
        ("Bookings YTD", hist_entry["tier1"]["ytd"], prior_entry["tier1"]["ytd"]),
        ("Gross open pipeline", hist_entry["tier1"]["gross"], prior_entry["tier1"]["gross"]),
        ("Weighted open pipeline", hist_entry["tier1"]["wtd"], prior_entry["tier1"]["wtd"]),
        ("Quarter forecast", hist_entry["tier1"]["fq"], prior_entry["tier1"]["fq"]),
        ("Year forecast", hist_entry["tier1"]["fy"], prior_entry["tier1"]["fy"]),
        ("Pipeline created QTD", hist_entry["pg"]["cqtd"], prior_entry["pg"]["cqtd"]),
        ("Pipeline created YTD", hist_entry["pg"]["cytd"], prior_entry["pg"]["cytd"]),
    ]
    if prior_entry.get("sdr") and hist_entry.get("sdr"):
        checks.append(("SDR opportunities generated (30d)", hist_entry["sdr"]["opp30"], prior_entry["sdr"]["opp30"]))
    for label, cur, base in checks:
        d = pct_delta(cur, base)
        if d is not None and abs(d) >= MC_THRESHOLD:
            material.append(f"{label} {'+' if d >= 0 else ''}{d:.0f}% vs {prior_entry['asOf']}")
dq_high_n = sum(1 for d in dq if d["sev"] == "High") + sum(1 for d in meta["sdr"]["dq"] if d["sev"] == "High")
if dq_high_n: dq_line = f"{dq_high_n} High-severity data-quality flag(s) — see tieout.md."
elif material: dq_line = "; ".join(material) + "."
else: dq_line = "No new data-quality flags."

slack_lines = [
    f"GTM executive dashboard — refreshed {date.fromisoformat(AS_OF).strftime('%b %-d, %Y')}",
    f"Bookings QTD {usd(sum(x['amount'] for x in q_won))} ({len(q_won)} deals) · YTD {usd(wa)} ({len(won)})",
    f"Gross open pipeline {usd(og)} · weighted {usd(ow)} · quarter forecast {usd(sum(x['amount'] for x in q_won) + sum(x['weighted'] for x in q_open))} · year forecast {usd(wa + sum(x['weighted'] for x in y_open))}",
    f"Pipeline created QTD {usd(sum(x['amount'] for x in q3))} ({len(q3)}) · YTD {usd(pg_total)} ({len(pg)})",
    f"SDR opportunities {usd(sdr_total_amt)} ({len(sdr_opps)}) · trailing 30d: booked {len(sdr_booked)}, held {len(sdr_held)}, opportunities {len(sdr_opp30)}",
    "<DRIVE_LINK>",
    f"Sources and methodology are in the file. {dq_line}",
]
with open(os.path.join(OUT_DIR, "slack_post.txt"), "w", encoding="utf-8") as f: f.write("\n".join(slack_lines) + "\n")

if not NO_RUN_LOG:
    os.makedirs(P("runs"), exist_ok=True)
    run = dict(as_of=AS_OF, pulled=SNAP["pulled_at_et"], built=datetime.now(ET).strftime("%Y-%m-%d %H:%M ET"), open_n=len(open_), won_n=len(won), created_n=len(pg),
               open_gross=round(og, 2), open_weighted=round(ow, 2), weighted_fallback_n=len(fb), won_amount=round(wa, 2), created_amount=round(pg_total, 2),
               past_due_n=len(past_due), swan_coverage=round(len(scored) / len(pg), 3) if pg else None, dq_high=sum(1 for d in dq if d["sev"] == "High"),
               sdr_opp_n=len(sdr_opps), sdr_opp_amount=round(sdr_total_amt, 2), sdr_booked_30d=len(sdr_booked), sdr_held_30d=len(sdr_held), output=out_name)
    with open(P("runs", "runs.jsonl"), "a", encoding="utf-8") as f: f.write(json.dumps(run) + "\n")

print(f"OK  {out_name}  open={len(open_)} won={len(won)} created={len(pg)} sdr_opp={len(sdr_opps)}  gross={usd(og)} weighted={usd(ow)} won={usd(wa)}  tie-out {len(tie)+len(pg_tie)+len(sdr_tie)}/{len(tie)+len(pg_tie)+len(sdr_tie)} reconciled" + ("  [DIAGNOSTIC — not published, history untouched]" if DIAG else ""))
