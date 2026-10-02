"""OFFLINE SMOKE TEST ONLY: random schema-valid codings in place of LLM output (06/07)."""
import json, glob, sys, random
from pathlib import Path
import jsonschema, pandas as pd
ROOT = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(ROOT / "src")); sys.path.insert(0, str(ROOT / "tests"))
import re
from config import PREPARED, CODED, SCHEMA, OUT, PROMPTS
PV = re.search(r"prompt_version:\s*(\S+)", (PROMPTS / "call_coding_prompt.md").read_text()).group(1)
PVD = re.search(r"prompt_version:\s*(\S+)", (PROMPTS / "deal_synthesis_prompt.md").read_text()).group(1)
from make_mock_data import gen
sc = json.loads((SCHEMA / "call_coding_schema.json").read_text()); sd = json.loads((SCHEMA / "deal_synthesis_schema.json").read_text())
deals = set()
for f in glob.glob(str(PREPARED / "*.meta.json")):
    meta = json.loads(open(f).read()); c = gen(sc); jsonschema.validate(c, sc)
    for d in (CODED / "calls", CODED / "reliability"):
        cc = c if d.name == "calls" or random.random() < .8 else gen(sc)
        (d / f"{meta['call_id']}.json").write_text(json.dumps({"call_id": meta["call_id"], "deal_id": meta["deal_ref"], "prompt_version": PV, "model": "mock", "usage": {}, "coding": cc}))
    deals.add(meta["deal_ref"])
for d in deals:
    s = gen(sd); jsonschema.validate(s, sd)
    (CODED / "deals" / f"{d}.json").write_text(json.dumps({"deal_id": d, "prompt_version": PVD, "synthesis": s}))
pd.DataFrame({"call_id": [Path(f).name.replace(".meta.json","") for f in glob.glob(str(PREPARED / "*.meta.json"))][:60]}).to_csv(OUT / "calibration_calls.csv", index=False)
print(f"mock codings: calls {len(glob.glob(str(PREPARED / '*.meta.json')))}, deals {len(deals)}")
