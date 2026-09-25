/**
 * Browser test of Section 2 against the real client + server code (preview harness, Chromium).
 * Skips cleanly if Playwright is not installed. Writes screenshots to verification/screens/.
 */
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
before(async () => {
  if (skip) return;
  preview = await startPreview({ delayMs: 40 });
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (preview) preview.server.close(); });

async function open(as) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  // External CDNs (fonts, logo, icons) are not reachable in CI; block them so tests are deterministic.
  await page.route(/^https:\/\/(media\.findigs\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (r) => r.abort());
  await page.goto(`${preview.url}/?as=${encodeURIComponent(as)}`);
  await page.waitForSelector('#b-table tbody tr');
  return { page, errors };
}
const money = (s) => Number(String(s).replace(/[^0-9.-]/g, ''));
const tileVal = (page, t) => page.$eval(`[data-tile="${t}"] .t-value`, (e) => e.textContent);

test('AE: default view, tagging updates nested totals, autosave, persists on reload', { skip }, async () => {
  const { page, errors } = await open('ben.dewinter@findigs.com');
  assert.match(await page.textContent('#b-count'), /Showing 11 of 12 open deals/);
  assert.equal(await tileVal(page, 'commit'), '$0');
  assert.equal(await page.isDisabled('#b-table tbody select'), false);

  // sort by amount ascending so row order is deterministic
  await page.click('th[data-sort="amount"]');
  const rows = await page.$$eval('#b-table tbody tr', (trs) => trs.map((tr) => ({ id: tr.dataset.deal, amt: tr.children[3].textContent })));
  const amts = rows.map((r) => money(r.amt));
  assert.deepEqual(amts, amts.slice().sort((a, b) => a - b));
  await page.selectOption(`select[data-deal="${rows[0].id}"]`, 'commit');
  await page.selectOption(`select[data-deal="${rows[1].id}"]`, 'gut');
  await page.selectOption(`select[data-deal="${rows[2].id}"]`, 'best_case');
  await page.selectOption(`select[data-deal="${rows[3].id}"]`, 'lost');
  assert.equal(money(await tileVal(page, 'commit')), amts[0]);
  assert.equal(money(await tileVal(page, 'gut')), amts[0] + amts[1]);
  assert.equal(money(await tileVal(page, 'best_case')), amts[0] + amts[1] + amts[2]);
  assert.equal(money(await page.textContent('[data-subtotal="lost"] .s-amt')), amts[3]);
  await page.waitForFunction(() => /Saved/.test(document.getElementById('b-save').textContent), null, { timeout: 5000 });
  await page.screenshot({ path: join(SHOTS, 'phase2_builder_ae.png'), fullPage: true });

  await page.reload(); await page.waitForSelector('#b-table tbody tr');
  assert.equal(await page.inputValue(`select[data-deal="${rows[0].id}"]`), 'commit');
  assert.equal(await page.inputValue(`select[data-deal="${rows[3].id}"]`), 'lost');
  assert.equal(money(await tileVal(page, 'best_case')), amts[0] + amts[1] + amts[2]);
  assert.match(await page.textContent('#b-save'), /Saved .* ET/);

  // toggle all open deals; totals must not change
  const before = await tileVal(page, 'best_case');
  await page.check('#b-showall');
  assert.match(await page.textContent('#b-count'), /Showing 12 of 12/);
  assert.equal(await tileVal(page, 'best_case'), before);

  // default sort is close date ascending; one click reverses it (blanks still last)
  assert.equal(await page.getAttribute('th[data-sort="closeDate"]', 'aria-sort'), 'ascending');
  await page.click('th[data-sort="closeDate"]');
  assert.equal(await page.getAttribute('th[data-sort="closeDate"]', 'aria-sort'), 'descending');
  assert.match(await page.textContent('#b-table tbody tr:first-child td:nth-child(6)'), /2027/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('AE: flagged deals are shown and badged (past due)', { skip }, async () => {
  const { page, errors } = await open('matt.lynch@findigs.com');
  assert.match(await page.textContent('#b-count'), /Showing 17 of 21/);
  const pastDue = await page.$$eval('#b-table tbody tr.flagged', (trs) => trs.map((t) => t.textContent));
  assert.equal(pastDue.length, 1); assert.match(pastDue[0], /Past due/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Leadership: read-only, can switch AE, sees the AE\'s saved tags', { skip }, async () => {
  const { page, errors } = await open('brian.korchin@findigs.com');
  assert.equal(await page.$$eval('#b-ae option', (o) => o.length), 5);
  assert.equal(await page.inputValue('#b-ae'), 'ben-de-winter');   // non-AE leadership defaults to the first AE alphabetically
  await page.waitForFunction(() => /Read-only/.test(document.getElementById('b-save').textContent));
  assert.match(await page.textContent('#b-notes'), /Ben de Winter/);
  assert.equal(await page.isDisabled('#b-table tbody select'), true);
  assert.match(await page.textContent('#b-save'), /Read-only/);
  assert.notEqual(await tileVal(page, 'commit'), '$0');            // Ben's saved tags from the previous test
  await page.selectOption('#b-ae', 'matt-lynch');
  await page.waitForFunction(() => /Showing 17 of 21/.test(document.getElementById('b-count').textContent));
  await page.screenshot({ path: join(SHOTS, 'phase2_builder_leadership.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('Save failure is shown with retry and the tag is kept on screen', { skip }, async () => {
  const { page } = await open('ian.mclaughlin@findigs.com');
  const id = await page.$eval('#b-table tbody tr', (tr) => tr.dataset.deal);
  await page.route('**/rpc/apiSaveTags*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: 'Another save is in progress.' }) }));
  await page.selectOption(`select[data-deal="${id}"]`, 'commit');
  await page.waitForSelector('#b-retry', { timeout: 5000 });
  assert.match(await page.textContent('#b-save'), /Not saved/);
  assert.equal(await page.inputValue(`select[data-deal="${id}"]`), 'commit');
  await page.unroute('**/rpc/apiSaveTags*');
  await page.click('#b-retry');
  await page.waitForFunction(() => /Saved/.test(document.getElementById('b-save').textContent), null, { timeout: 5000 });
  await page.close();
});

test('Stranger is denied', { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(`${preview.url}/?as=someone@findigs.com`);
  assert.match(await page.textContent('body'), /Access denied/);
  await page.close();
});
