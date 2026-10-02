"""Phase 2b: turn raw transcripts into redacted, role-tokenised, TURN-merged text (token trim) + NON-OUTCOME metadata for blind coding.
Outputs: data/prepared/<call_id>.txt, data/prepared/<call_id>.meta.json, data/outputs/redaction_log.csv (counts only)
Blinding: metadata deliberately EXCLUDES outcome, CRM loss reason, loss notes, close date, and highest stage reached.
"""
import json, re, glob
import pandas as pd
from config import RAW, PREPARED, OUT, ROSTER, COHORT, DEAL_ASSOC

ROLE_TOKEN = {"ae": "Findigs-AE", "sdr": "Findigs-SDR", "sales_leader": "Findigs-SalesLeader", "executive": "Findigs-Exec",
              "customer_success": "Findigs-CS", "revops": "Findigs-RevOps", "other": "Findigs-Other", "unknown": "Findigs-Rep"}
from redact import EMAIL, PHONE, deal_terms as build_deal_terms, party_names, make_redactor

def load_parties():
    out = {}
    for f in glob.glob(str(RAW / "calls_extensive" / "*.jsonl")):
        for line in open(f, encoding="utf-8"):
            c = json.loads(line); out[str(c["metaData"]["id"])] = c.get("parties", []) or []
    return out

def main():
    roster = pd.read_csv(ROSTER, dtype=str).fillna(""); role_of = dict(zip(roster.gong_user_id, roster.role))
    m = pd.read_csv(OUT / "call_deal_map.csv", dtype={"deal_id": str, "call_id": str}).set_index("call_id")
    cohort = pd.read_csv(COHORT, dtype=str).set_index("deal_id")
    parties = load_parties(); log = []
    assoc = pd.read_csv(DEAL_ASSOC, dtype=str).fillna("") if DEAL_ASSOC.exists() else pd.DataFrame(columns=["deal_id"])
    deal_terms = build_deal_terms(cohort, assoc)
    for f in sorted(glob.glob(str(RAW / "transcripts" / "*.json"))):
        t = json.loads(open(f, encoding="utf-8").read()); cid = str(t["callId"])
        if cid not in m.index or str(m.loc[cid].in_scope).lower() != "true": continue   # scope rules 1-3 enforced here too
        ps = parties.get(cid, []); tok = {}; names = party_names(ps); ext_i = 0; int_count = {}
        for p in ps:
            sid = str(p.get("speakerId", ""))
            if (p.get("affiliation") == "Internal") or p.get("userId"):
                r = role_of.get(str(p.get("userId", "")), "unknown"); int_count[r] = int_count.get(r, 0) + 1
                tok[sid] = ROLE_TOKEN.get(r, "Findigs-Rep") + ("" if int_count[r] == 1 else f"-{int_count[r]}")
            else:
                ext_i += 1; title = (p.get("title") or "").strip()
                tok[sid] = f"Prospect-{ext_i}" + (f" [{title}]" if title else "")
        did = m.loc[cid].deal_id
        redact = make_redactor(names | deal_terms.get(did, set()))
        lines, n_red = [], 0
        turns = []   # token trim: one line per speaker TURN (consecutive same-speaker segments merged), one timestamp per turn
        for seg in t.get("transcript", []) or []:
            sp = tok.get(str(seg.get("speakerId")), "Unknown-Speaker")
            sents = seg.get("sentences", []) or []
            if not sents: continue
            txt, k = redact(" ".join((x.get("text") or "").strip() for x in sents)); n_red += k
            if turns and turns[-1][1] == sp: turns[-1][2] += " " + txt
            else: turns.append([sents[0].get("start") or 0, sp, txt])
        for start, sp, txt in turns:
            mm, ss = divmod(int(start / 1000), 60)
            lines.append(f"[{mm:02d}:{ss:02d}] {sp}: {txt}")
        r = m.loc[cid]; d = cohort.loc[r.deal_id] if r.deal_id in cohort.index else None
        meta = {"call_id": cid, "deal_ref": r.deal_id, "call_sequence_in_deal": int(r.call_seq), "stage_at_call_per_crm": r.stage_at_call,
                "duration_minutes": round((r.duration_s or 0) / 60, 1), "days_since_deal_created": None if pd.isna(r.days_from_create) else int(r.days_from_create),
                "segment": None if d is None else d.segment, "units": None if d is None else d.units,
                "participants": sorted(set(tok.values())), "transcript_empty": len(lines) == 0}
        (PREPARED / f"{cid}.txt").write_text("\n".join(lines), encoding="utf-8")
        (PREPARED / f"{cid}.meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
        log.append({"call_id": cid, "sentences": len(lines), "redactions": n_red, "empty": len(lines) == 0})
    pd.DataFrame(log).to_csv(OUT / "redaction_log.csv", index=False)
    # Automated leak scan: residual emails/phones and capitalised two-word sequences that look like person names
    leaks = []
    for f in sorted(PREPARED.glob("*.txt")):
        t = f.read_text(encoding="utf-8")
        leaks.append({"call_id": f.stem, "residual_email": len(EMAIL.findall(t)), "residual_phone": len(PHONE.findall(t)),
                      "possible_names": len(re.findall(r"(?<![\[\w])[A-Z][a-z]{2,} [A-Z][a-z]{2,}(?![\w\]])", t))})
    pd.DataFrame(leaks).to_csv(OUT / "redaction_leak_scan.csv", index=False)
    print(f"[ok] prepared {len(log)} transcripts; empty: {sum(l['empty'] for l in log)}; redactions: {sum(l['redactions'] for l in log)}. Automated leak scan: see data/outputs/redaction_leak_scan.csv")

if __name__ == "__main__":
    main()
