#!/usr/bin/env python3
"""
QA the built dashboard. Exit 0 = pass, 4 = fail (any failed check, including a browser that won't launch).
Full mode needs Playwright + Chromium (pip install playwright; this environment ships Chromium at /opt/pw-browsers).
Without Playwright it falls back to a JS syntax check only and reports that the render checks were skipped —
unless --require-render is given (unattended runs), in which case a missing Playwright is a failure.

Usage: python qa.py [--require-render] [output/findigs_gtm_executive_dashboard_YYYY-MM-DD.html]
"""
import argparse, glob, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument("path", nargs="?")
ap.add_argument("--require-render", action="store_true", help="fail (exit 4) if the render checks cannot run")
args = ap.parse_args()
path = args.path or sorted(glob.glob(os.path.join(HERE, "output", "findigs_gtm_executive_dashboard_*.html")))[-1]
html = open(path, encoding="utf-8").read()
fails, notes = [], []

def finish():
    print("\n".join(notes))
    for f in fails: print("FAIL:", f)
    print("QA PASS" if not fails else "QA FAIL")
    sys.exit(4 if fails else 0)

# --- 1. JS syntax (node) ---
script = re.search(r"<script>([\s\S]*)</script>", html).group(1)
open("/tmp/_dash_script.js", "w").write(script)
r = subprocess.run(["node", "--check", "/tmp/_dash_script.js"], capture_output=True, text=True)
if r.returncode != 0: fails.append("JS syntax: " + r.stderr.strip()[:300])
else: notes.append("JS syntax OK")

# --- 2. expected values from the embedded payload ---
def embedded(name):
    i = html.index(f"const {name} = ") + len(f"const {name} = ")
    return json.JSONDecoder().raw_decode(html, i)[0]
deals = embedded("DEALS"); pg_rows = embedded("PG"); meta = embedded("META"); history = embedded("HISTORY")
open_ = [d for d in deals if not d["won"]]; won = [d for d in deals if d["won"]]
exp_gross = sum(d["amount"] for d in open_); exp_wtd = sum(d["weighted"] for d in open_); exp_ytd = sum(d["amount"] for d in won)
def compact(v):
    a = abs(v)
    if a >= 1e6: return "$" + f"{v/1e6:.1f}M" if a >= 1e7 else "$" + f"{v/1e6:.2f}M"
    if a >= 1e3: return "$" + f"{v/1e3:.0f}K"
    return "$" + f"{round(v):,}"
def badge(cur, base):
    """Mirror of template.html cmpBadge(): text the badge should show."""
    if cur is None or base is None: return ""
    if base == 0: return "" if cur == 0 else "new"
    pct = (cur - base) / abs(base)
    if pct > 0.0005: return f"▲ +{pct*100:.1f}%"
    if pct < -0.0005: return f"▼ {pct*100:.1f}%"
    return "– 0.0%"

# --- 3. render checks ---
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    msg = "Playwright not installed — render checks SKIPPED (install: pip install playwright)"
    if args.require_render:
        fails.append(msg + " — --require-render was set, so this is a failure")
        finish()
    notes.append(msg)
    print("\n".join(notes)); print("QA PASS (syntax only)" if not fails else "QA FAIL"); sys.exit(4 if fails else 0)

shot = os.path.join(os.path.dirname(os.path.abspath(path)), "qa_screenshot.png")
try:
    with sync_playwright() as p:
        _pinned_chromium = "/opt/pw-browsers/chromium"
        _launch_kwargs = {"executable_path": _pinned_chromium} if os.path.exists(_pinned_chromium) else {}
        b = p.chromium.launch(**_launch_kwargs); pg = b.new_page(viewport={"width": 1440, "height": 1000}); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto("file://" + os.path.abspath(path)); pg.wait_for_timeout(800)
        if errs: fails.append("page errors: " + "; ".join(errs)[:400])
        def tile(k): return pg.inner_text("#k-" + k).strip()
        for k, exp in (("gross", exp_gross), ("wtd", exp_wtd), ("ytd", exp_ytd)):
            if tile(k) != compact(exp): fails.append(f"tile {k}: rendered {tile(k)} vs expected {compact(exp)}")
        if pg.inner_text("#scope-n").strip() != str(len(deals)): fails.append("scope count mismatch")
        if pg.inner_text("#pk-nytd").strip() != f"{len(pg_rows):,}": fails.append("pipeline-generation YTD count mismatch")

        # SDR section: the four headline tiles match the build's own counts
        sc = meta["sdr"]["counts"]
        if not pg.is_visible("#sdr"): fails.append("SDR section #sdr not visible")
        for k, exp in (("booked30", sc["booked"]), ("held30", sc["held"]), ("opp30", sc["opp30"])):
            got = pg.inner_text(f"#sk-{k}").strip()
            if got != f"{exp:,}": fails.append(f"SDR tile {k}: rendered {got} vs expected {exp:,}")
        if sc["held"] == 0 and pg.inner_text("#sk-heldopp30").strip() != "—": fails.append("SDR held→opp tile should read — when no meetings were held")

        # Compare vs: hidden with no prior snapshot; otherwise defaults to the most recent prior and badges match
        cmp_visible = pg.is_visible("#cmp-wrap")
        if len(history) <= 1:
            if cmp_visible: fails.append("Compare vs is visible but HISTORY has no prior snapshot")
        else:
            if not cmp_visible: fails.append(f"Compare vs hidden but HISTORY has {len(history) - 1} prior snapshot(s)")
            n_opts = pg.locator("#cmp-select option").count()
            if n_opts != len(history) - 1: fails.append(f"Compare vs dropdown has {n_opts} options, expected {len(history) - 1}")
            now, prior = history[-1], history[-2]
            for tid, grp, key in (("k-gross", "tier1", "gross"), ("k-ytd", "tier1", "ytd"), ("pk-cytd", "pg", "cytd"), ("sk-opp30", "sdr", "opp30")):
                exp = badge((now.get(grp) or {}).get(key), (prior.get(grp) or {}).get(key))
                got = pg.inner_text(f"#{tid}-cmp").strip()
                if got != exp: fails.append(f"Compare vs badge {tid}: rendered '{got}' vs expected '{exp}' (vs {prior['asOf']})")

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
        # every KPI tile in every section is clickable without a page error (a Tier 1 handler bound to all
        # .kpi buttons once threw on Pipeline Generation / SDR tiles while their own handler still ran)
        n_err = len(errs)
        for i in range(pg.locator("button.kpi").count()):
            pg.locator("button.kpi").nth(i).click(); pg.wait_for_timeout(50)
            if pg.locator("#dd.on").count(): pg.click("#dd-x")
        if len(errs) > n_err: fails.append("KPI tile clicks raised page errors: " + "; ".join(errs[n_err:])[:400])
        if errs[:n_err]: fails.append("late page errors: " + "; ".join(errs[:n_err])[:400])
        pg.screenshot(path=shot, full_page=False)
        b.close()
except Exception as e:  # browser launch failure, missing element, timeout: all count as a failed QA, never a crash
    fails.append(f"render checks could not complete: {type(e).__name__}: {str(e).splitlines()[0][:300]}")
    finish()
notes.append(f"render checks run on {os.path.basename(path)}; screenshot at {os.path.relpath(shot, HERE)}")
finish()
