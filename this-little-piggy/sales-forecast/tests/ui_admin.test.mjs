/** Browser test of the Admin tab against the real client + server code (preview harness, Chromium). */
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
before(async () => { if (skip) return; preview = await startPreview({ delayMs: 20, appOpts: { now: '2026-09-28T10:00:00-04:00' } }); browser = await chromium.launch(); });
after(async () => { if (browser) await browser.close(); if (preview) preview.server.close(); });

async function open(as, tab = 'admin') {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https:\/\/(media\.findigs\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net)\//, (r) => r.abort());
  await page.goto(`${preview.url}/?as=${encodeURIComponent(as)}`);
  await page.waitForSelector('#s-table tbody tr');
  if (tab === 'admin') { await page.click('#tabbtn-admin'); await page.waitForSelector('#a-users-table'); }
  return { page, errors };
}
const row = (page, email) => page.locator(`#a-users-table tr[data-user="${email}"]`);
async function confirmAndWait(page, key) {
  await page.click(`[data-do="${key}"]`);
  await page.waitForSelector('#admin-result');
  const t = await page.textContent('#admin-result');
  await page.evaluate(() => document.getElementById('admin-result').remove());
  return t;
}

test('Admin tab: visible to admins only', { skip }, async () => {
  for (const who of ['ben.dewinter@findigs.com', 'asaf.raz@findigs.com']) {
    const { page } = await open(who, null);
    assert.equal(await page.isHidden('#tabbtn-admin'), true, who); await page.close();
  }
  for (const who of ['brian.korchin@findigs.com', 'phil.aroian@findigs.com']) {
    const { page } = await open(who, null);
    assert.equal(await page.isVisible('#tabbtn-admin'), true, who); await page.close();
  }
});

test('invite an AE with confirmation: owner picker, email sent, row + audit log, new user signs in', { skip }, async () => {
  const { page, errors } = await open('will.ritchings@findigs.com');
  assert.equal(await page.$$eval('#a-users-table tbody tr[data-user]', (r) => r.length), 9);
  await page.click('[data-invite]');
  await page.fill('#a-user-form [name=email]', 'reese.ryan@findigs.com');
  await page.fill('#a-user-form [name=name]', 'Reese Ryan');
  // AEs already on the roster can't be picked twice
  assert.equal(await page.$eval('#a-user-form [name=ownerId] option[value="2111244871"]', (o) => o.disabled), true);
  await page.selectOption('#a-user-form [name=ownerId]', '663611618');
  await page.click('#a-user-form button[type=submit]');
  assert.match(await page.textContent('.confirm-bar'), /Invite Reese Ryan as AE, and email them the invite\?/);
  await page.screenshot({ path: join(SHOTS, 'admin_invite_confirm.png'), fullPage: false });
  assert.match(await confirmAndWait(page, 'form'), /Invited Reese Ryan as AE; invite emailed/);
  assert.equal(preview.app.store.mail.at(-1).to, 'reese.ryan@findigs.com');
  assert.match(await row(page, 'reese.ryan@findigs.com').textContent(), /Reese Ryan.*AE.*Reese Ryan.*Active/s);
  assert.match(await page.textContent('#a-audit'), /Invited Reese Ryan as AE/);
  assert.doesNotMatch(await page.textContent('#a-nonroster'), /Reese Ryan/);
  const r = await open('reese.ryan@findigs.com', null);
  assert.equal(await r.page.$$eval('#s-table tr[data-ae="reese-ryan"] input', (i) => i.length), 3);
  await r.page.close();
  assert.deepEqual(errors, []);
  await page.close();
});

test('a rejected change shows the reason and changes nothing', { skip }, async () => {
  const { page } = await open('will.ritchings@findigs.com');
  await page.click('[data-invite]');
  await page.fill('#a-user-form [name=email]', 'someone@gmail.com');
  await page.fill('#a-user-form [name=name]', 'Some One');
  await page.selectOption('#a-user-form [name=access]', 'leadership');
  await page.click('#a-user-form button[type=submit]');
  await page.click('[data-do="form"]');
  await page.waitForSelector('#admin-result');
  assert.match(await page.textContent('#admin-result'), /Not saved\..*findigs\.com/);
  assert.equal(await page.$('#a-users-table tr[data-user="someone@gmail.com"]'), null);
  await page.close();
});

test('change access, deactivate (history kept), reactivate; can\'t deactivate yourself', { skip }, async () => {
  const { page, errors } = await open('brian.korchin@findigs.com');
  assert.equal(await row(page, 'brian.korchin@findigs.com').locator('[data-deact]').count(), 0);
  await row(page, 'ian.mclaughlin@findigs.com').locator('[data-edit]').click();
  await page.check('#a-user-form [name=admin]');
  await page.click('#a-user-form button[type=submit]');
  assert.match(await confirmAndWait(page, 'form'), /Changed Ian McLaughlin to AE \+ admin/);
  assert.match(await row(page, 'ian.mclaughlin@findigs.com').textContent(), /Admin/);
  await row(page, 'matt.lynch@findigs.com').locator('[data-deact]').click();
  assert.match(await page.textContent('.confirm-bar'), /history stays in Forecast trend/);
  assert.match(await confirmAndWait(page, 'deact:matt.lynch@findigs.com'), /Deactivated Matt Lynch \(forecast history kept\)/);
  assert.match(await row(page, 'matt.lynch@findigs.com').textContent(), /Inactive/);
  assert.match(await page.textContent('#a-nonroster'), /Also holding deals.*Matt Lynch/s);
  const m = await browser.newPage();
  await m.goto(`${preview.url}/?as=matt.lynch@findigs.com`);
  assert.match(await m.textContent('body'), /Access denied/);
  await m.close();
  await row(page, 'matt.lynch@findigs.com').locator('[data-react]').click();
  assert.match(await confirmAndWait(page, 'react:matt.lynch@findigs.com'), /Reactivated Matt Lynch/);
  await page.screenshot({ path: join(SHOTS, 'admin_panel.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test('this week: submit on behalf jumps to Forecast submission for that AE', { skip }, async () => {
  const { page } = await open('will.ritchings@findigs.com');
  await page.click('#a-week [data-behalf="spencer-wuthrich"]');
  await page.waitForSelector('#s-table tr[data-ae="spencer-wuthrich"] input');
  assert.equal(await page.getAttribute('#tabbtn-submission', 'aria-selected'), 'true');
  assert.equal(await page.inputValue('#s-acting'), 'spencer-wuthrich');
  await page.close();
});

test('health, Other owners reason, and year-rollover folder from the panel', { skip }, async () => {
  const { page, errors } = await open('phil.aroian@findigs.com');
  await page.click('[data-trigger]');
  assert.match(await confirmAndWait(page, 'trigger'), /Refresh trigger installed/);
  assert.match(await page.textContent('#a-health'), /Installed, every 30 min/);
  await page.click('[data-verify]');
  assert.match(await confirmAndWait(page, 'verify'), /snapshots match/);
  await page.click('#a-nonroster [data-nredit="686754956"]');
  await page.fill('#a-nr-form [name=reason]', 'Accounts moving to Charlie and Amos');
  await page.click('#a-nr-form button[type=submit]');
  assert.match(await confirmAndWait(page, 'nrsave'), /Updated other owner Clay Stapleford/);
  assert.match(await page.textContent('#a-nonroster'), /Accounts moving to Charlie and Amos/);
  await page.fill('#a-folder-form [name=folder]', 'https://drive.google.com/drive/folders/1FY2027FolderIdAbcdefghijk');
  await page.click('#a-folder-form button[type=submit]');
  assert.equal(await page.inputValue('#a-folder-form [name=folder]'), 'https://drive.google.com/drive/folders/1FY2027FolderIdAbcdefghijk');
  assert.match(await confirmAndWait(page, 'folder'), /FY2027 folder set/);
  assert.match(await page.textContent('#a-folders'), /FY2027.*1FY2027FolderIdAbcdefghijk.*Admin panel/s);
  assert.equal(await page.$('#a-folder-form'), null);
  assert.match(await page.textContent('#a-audit'), /phil\.aroian@findigs\.com.*Set FY2027 Drive folder/s);
  assert.deepEqual(errors, []);
  await page.close();
});
