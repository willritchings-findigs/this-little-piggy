#!/usr/bin/env python3
"""
QA the built dashboard. Exit 0 = pass, 4 = fail.
Full mode needs Playwright + Chromium (pip install playwright && playwright install chromium).
Without Playwright it falls back to a JS syntax check only and reports that the render checks were skipped.

Usage: python qa.py [output/findigs_gtm_executive_dashboard_YYYY-MM-DD.html]
"""
import glob, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
path = sys.argv[1] if len(sys.argv) > 1 else sorted(glob.glob(os.path.join(HERE, "output", "findigs_gtm_executive_dashboard_*.html")))[-1]
html = open(path, encoding="utf-8").read()
fails, notes = [], []

# --- 1. JS syntax (node) ---
script = re.search(r"<script>([\s\S]*)</script>", html).group(1)
open("/tmp/_dash_script.js", "w").write(script)
r = subprocess.run(["node", "--check", "/tmp/_dash_script.js"], capture_output=True, text=True)
if r.returncode != 0: fails.append("JS syntax: " + r.stderr.strip()[:300])
else: notes.append("JS syntax OK")

# --- 2. expected totals from embedded META/DEALS ---
deals = json.loads(re.search(r"const DEALS = (\[.*?\]);\nconst PG", html, re.S).group(1))
open_ = [d for d in deals if not d["won"]]; won = [d for d in deals if d["won"]]
exp_gross = sum(d["amount"] for d in open_); exp_wtd = sum(d["weighted"] for d in open_); exp_ytd = sum(d["amount"] for d in won)
def compact(v):
    a = abs(v)
    if a >= 1e6: return "$" + f"{v/1e6:.1f}M" if a >= 1e7 else "$" + f"{v/1e6:.2f}M"
    if a >= 1e3: return "$" + f"{v/1e3:.0f}K"
    return "$" + f"{round(v):,}"

# --- 3. render checks ---
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    notes.append("Playwright not installed — render checks SKIPPED (install: pip install playwright && playwright install chromium)")
    print("\n".join(notes)); print("QA PASS (syntax only)" if not fails else "QA FAIL"); sys.exit(4 if fails else 0)

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1440, "height": 1000}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("file://" + os.path.abspath(path)); pg.wait_for_timeout(800)
    if errs: fails.append("page errors: " + "; ".join(errs)[:400])
    def tile(k): return pg.inner_text("#k-" + k).strip()
    for k, exp in (("gross", exp_gross), ("wtd", exp_wtd), ("ytd", exp_ytd)):
        if tile(k) != compact(exp): fails.append(f"tile {k}: rendered {tile(k)} vs expected {compact(exp)}")
    if pg.inner_text("#scope-n").strip() != str(len(deals)): fails.append("scope count mismatch")
    pg_count = len(json.loads(re.search(r"const PG = (\[.*?\]);\nconst META", html, re.S).group(1)))
    if pg.inner_text("#pk-nytd").strip() != f"{pg_count:,}": fails.append("pipeline-generation YTD count mismatch")
    # filter smoke: uncheck every owner but the first, expect scope to drop, then reset restores
    pg.click("#f-owner summary")
    n_before = int(pg.inner_text("#scope-n"))
    pg.evaluate("""() => { const cbs=[...document.querySelectorAll('#f-owner-pop input')]; cbs.slice(1).forEach(cb => { cb.checked=false; cb.dispatchEvent(new Event('change',{bubbles:true})); }); }""")
    pg.wait_for_timeout(200); n_after = int(pg.inner_text("#scope-n"))
    if not n_after < n_before: fails.append("owner filter did not reduce scope")
    pg.click("#reset"); pg.wait_for_timeout(200)
    if int(pg.inner_text("#scope-n")) != n_before: fails.append("reset did not restore scope")
    # native-only toggle
    before = pg.inner_text("#pk-cytd"); pg.click("#pg-native"); pg.wait_for_timeout(200); after = pg.inner_text("#pk-cytd"); pg.click("#pg-native")
    if before == after: fails.append("native-only toggle had no effect")
    # drilldown opens with rows
    pg.click("button.kpi[data-k=gross]"); pg.wait_for_timeout(300)
    if pg.locator("#dd-b tbody tr").count() != len(open_): fails.append("gross drilldown row count mismatch")
    pg.click("#dd-x")
    if errs: fails.append("late page errors: " + "; ".join(errs)[:400])
    pg.screenshot(path=os.path.join(HERE, "output", "qa_screenshot.png"), full_page=False)
    b.close()
notes.append(f"render checks run on {os.path.basename(path)}; screenshot at output/qa_screenshot.png")

print("\n".join(notes))
for f in fails: print("FAIL:", f)
print("QA PASS" if not fails else "QA FAIL")
sys.exit(4 if fails else 0)
