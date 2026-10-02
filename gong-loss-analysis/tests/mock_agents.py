"""OFFLINE TEST ONLY: simulates Claude Code subagents through the REAL packet -> staging -> validate_coding -> ingest path.
Writes random schema-valid objects (plus some deliberately broken ones that must be rejected, then fixed)."""
import json, sys, random, subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(ROOT / "src")); sys.path.insert(0, str(ROOT / "tests"))
from make_mock_data import gen
random.seed(5)
def run(*a): return subprocess.run([sys.executable, *a], cwd=ROOT, capture_output=True, text=True)
def agent(kind):
    r = run("src/10_agent_packets.py", "--build", kind); print(r.stdout.strip())
    while True:
        nxt = run("src/10_agent_packets.py", "--next", kind, "4").stdout.split()
        if not nxt or nxt[0] == "[done]": break
        for p in nxt:
            pk = json.loads((ROOT / p).read_text()); schema = json.loads((ROOT / pk["schema_file"]).read_text()); stage = ROOT / pk["staging_dir"]
            for it in pk["items"]:
                o = gen(schema)
                if random.random() < 0.05: o.pop(next(iter(o)))                       # broken: missing required key
                (stage / f"{it['id']}.json").write_text(json.dumps(o))
            v = run("src/validate_coding.py", "--packet", p)
            if v.returncode:   # "fix" like a subagent would
                for line in v.stdout.splitlines()[1:]:
                    iid = line.strip("- ").split(":")[0]; (stage / f"{iid}.json").write_text(json.dumps(gen(schema)))
                v = run("src/validate_coding.py", "--packet", p); assert v.returncode == 0, v.stdout
    print(run("src/10_agent_packets.py", "--status").stdout)
for k in ["calibration", "reliability", "briefs", "calls", "deals"]: agent(k)
