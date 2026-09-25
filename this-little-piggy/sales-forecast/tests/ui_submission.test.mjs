/** Browser test of Section 1 against the real client + server code (preview harness, Chromium). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startPreview } from '../scripts/preview.mjs';
import { ROOT } from './helpers/gas_harness.mjs';

let chromium = null;
try { chromium = createRequire(join(execSync('npm root -g').toString().trim(), 'x'))('playwright').chromium; } catch { /* skip */ }
const SHOTS = join(ROOT, 'verification', 'screens'); mkdirSync(SHOTS, { recursive: true });
const skip = !chromium && 'playwright not installed';
let preview, browser;
before(async () => { if (skip) return; preview = await startPreview({ delayMs: 40, appOpts: { now: '2026-09-28T10:00:00-04:00' } }); browser = await chromium.launch(); });
after(async () => { if (browser) await browser.close(); if (preview) preview.server.close(); });

async function open(as) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https:\/\/(media\.findigs\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (r) => r.abort());
  await page.goto(`${preview.url}/?as=${encodeURIComponent(as)}`);
  await page.waitForSelector('#s-table tbody tr');
  return { page, errors };
}
const money = (s) => Number(String(s).replace(/[^0-9.-]/g, ''));
const fill = async (page, f, v) => { await page.fill(`#s-table input[data-field="${f}"]`, v); };

test('AE: nesting rule blocks submit; warning shown but allowed; submit + resubmit update status and last submitted', { skip }, async () => {
  const { page, errors } = await open('ben.dewinter@findigs.com');
  assert.equal(await page.$$eval('#s-table tbody tr[data-ae]', (r) => r.length), 1);        // AE sees own row only
  assert.match(await page.textContent('tr[data-ae="ben-de-winter"]'), /Not submitted/);
  assert.match(await page.textContent('#s-week'), /Oct 2, 2026/);
  assert.equal(await page.isDisabled('#s-submit'), true);                                   // empty

  await fill(page, 'commit', '300000'); await fill(page, 'gut', '200000'); await fill(page, 'best_case', '400000');
  assert.equal(await page.isDisabled('#s-submit'), true);
  assert.match(await page.textContent('tr.own-actions'), /Commit cannot be greater than Gut/);
  assert.equal(await page.getAttribute('input[data-field="commit"]', 'aria-invalid'), 'true');

  await fill(page, 'commit', '-5');
  assert.match(await page.textContent('tr.own-actions'), /cannot be negative/);
  await fill(page, 'commit', 'abc');
  assert.match(await page.textContent('tr.own-actions'), /must be a number/);

  await fill(page, 'commit', '100,000'); await fill(page, 'best_case', '9,000,000');
  assert.equal(await page.isDisabled('#s-submit'), false);
  assert.match(await page.textContent('tr.own-actions'), /Best Case is above your open pipeline/);
  // implied landing (draft) = CW YTD 484,825.04 + Gut 200,000
  assert.equal(money(await page.textContent('tr[data-ae="ben-de-winter"] td:last-child')), 684825);
  await page.click('#s-submit');
  await page.waitForSelector('#submit-result');
  assert.match(await page.textContent('#submit-result'), /Forecast submitted.*forecast_2026-10-02_ben-de-winter_/s);
  assert.match(await page.textContent('tr[data-ae="ben-de-winter"]'), /Submitted this week/);
  assert.match(await page.textContent('tr[data-ae="ben-de-winter"]'), /Sep 28, 2026 10:00 AM ET/);
  assert.equal(await page.inputValue('input[data-field="gut"]'), '200,000');
  await page.screenshot({ path: join(SHOTS, 'phase3_submission_ae.png'), fullPage: true });

  await fill(page, 'best_case', '1,000,000');
  await page.click('#s-submit');
  await page.waitForFunction(() => /Resubmitted/.test(document.querySelector('tr[data-ae="ben-de-winter"]').textContent));
  assert.match(await page.textContent('#s-history'), /Current official/);
  assert.equal(await page.$$eval('#s-history li', (l) => l.length), 2);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Leadership: all rows read-only, Team Total, other owners, company total that ties to HubSpot', { skip }, async () => {
  const { page, errors } = await open('asaf.raz@findigs.com');
  assert.equal(await page.$$eval('#s-table tbody tr[data-ae]', (r) => r.length), 5);
  assert.equal(await page.$$eval('#s-table input', (i) => i.length), 0);
  assert.equal(await page.$('#s-submit'), null);
  const total = await page.textContent('#s-table tr.total');
  assert.match(total, /Team Total/); assert.match(total, /1 of 5 AEs submitted/);             // Ben from the previous test
  assert.match(await page.textContent('#s-table'), /Clay Stapleford/);
  assert.match(await page.textContent('#s-table'), /\$7,571,305/);                           // company CW YTD
  assert.match(await page.textContent('tr[data-ae="phil-aroian"]'), /Not submitted/);
  await page.screenshot({ path: join(SHOTS, 'phase3_submission_leadership.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('Phil (ae_leader): edits only his own row, sees all rows', { skip }, async () => {
  const { page } = await open('phil.aroian@findigs.com');
  assert.equal(await page.$$eval('#s-table tbody tr[data-ae]', (r) => r.length), 5);
  assert.equal(await page.$$eval('#s-table tr[data-ae="phil-aroian"] input', (i) => i.length), 3);
  assert.equal(await page.$$eval('#s-table tr[data-ae="ben-de-winter"] input', (i) => i.length), 0);
  await page.close();
});

test('Server-side rejection is shown and nothing changes', { skip }, async () => {
  const { page } = await open('matt.lynch@findigs.com');
  await fill(page, 'commit', '1'); await fill(page, 'gut', '2'); await fill(page, 'best_case', '3');
  await page.route('**/rpc/apiSubmitForecast*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: 'Another submission is being saved. Nothing was saved; please submit again in a few seconds.' }) }));
  await page.click('#s-submit');
  await page.waitForSelector('#submit-result');
  assert.match(await page.textContent('#submit-result'), /Not submitted.*Another submission/s);
  assert.match(await page.textContent('tr[data-ae="matt-lynch"]'), /Not submitted/);
  assert.equal(await page.isDisabled('#s-submit'), false);
  await page.close();
});
