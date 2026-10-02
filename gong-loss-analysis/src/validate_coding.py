"""Validate + ingest subagent output for one work packet. Run by each subagent after it writes its staged files.
  python src/validate_coding.py --packet data/work/calls/packet_003.json
For every item in the packet: staged JSON must exist, match the packet's schema, contain no emails/phone numbers,
and keep every evidence/quote string <= 25 words. Valid items are wrapped in the standard envelope (prompt_version from
the packet, model = claude-code-subagent) and written to the packet's output_dir. Exit code 1 if anything is missing/invalid,
with one short line per problem so the subagent can fix and re-run. Never prints transcript content."""
import argparse, json, re, sys, datetime as dt
from pathlib import Path
import jsonschema
from config import ROOT

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"); PHONE = re.compile(r"\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}")
QUOTE_KEYS = {"evidence", "quote"}

def walk(o, path=""):
    if isinstance(o, dict):
        for k, v in o.items(): yield from walk(v, f"{path}.{k}" if path else k)
    elif isinstance(o, list):
        for i, v in enumerate(o): yield from walk(v, f"{path}[{i}]")
    else:
        yield path, o

def check(obj):
    probs = []
    for p, v in walk(obj):
        if isinstance(v, str):
            if EMAIL.search(v) or PHONE.search(v): probs.append(f"PII pattern in {p}")
            if p.split(".")[-1].split("[")[0] in QUOTE_KEYS and len(v.split()) > 25: probs.append(f"quote >25 words in {p}")
    return probs

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--packet", required=True); a = ap.parse_args()
    pk = json.loads(Path(a.packet).read_text())
    schema = json.loads((ROOT / pk["schema_file"]).read_text())
    stage = ROOT / pk["staging_dir"]; out = ROOT / pk["output_dir"]; out.mkdir(parents=True, exist_ok=True)
    ok, bad = 0, []
    for it in pk["items"]:
        sid = it["id"]; sp = stage / f"{sid}.json"
        if not sp.exists(): bad.append(f"{sid}: missing staged file {sp.relative_to(ROOT)}"); continue
        try:
            obj = json.loads(sp.read_text(encoding="utf-8"))
            if pk["kind"] in ("calls", "calibration", "reliability") and obj.get("_skipped"):
                env_body = {"_skipped": obj["_skipped"]}
            else:
                jsonschema.validate(obj, schema)
                pr = check(obj)
                if pr: bad.append(f"{sid}: " + "; ".join(pr[:3])); continue
                env_body = obj
        except json.JSONDecodeError as e:
            bad.append(f"{sid}: invalid JSON ({e.msg} line {e.lineno})"); continue
        except jsonschema.ValidationError as e:
            bad.append(f"{sid}: schema error at {'/'.join(map(str, e.absolute_path)) or 'root'}: {e.message[:160]}"); continue
        env = {"prompt_version": pk["prompt_version"], "model": "claude-code-subagent", "packet": pk["packet_id"], "coded_at": dt.datetime.utcnow().isoformat() + "Z", "usage": {}}
        if pk["kind"] == "deals":
            env.update({"deal_id": sid, "calls_used": it.get("calls_used"), "synthesis": env_body})
        elif pk["kind"] == "briefs":
            env.update({"deal_id": sid, "coding": env_body})
        else:
            env.update({"call_id": sid, "deal_id": it.get("deal_id"), "coding": env_body})
        (out / f"{sid}.json").write_text(json.dumps(env, ensure_ascii=False, indent=1), encoding="utf-8"); ok += 1
    print(f"{pk['packet_id']}: {ok}/{len(pk['items'])} valid and ingested" + (f"; {len(bad)} problems:" if bad else ""))
    for b in bad: print("  - " + b)
    sys.exit(1 if bad else 0)

if __name__ == "__main__":
    main()
