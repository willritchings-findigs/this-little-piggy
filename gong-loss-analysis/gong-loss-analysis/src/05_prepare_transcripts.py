"""Phase 2b: turn raw transcripts into redacted, role-tokenised text + NON-OUTCOME metadata for blind coding.
Outputs: data/prepared/<call_id>.txt, data/prepared/<call_id>.meta.json, data/outputs/redaction_log.csv (counts only)
Blinding: metadata deliberately EXCLUDES outcome, CRM loss reason, loss notes, close date, and highest stage reached.
"""
import json, re, glob
import pandas as pd
from config import RAW, PREPARED, OUT, ROSTER, COHORT, DEAL_ASSOC

ROLE_TOKEN = {"ae": "Findigs-AE", "sdr": "Findigs-SDR", "sales_leader": "Findigs-SalesLeader", "executive": "Findigs-Exec",
              "customer_success": "Findigs-CS", "revops": "Findigs-RevOps", "other": "Findigs-Other", "unknown": "Findigs-Rep"}
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"); PHONE = re.compile(r"(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}")
SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
ADDR = re.compile(r"\b\d{2,6}\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl)\b\.?")

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
    STOP = {"the", "and", "property", "properties", "management", "group", "homes", "rentals", "realty", "company", "partners", "residential", "llc", "inc", "new", "logo"}
    deal_terms = {}   # deal_id -> identifying phrases to redact (company names, contact names, deal-name stem)
    assoc = pd.read_csv(DEAL_ASSOC, dtype=str).fillna("") if DEAL_ASSOC.exists() else pd.DataFrame(columns=["deal_id"])
    for _, a_ in assoc.iterrows():
        terms = set()
        for col in ("company_names", "contact_names"):
            for t in str(a_.get(col, "")).split(";"):
                t = t.strip()
                if len(t) > 3: terms.add(t)
                terms |= {w for w in re.split(r"\s+", t) if len(w) > 3 and w.lower() not in STOP}
        deal_terms[a_.deal_id] = terms
    for did, dn in cohort.deal_name.items():
        stem = re.split(r"\s+[-–|]\s+", str(dn))[0].strip()
        if len(stem) > 3: deal_terms.setdefault(did, set()).add(stem)
    for f in sorted(glob.glob(str(RAW / "transcripts" / "*.json"))):
        t = json.loads(open(f, encoding="utf-8").read()); cid = str(t["callId"])
        if cid not in m.index: continue
        ps = parties.get(cid, []); tok = {}; names = set(); ext_i = 0; int_count = {}
        for p in ps:
            for part in re.split(r"\s+", (p.get("name") or "").strip()):
                if len(part) > 2: names.add(part)
            sid = str(p.get("speakerId", ""))
            if (p.get("affiliation") == "Internal") or p.get("userId"):
                r = role_of.get(str(p.get("userId", "")), "unknown"); int_count[r] = int_count.get(r, 0) + 1
                tok[sid] = ROLE_TOKEN.get(r, "Findigs-Rep") + ("" if int_count[r] == 1 else f"-{int_count[r]}")
            else:
                ext_i += 1; title = (p.get("title") or "").strip()
                tok[sid] = f"Prospect-{ext_i}" + (f" [{title}]" if title else "")
        did = m.loc[cid].deal_id
        phrases = sorted((names | deal_terms.get(did, set())), key=len, reverse=True)
        NAME_RX = re.compile(r"\b(" + "|".join(re.escape(x) for x in phrases) + r")\b", re.I) if phrases else None
        lines, n_red = [], 0
        for seg in t.get("transcript", []) or []:
            sp = tok.get(str(seg.get("speakerId")), "Unknown-Speaker")
            for s in seg.get("sentences", []) or []:
                txt = s.get("text", "")
                for rx, rep in [(EMAIL, "[EMAIL]"), (SSN, "[SSN]"), (PHONE, "[PHONE]"), (ADDR, "[ADDRESS]")]:
                    txt, k = rx.subn(rep, txt); n_red += k
                if NAME_RX:
                    txt, k = NAME_RX.subn("[REDACTED]", txt); n_red += k
                mm, ss = divmod(int((s.get("start") or 0) / 1000), 60)
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
