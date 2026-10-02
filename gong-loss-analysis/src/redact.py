"""Shared redaction used for transcripts (05) and Gong AI briefs (05b). One implementation = one behaviour."""
import re
import pandas as pd

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
PHONE = re.compile(r"(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}")
SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
ADDR = re.compile(r"\b\d{2,6}\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl)\b\.?")
STOP = {"the", "and", "property", "properties", "management", "group", "homes", "rentals", "realty", "company", "partners",
        "residential", "llc", "inc", "new", "logo", "living", "communities", "real", "estate", "capital"}

def deal_terms(cohort_indexed, assoc):
    """deal_id -> set of identifying phrases (company names, contact names, deal-name stem)."""
    out = {}
    for _, a in assoc.iterrows():
        terms = set()
        for col in ("company_names", "contact_names"):
            for t in str(a.get(col, "")).split(";"):
                t = t.strip()
                if len(t) > 3: terms.add(t)
                terms |= {w for w in re.split(r"\s+", t) if len(w) > 3 and w.lower() not in STOP}
        out[a.deal_id] = terms
    for did, dn in cohort_indexed.deal_name.items():
        stem = re.split(r"\s+[-–|]\s+", str(dn))[0].strip()
        if len(stem) > 3: out.setdefault(did, set()).add(stem)
    return out

def party_names(parties):
    names = set()
    for p in parties or []:
        for part in re.split(r"\s+", (p.get("name") or "").strip()):
            if len(part) > 2: names.add(part)
    return names

def make_redactor(phrases):
    phrases = sorted({p for p in phrases if p}, key=len, reverse=True)
    name_rx = re.compile(r"\b(" + "|".join(re.escape(x) for x in phrases) + r")\b", re.I) if phrases else None
    def redact(txt):
        n = 0
        for rx, rep in [(EMAIL, "[EMAIL]"), (SSN, "[SSN]"), (PHONE, "[PHONE]"), (ADDR, "[ADDRESS]")]:
            txt, k = rx.subn(rep, txt); n += k
        if name_rx:
            txt, k = name_rx.subn("[REDACTED]", txt); n += k
        return txt, n
    return redact
