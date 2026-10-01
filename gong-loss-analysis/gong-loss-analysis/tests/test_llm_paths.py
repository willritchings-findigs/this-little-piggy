"""OFFLINE TEST ONLY: exercises 06 (calibration, batch submit/collect, version skipping) and 07 (batch) with the Anthropic
client mocked. Run in a throwaway copy AFTER make_mock_data.py, 02, 03, 05 (needs data/prepared)."""
import sys, json, glob, importlib.util, types, shutil
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(ROOT / "src")); sys.path.insert(0, str(ROOT / "tests"))
import llm
from make_mock_data import gen
from config import CODED

class Blk:  # fake tool_use block / message
    def __init__(self, inp): self.type = "tool_use"; self.input = inp
class Msg:
    def __init__(self, inp): self.content = [Blk(inp)]; self.usage = types.SimpleNamespace(input_tokens=1000, output_tokens=500, cache_read_input_tokens=900, cache_creation_input_tokens=0)
STORE = {}
class FakeBatches:
    def create(self, requests):
        bid = f"b{len(STORE)}"; STORE[bid] = requests; return types.SimpleNamespace(id=bid)
    def retrieve(self, bid): return types.SimpleNamespace(processing_status="ended", request_counts={})
    def results(self, bid):
        for i, r in enumerate(STORE[bid]):
            schema = r["params"]["tools"][0]["input_schema"]
            ok = i % 17 != 0   # simulate some failures -> must be retried via sync path
            yield types.SimpleNamespace(custom_id=r["custom_id"], result=types.SimpleNamespace(type="succeeded" if ok else "errored", message=Msg(gen(schema)) if ok else None))
class FakeMessages:
    batches = FakeBatches()
    def create(self, **p):
        assert p["system"][0]["cache_control"] == {"type": "ephemeral"}, "static prompt must be cached"
        assert "{{" not in p["messages"][0]["content"] and "{{" not in p["system"][0]["text"], "unfilled template placeholder"
        return Msg(gen(p["tools"][0]["input_schema"]))
llm._client = types.SimpleNamespace(messages=FakeMessages())

def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "src" / f"{name}.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

for d in ("calls", "reliability", "deals"): shutil.rmtree(CODED / d, ignore_errors=True); (CODED / d).mkdir(parents=True)
for f in glob.glob(str(CODED / "batch_*.json")): Path(f).unlink()
c6 = load("06_code_calls")
sys.argv = ["06", "--calibration", "30", "--yes", "--workers", "2"]; c6.main()
n_cal = len(glob.glob(str(CODED / "calls" / "*.json"))); n_rel = len(glob.glob(str(CODED / "reliability" / "*.json")))
assert n_cal == 30 and n_rel == 30, (n_cal, n_rel)
sys.argv = ["06", "--all", "--batch", "--yes"]; c6.main()
sys.argv = ["06", "--collect"]; c6.main()
n_prep = len(glob.glob(str(ROOT / "data" / "prepared" / "*.meta.json"))); n_all = len(glob.glob(str(CODED / "calls" / "*.json")))
assert n_all == n_prep, (n_all, n_prep)
batched = sum(len(v) for v in STORE.values()); assert batched == n_prep - 30, f"calibration calls must not be re-coded: batched {batched}"
sys.argv = ["06", "--all", "--batch", "--yes"]; c6.main()   # idempotency: nothing should be re-submitted
assert sum(len(v) for v in STORE.values()) == batched
c7 = load("07_synthesize_deals")
sys.argv = ["07", "--batch", "--yes"]; c7.main(); sys.argv = ["07", "--collect"]; c7.main()
print(f"[PASS] calibration 30x2, batch {batched} (+sync retries of simulated failures), idempotent re-run, deals synthesised: {len(glob.glob(str(CODED / 'deals' / '*.json')))}")
