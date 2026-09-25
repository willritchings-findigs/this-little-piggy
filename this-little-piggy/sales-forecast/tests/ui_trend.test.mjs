/** Browser test of Section 3 + Sources & methodology against the real client + server code (preview harness, Chromium). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startPreview } from '../scripts/preview.mjs';
import { ROOT } from './helpers/gas_harness.mjs';

let chromium = null;
try { chromium = createRequire(join(execSync('npm root -g').toString().trim(), 'x'))('playwright').chromium; } catch { /* skip */ }
const SHOTS = join(ROOT, 'verification', 'screens'); mkdirSync(SHOTS, { recursive: true });
const CHART = readFileSync(join(ROOT, 'vendor', 'chart.umd.js'));
const skip = !chromium && 'playwright not installed';
let seeded, single, browser;
before(async () => {
  if (skip) return;
  seeded = await startPreview({ synthetic: true, appOpts: { now: '2026-09-28T10:00:00-04:00' } });
  single = await startPreview({ appOpts: { now: '2026-09-24T10:00:00-04:00' } });
  single.app.session.email = 'ben.dewinter@findigs.com';
  single.app.call('apiSubmitForecast', { commit: 100000, gut: 200000, best_case: 300000 });   // week of Sep 25
  const t0 = Date.parse('2026-09-28T10:00:00-04:00'), s0 = Date.now();
  single.app.ctx.nowMs_ = () => t0 + (Date.now() - s0);                                      // Sep 25 cutoff has passed
  single.app.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 });                  // open week of Oct 2: hidden
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); for (const p of [seeded, single]) if (p) p.server.close(); });

/** cdn: 'ok' serves the pinned build, 'blocked' aborts it, 'tampered' serves bytes that fail SRI. */
async function open(pv, { as = 'will.ritchings@findigs.com', cdn = 'ok' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|integrity/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https:\/\/(media\.findigs\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (r) => r.abort());
  await page.route(/^https:\/\/cdn\.jsdelivr\.net\//, (r) => cdn === 'blocked' ? r.abort()
    : r.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: cdn === 'tampered' ? Buffer.concat([CHART, Buffer.from('\n//x')]) : CHART }));
  await page.goto(`${pv.url}/?as=${encodeURIComponent(as)}`);
  await page.click('#tabbtn-trend');
  await page.waitForSelector('#t-team canvas, #t-single, #t-team .note');
  return { page, errors };
}
const chartData = (page, card, ds) => page.evaluate(([c, d]) => Chart.getChart(document.querySelector(`[data-card="${c}"] canvas`)).data.datasets[d].data, [card, ds]);
const yMax = (page, card) => page.evaluate((c) => Chart.getChart(document.querySelector(`[data-card="${c}"] canvas`)).scales.y.max, card);
async function pointXY(page, card, i) {
  await page.locator(`[data-card="${card}"]`).scrollIntoViewIfNeeded();
  return page.evaluate(([c, n]) => { const cv = document.querySelector(`[data-card="${c}"] canvas`), el = Chart.getChart(cv).getDatasetMeta(1).data[n], r = cv.getBoundingClientRect(); return { x: r.left + el.x, y: r.top + el.y }; }, [card, i]);
}

test('trend: team + per-AE charts, gap (not zero) with marker, implied landing default, shared axis, table view, change table highlights', { skip }, async () => {
  const { page, errors } = await open(seeded);
  assert.equal(await page.evaluate(() => window.__chartSource), 'cdn');
  assert.equal(await page.$$eval('#t-grid canvas', (c) => c.length), 5);
  assert.equal(await page.getAttribute('[data-view="implied_landing"]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('[data-axis="shared"]', 'aria-pressed'), 'true');
  assert.equal(await page.isChecked('#t-overlay'), false);
  assert.match(await page.textContent('#t-notes'), /22 synthetic test submissions/);
  // Spencer's missing week: null in every series (never 0, never the prior value), labeled in the table
  for (const ds of [0, 1, 2, 3]) assert.equal((await chartData(page, 'spencer-wuthrich', ds))[1], null);
  await page.click('[data-card="spencer-wuthrich"] details.as-table summary');
  const gapRow = await page.$$eval('[data-card="spencer-wuthrich"] .trend-table tbody tr', (rs) => rs[1].textContent);
  assert.match(gapRow, /Sep 11, 2026.*Not submitted/);
  assert.equal(await page.$$eval('[data-card="spencer-wuthrich"] .trend-table tbody tr:nth-child(2) td.blank', (t) => t.length), 4);
  assert.match(await page.getAttribute('[data-card="spencer-wuthrich"] [data-copy]', 'data-copy'), /^Week,Commit,Gut,Best Case,Closed Won YTD/);
  // shared axis: every AE chart has the same max; independent: they differ
  const shared = await Promise.all(['phil-aroian', 'ian-mclaughlin', 'matt-lynch'].map((c) => yMax(page, c)));
  assert.equal(new Set(shared).size, 1);
  await page.click('[data-axis="independent"]');
  const indep = await Promise.all(['phil-aroian', 'ian-mclaughlin', 'matt-lynch'].map((c) => yMax(page, c)));
  assert.ok(new Set(indep).size > 1);
  // team coverage: Sep 11 = 4 of 5 AEs
  await page.click('[data-card="team"] details.as-table summary');
  assert.match(await page.$$eval('[data-card="team"] .trend-table tbody tr', (rs) => rs[1].textContent), /4 of 5/);
  // change table: report week = last closed week, highlights present, threshold note
  assert.equal(await page.inputValue('#t-week'), '2026-09-25');
  assert.match(await page.textContent('#t-change-note'), /beyond ±10%/);
  assert.ok(await page.$$eval('#t-change td.hl', (t) => t.length) > 0);
  assert.equal(await page.$$eval('#t-change tbody tr', (r) => r.length), 6);            // 5 AEs + Team
  await page.screenshot({ path: join(SHOTS, 'phase4_trend_all.png'), fullPage: true });
  await page.selectOption('#t-week', '2026-09-11');
  assert.match(await page.textContent('#t-change tr:has(th:text("Spencer Wuthrich"))'), /Not submitted/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('trend: view toggle, single-AE full width, hover tooltip (WoW, submitted_at, resubmissions), resubmission overlay', { skip }, async () => {
  const { page, errors } = await open(seeded);
  const implied = (await chartData(page, 'team', 0))[0];
  await page.click('[data-view="incremental"]');
  const incr = (await chartData(page, 'team', 0))[0], cw = (await chartData(page, 'team', 3))[0];
  assert.ok(Math.abs(implied - (incr + cw)) < 0.02);                                   // implied = CW YTD + value
  await page.click('[data-view="implied_landing"]');
  await page.selectOption('#t-ae', 'ian-mclaughlin');
  assert.equal(await page.$$eval('#t-grid canvas', (c) => c.length), 1);
  assert.equal(await page.isDisabled('[data-axis="shared"]'), true);
  await page.check('#t-overlay');
  const p = await pointXY(page, 'ian-mclaughlin', 2);
  await page.mouse.move(p.x, p.y);
  const tip = await page.evaluate(() => { const t = Chart.getChart(document.querySelector('[data-card="ian-mclaughlin"] canvas')).tooltip; return { title: t.title, body: t.body.map((b) => b.lines.join('')), footer: t.footer }; });
  assert.deepEqual(tip.title, ['Week of Sep 18, 2026']);
  assert.equal(tip.body.length, 4);                                                     // all three values + CW YTD
  const foot = tip.footer.join('\n');
  assert.match(foot, /Week over week/); assert.match(foot, /Submitted Sep 17, 2026 11:05 AM ET/); assert.match(foot, /Resubmissions: 1/);
  assert.match(foot, /Superseded Sep 17, 2026 10:15 AM ET/);
  await page.screenshot({ path: join(SHOTS, 'phase4_trend_single_overlay.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('drill-down: click a point → movement; mismatch flagged not hidden; no-tags week says so; opened from the table too', { skip }, async () => {
  const { page, errors } = await open(seeded);
  const p = await pointXY(page, 'matt-lynch', 3);
  await page.mouse.click(p.x, p.y);
  await page.waitForSelector('#t-drill [data-recon]');
  assert.equal(await page.getAttribute('#t-drill [data-recon]', 'data-recon'), 'mismatch');
  assert.match(await page.textContent('#t-drill'), /Does not reconcile/);
  assert.match(await page.textContent('#t-drill .recon-line'), /unexplained/);
  assert.equal(await page.$$eval('#t-drill .recon tr.flagged', (r) => r.length), 3);
  assert.match(await page.textContent('#t-drill'), /Synthetic test data/);
  await page.locator('#t-drill').screenshot({ path: join(SHOTS, 'phase4_drill_mismatch.png') });
  // Phil reconciles
  await page.click('#t-change [data-move="phil-aroian|2026-09-25"]');
  await page.waitForSelector('#t-drill [data-recon="ok"]');
  assert.match(await page.textContent('#t-drill'), /Added to and removed from each tag/);
  // Ben saved no tags on Sep 18: no inference
  await page.selectOption('#t-week', '2026-09-18');
  await page.click('#t-change [data-move="ben-de-winter|2026-09-18"]');
  await page.waitForSelector('#t-drill [data-status="no_builder_tags"]');
  assert.match(await page.textContent('#t-drill'), /No Forecast Builder tags were saved this week\. Deal movement is not inferred\./);
  assert.equal(await page.$('#t-drill .recon'), null);
  await page.click('#t-drill [data-close-drill]');
  assert.equal(await page.isHidden('#t-drill'), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('single closed week: points render with "Trend requires 2+ submissions"; the open week is hidden until its cutoff', { skip }, async () => {
  const { page, errors } = await open(single, { as: 'ben.dewinter@findigs.com' });
  await page.waitForSelector('#t-single');
  assert.match(await page.textContent('#t-single'), /Trend requires 2\+ submissions/);
  assert.equal(await page.$$eval('#t-grid canvas', (c) => c.length), 5);
  assert.match(await page.textContent('[data-card="ben-de-winter"]'), /Trend requires 2\+ submissions/);
  assert.deepEqual(await chartData(page, 'ben-de-winter', 0), [584825.04]);            // implied: CW YTD 484,825.04 + 100,000
  assert.deepEqual(await page.evaluate(() => Chart.getChart(document.querySelector('[data-card="team"] canvas')).data.labels), ['2026-09-25']);
  assert.match(await page.textContent('#t-open'), /1 submission for the week of Oct 2, 2026 will appear after the cutoff/);
  assert.deepEqual(await page.$$eval('#t-week option', (o) => o.map((x) => x.value)), ['2026-09-25']);
  await page.click('[data-card="phil-aroian"] details.as-table summary');
  assert.match(await page.textContent('[data-card="phil-aroian"] .trend-table'), /Not submitted/);
  await page.screenshot({ path: join(SHOTS, 'phase4_trend_single_week.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('Chart.js: blocked CDN and SRI failure both fall back to the bundled copy', { skip }, async () => {
  for (const cdn of ['blocked', 'tampered']) {
    const { page, errors } = await open(seeded, { cdn });
    await page.waitForSelector('#t-grid canvas');
    assert.equal(await page.evaluate(() => window.__chartSource), 'bundled', cdn);
    assert.equal(await page.$$eval('#t-grid canvas', (c) => c.length), 5);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test('Sources & methodology: collapsed by default; opening lists sources, Renewal exclusion, weighting, cutoff, snapshots, caveats', { skip }, async () => {
  const { page, errors } = await open(seeded);
  assert.equal(await page.getAttribute('#methodology', 'open'), null);
  await page.click('#methodology summary');
  await page.waitForSelector('#meth-body .meth-sec');
  const t = await page.textContent('#meth-body');
  for (const re of [/HubSpot portal 243635806/, /2559714036/, /Excluded/, /amount × pipeline stage probability/, /107 open deals stage-weighted/,
                    /Friday 5:00 PM ET/, /Commit ≤ Gut ≤ Best Case/, /Test mode/, /is_official/, /Known data quality caveats/, /Clay Stapleford/,
                    /never plotted as zero/, /Chart\.js 4\.4\.4/, /Data pulled/]) assert.match(t, re);
  await page.locator('#methodology').screenshot({ path: join(SHOTS, 'phase4_methodology.png') });
  assert.deepEqual(errors, []);
  await page.close();
});

test('year selector: hidden with one configured year; with two, switching loads that year', { skip }, async () => {
  let { page, errors } = await open(seeded);
  assert.equal(await page.isHidden('#t-fy'), true);
  await page.close();
  const folders = seeded.app.ctx.FORECAST_CONFIG.forecast.drive.folders_by_fiscal_year;
  folders['2025'] = 'FY2025-FOLDER';
  try {
    ({ page, errors } = await open(seeded));
    assert.equal(await page.isVisible('#t-fy'), true);
    assert.deepEqual(await page.$$eval('#t-fy option', (o) => o.map((x) => x.value)), ['2026', '2025']);
    await page.selectOption('#t-fy', '2025');
    await page.waitForFunction(() => /No official submissions yet/.test(document.getElementById('t-notes').textContent));
    await page.selectOption('#t-fy', '2026');
    await page.waitForSelector('#t-grid canvas');
    assert.equal(await page.$$eval('#t-grid canvas', (c) => c.length), 5);
    assert.deepEqual(errors, []);
    await page.close();
  } finally { delete folders['2025']; }
});
