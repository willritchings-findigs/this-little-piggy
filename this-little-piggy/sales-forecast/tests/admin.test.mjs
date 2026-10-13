/** Admin panel: roster rules (core), and the admin API end to end on the real .gs code. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadApp, fakeHubSpot, FIXTURE } from './helpers/gas_harness.mjs';

const C = createRequire(import.meta.url)('../core/forecast_core.js');
const CFG = createRequire(import.meta.url)('../config/roster.json');
const J = (x) => JSON.parse(JSON.stringify(x));
const OWNERS = C.normalizeOwners(FIXTURE.owners);
const REESE = '663611618', CLAY = '686754956', HAYDEN = '1542312872', BEN_OID = '2111244871';
const ctx = (actor = 'will.ritchings@findigs.com') => ({ owners: OWNERS, now: '2026-09-28T10:00:00.000-04:00', actor });
const apply = (r, c, actor) => C.applyRosterChange(r, c, ctx(actor)).roster;

// ------------------------------------------------------------------ core rules
test('invite: AE needs a real, unassigned HubSpot owner; findigs.com only; no duplicates; slug from name', () => {
  const r = apply(CFG, { action: 'invite', email: 'Reese.Ryan@findigs.com', name: 'Reese Ryan', access: 'ae', ownerId: REESE });
  const reese = r.aes.find((a) => a.email === 'reese.ryan@findigs.com');
  assert.deepEqual([reese.slug, reese.role, reese.hubspot_owner_id, reese.invited_by], ['reese-ryan', 'ae', REESE, 'will.ritchings@findigs.com']);
  assert.ok(!r.non_roster_owners.owners.some((o) => o.hubspot_owner_id === REESE));        // moved off Other owners
  assert.throws(() => apply(CFG, { action: 'invite', email: 'x@gmail.com', name: 'X', access: 'leadership' }), /findigs\.com/);
  assert.throws(() => apply(CFG, { action: 'invite', email: 'new@findigs.com', name: 'New', access: 'ae' }), /Choose the HubSpot owner/);
  assert.throws(() => apply(CFG, { action: 'invite', email: 'new@findigs.com', name: 'New', access: 'ae', ownerId: '999' }), /not found/);
  assert.throws(() => apply(CFG, { action: 'invite', email: 'new@findigs.com', name: 'New', access: 'ae', ownerId: BEN_OID }), /already assigned to Ben de Winter/);
  assert.throws(() => apply(CFG, { action: 'invite', email: 'ben.dewinter@findigs.com', name: 'Ben', access: 'leadership' }), /already has access/);
  assert.throws(() => apply(CFG, { action: 'invite', email: 'new@findigs.com', name: 'New', access: 'owner' }), /access level/);
  const two = apply(apply(CFG, { action: 'invite', email: 'a.b@findigs.com', name: 'Matt Lynch', access: 'leadership' }), { action: 'update', email: 'a.b@findigs.com', access: 'ae', ownerId: REESE });
  assert.equal(two.aes.find((a) => a.email === 'a.b@findigs.com').slug, 'matt-lynch-2');   // slugs stay unique
});

test('deactivate keeps an AE record (history); leadership/admin entries are removed; nobody can deactivate themselves', () => {
  const r = apply(CFG, { action: 'deactivate', email: 'ben.dewinter@findigs.com' });
  const ben = r.aes.find((a) => a.slug === 'ben-de-winter');
  assert.equal(ben.active, false); assert.equal(ben.deactivated_at, '2026-09-28T10:00:00.000-04:00');
  const run = C.activeRoster(r);
  assert.ok(!run.aes.some((a) => a.slug === 'ben-de-winter'));
  assert.match(run.non_roster_owners.owners.find((o) => o.hubspot_owner_id === BEN_OID).reason, /Deactivated in the forecast tool on 2026-09-28/);
  assert.equal(C.resolveViewer('ben.dewinter@findigs.com', run), null);                    // access removed
  assert.equal(apply(CFG, { action: 'deactivate', email: 'asaf.raz@findigs.com' }).leadership.some((l) => l.email === 'asaf.raz@findigs.com'), false);
  assert.throws(() => apply(CFG, { action: 'deactivate', email: 'will.ritchings@findigs.com' }), /deactivate yourself/);
  const back = apply(r, { action: 'reactivate', email: 'ben.dewinter@findigs.com' });
  assert.equal(back.aes.find((a) => a.slug === 'ben-de-winter').active, true);
  assert.equal(C.resolveViewer('ben.dewinter@findigs.com', C.activeRoster(back)).ae.slug, 'ben-de-winter');
});

test('change access: AE ↔ leadership keeps the AE slug for history; admin flag on AEs; last-admin and self-demotion guards', () => {
  let r = apply(CFG, { action: 'update', email: 'matt.lynch@findigs.com', access: 'leadership' });
  assert.equal(C.resolveViewer('matt.lynch@findigs.com', C.activeRoster(r)).role, 'leadership');
  assert.equal(r.aes.find((a) => a.slug === 'matt-lynch').active, false);                  // history kept
  r = apply(r, { action: 'update', email: 'matt.lynch@findigs.com', access: 'ae' });
  const matt = r.aes.filter((a) => a.email === 'matt.lynch@findigs.com');
  assert.equal(matt.length, 1); assert.equal(matt[0].slug, 'matt-lynch'); assert.equal(matt[0].active, true);
  assert.ok(!r.leadership.some((l) => l.email === 'matt.lynch@findigs.com'));
  r = apply(CFG, { action: 'update', email: 'ian.mclaughlin@findigs.com', admin: true });
  assert.equal(C.resolveViewer('ian.mclaughlin@findigs.com', C.activeRoster(r)).isAdmin, true);
  assert.throws(() => apply(CFG, { action: 'update', email: 'will.ritchings@findigs.com', access: 'leadership' }), /own admin access/);
  // Brian demotes Will, Will demotes Phil's admin flag... the last admin can't go
  let solo = apply(CFG, { action: 'update', email: 'phil.aroian@findigs.com', admin: false });
  solo = apply(solo, { action: 'deactivate', email: 'brian.korchin@findigs.com' });
  assert.throws(() => apply(solo, { action: 'deactivate', email: 'will.ritchings@findigs.com' }, 'someone.else@findigs.com'), /last active admin/);
  const users = C.rosterUsers(r, OWNERS);
  assert.equal(users.filter((u) => u.email === 'matt.lynch@findigs.com').length, 1);
  assert.equal(users.find((u) => u.email === 'ben.dewinter@findigs.com').hubspotOwner.name, 'Ben de Winter');
});

test('Other owners: set reason, update, remove; an active AE owner is refused', () => {
  let r = apply(CFG, { action: 'nonroster_set', ownerId: CLAY, reason: 'Accounts moving to Charlie and Amos' });
  assert.equal(r.non_roster_owners.owners.find((o) => o.hubspot_owner_id === CLAY).reason, 'Accounts moving to Charlie and Amos');
  r = apply(r, { action: 'nonroster_remove', ownerId: HAYDEN });
  assert.ok(!r.non_roster_owners.owners.some((o) => o.hubspot_owner_id === HAYDEN));
  assert.throws(() => apply(CFG, { action: 'nonroster_set', ownerId: BEN_OID, reason: 'x' }), /active AE/);
  assert.throws(() => apply(CFG, { action: 'nonroster_set', ownerId: CLAY, reason: ' ' }), /reason/);
});

test('invite message: role-specific, links the app and docs, states the cutoff in 12-hour ET', () => {
  const m = C.inviteMessage({ name: 'Reese Ryan', access: 'ae', admin: false, appUrl: 'https://x/exec', docsUrl: 'https://notion/x', invitedBy: 'Brian Korchin', cutoff: { weekday: 'Friday', time_et: '17:00' } });
  assert.match(m.text, /Hi Reese,/); assert.match(m.text, /Brian Korchin added you .* as AE\./); assert.match(m.text, /Friday 5:00 PM ET/);
  assert.match(m.html, /href="https:\/\/x\/exec"/); assert.match(m.text, /https:\/\/notion\/x/);
  const l = C.inviteMessage({ name: 'Dan', access: 'leadership', appUrl: null, cutoff: { weekday: 'Friday', time_et: '17:00' } });
  assert.doesNotMatch(l.text, /Weekly deadline/); assert.match(l.text, /shared separately/);
});

// ------------------------------------------------------------------ API end to end
function app(email = 'will.ritchings@findigs.com', opts = {}) { const a = loadApp({ email, now: '2026-09-28T10:00:00-04:00', ...opts }); a.ctx.pullData_(); return a; }
const adminLog = (a) => a.store.rollups.P2026.admin_log.rows.slice(1);

test('only admins can open or use the panel', () => {
  for (const who of ['ben.dewinter@findigs.com', 'asaf.raz@findigs.com']) {
    const a = app(who);
    assert.throws(() => a.call('apiAdminGet'), /Admins only/);
    assert.throws(() => a.call('apiAdminChange', { action: 'invite', email: 'x@findigs.com', name: 'X', access: 'leadership' }), /Admins only/);
  }
  for (const who of ['will.ritchings@findigs.com', 'brian.korchin@findigs.com', 'phil.aroian@findigs.com']) assert.equal(app(who).call('apiAdminGet').users.length, 9);   // 5 AEs, 2 leadership, 2 admins
});

test('invite an AE end to end: saved to the runtime roster, emailed, logged, Section 1 row appears, new user can sign in', () => {
  const a = app('brian.korchin@findigs.com');
  const p0 = a.call('apiAdminGet');
  assert.equal(p0.rosterSource, 'config');
  assert.ok(p0.owners.find((o) => o.id === REESE && o.assignedTo === null));
  const r = a.call('apiAdminChange', { action: 'invite', email: 'reese.ryan@findigs.com', name: 'Reese Ryan', access: 'ae', ownerId: REESE }, { sendInvite: true });
  assert.match(r.result.summary, /Invited Reese Ryan as AE; invite emailed to reese.ryan@findigs.com/);
  assert.equal(r.panel.rosterSource, 'admin_panel');
  const mail = a.store.mail[0];
  assert.equal(mail.to, 'reese.ryan@findigs.com'); assert.equal(mail.replyTo, 'brian.korchin@findigs.com');
  assert.match(mail.body, /Brian Korchin added you/); assert.match(mail.body, /TESTDEPLOY\/exec/); assert.match(mail.body, /notion\.com/);
  const log = adminLog(a);
  assert.deepEqual([log[0][1], log[0][2], log[0][3]], ['brian.korchin@findigs.com', 'invite', 'reese.ryan@findigs.com']);
  assert.equal(JSON.parse(log[0][6]).slug, 'reese-ryan');
  a.session.email = 'reese.ryan@findigs.com';
  const s = a.call('apiGetSubmission');
  assert.equal(s.editableSlug, 'reese-ryan');
  assert.equal(s.rows.length, 6);
  assert.ok(!s.nonRoster.owners.some((o) => o.ownerId === REESE));
  assert.equal(C.round2(s.rows.reduce((x, row) => x + row.metrics.grossOpen.amount, 0) + s.nonRoster.total.grossOpen.amount), s.company.grossOpen.amount);
  a.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 });
});

test('invite without email, and no email is ever sent in test mode', () => {
  const a = app();
  a.call('apiAdminChange', { action: 'invite', email: 'dan.soltis@findigs.com', name: 'Dan Soltis', access: 'leadership' }, { sendInvite: false });
  assert.equal(a.store.mail.length, 0);
  const t = app('will.ritchings@findigs.com', { testFolderId: 'TEST' });
  const r = t.call('apiAdminChange', { action: 'invite', email: 'emma.kyber@findigs.com', name: 'Emma Kyber', access: 'leadership' }, { sendInvite: true });
  assert.match(r.result.summary, /not sent \(test mode\)/); assert.equal(t.store.mail.length, 0);
});

test('deactivate an AE: access removed, row gone from Section 1, deals move to Other owners, trend history kept', () => {
  const a = app('will.ritchings@findigs.com', { now: '2026-09-24T10:00:00-04:00' });
  a.session.email = 'ben.dewinter@findigs.com';
  a.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 });                         // week of Sep 25
  a.setNow('2026-09-28T10:00:00-04:00');
  a.session.email = 'will.ritchings@findigs.com';
  a.call('apiAdminChange', { action: 'deactivate', email: 'ben.dewinter@findigs.com' });
  a.session.email = 'ben.dewinter@findigs.com';
  assert.throws(() => a.call('apiGetSubmission'), /Access denied/);
  a.session.email = 'asaf.raz@findigs.com';
  const s = a.call('apiGetSubmission');
  assert.equal(s.rows.length, 4); assert.ok(!s.aes.some((x) => x.slug === 'ben-de-winter'));
  const other = s.nonRoster.owners.find((o) => o.ownerId === BEN_OID);
  assert.match(other.reason, /Deactivated/); assert.equal(other.metrics.grossOpen.count, 12);
  assert.equal(C.round2(s.rows.reduce((x, row) => x + row.metrics.grossOpen.amount, 0) + s.nonRoster.total.grossOpen.amount), s.company.grossOpen.amount);
  const t = a.call('apiGetTrend');
  assert.deepEqual(J(t.aes.find((x) => x.slug === 'ben-de-winter')), { slug: 'ben-de-winter', name: 'Ben de Winter', inactive: true });
  assert.equal(a.call('apiGetMovement', 'ben-de-winter', '2026-09-25').status, 'missing_snapshot');   // history still readable
  assert.throws(() => a.call('apiGetBuilder', 'ben-de-winter'), /Unknown AE/);
  a.session.email = 'will.ritchings@findigs.com';
  assert.throws(() => a.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 }, 'ben-de-winter'), /Choose the AE/);
});

test('year rollover folder from the panel: validated, stored, used for FY2027 submissions, banner clears', () => {
  const a = app('will.ritchings@findigs.com', { asOf: '2026-12-02', now: '2026-12-02T10:00:00-05:00' });
  assert.equal(a.call('apiAdminGet').folders.rollover.nextFiscalYear, 2027);
  assert.throws(() => a.call('apiAdminSetFolder', 2026, '1ABCDEFGHIJKLMNOPQRSTUVWXYZ'), /already has a folder/);
  assert.throws(() => a.call('apiAdminSetFolder', 2029, '1ABCDEFGHIJKLMNOPQRSTUVWXYZ'), /FY2026 or FY2027 only/);
  assert.throws(() => a.call('apiAdminSetFolder', 2027, 'short'), /folder link or ID/);
  assert.throws(() => a.call('apiAdminSetFolder', 2027, '17CBtW0XTcMq-GO3OsXlbRArf9olSHnIg'), /test mode/);
  const r = a.call('apiAdminSetFolder', 2027, 'https://drive.google.com/drive/folders/1FY2027FolderIdAbcdefghijk?usp=sharing');
  assert.match(r.result.summary, /FY2027 folder set/);
  assert.equal(r.panel.folders.rollover, null);
  assert.deepEqual(J(r.panel.folders.years.map((y) => [y.year, y.source])), [[2026, 'config'], [2027, 'admin_panel']]);
  a.setNow('2026-12-28T10:00:00-05:00');                                                    // week of Jan 1, 2027
  a.session.email = 'ben.dewinter@findigs.com';
  assert.equal(a.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 }).result.forecastWeek, '2027-01-01');
  assert.equal(a.store.drive.filesIn(a.store.drive.folder('1FY2027FolderIdAbcdefghijk')).filter((f) => f.name.startsWith('forecast_')).length, 1);
});

test('health actions: refresh, install trigger, integrity check; all logged', () => {
  const a = app();
  assert.equal(a.call('apiAdminGet').health.triggerInstalled, false);
  assert.equal(a.call('apiAdminInstallTrigger').panel.health.triggerInstalled, true);
  assert.deepEqual(J(a.store.triggers), [{ fn: 'refreshDataTrigger', every: 30 }]);
  assert.match(a.call('apiAdminRefresh').result.summary, /Data refreshed/);
  assert.match(a.call('apiAdminVerifySnapshots').result.summary, /All 0 snapshots match/);
  assert.deepEqual(adminLog(a).map((r) => r[2]), ['install_trigger', 'refresh', 'verify_snapshots']);
  const p = a.call('apiAdminGet');
  assert.equal(p.thisWeek.rows.length, 5); assert.ok(p.thisWeek.rows.every((r) => r.status === 'not_submitted'));
  assert.equal(p.audit[0].action, 'verify_snapshots');
  assert.ok(Array.isArray(p.health.buildLog)); assert.equal(p.settings.cutoff.time_et, '17:00');   // harness routes build_log to memory
});

test('a saved change is never reported as "Not saved": email or refresh failures are noted instead', () => {
  const a = app();
  a.ctx.MailApp.sendEmail = () => { throw new Error('Service invoked too many times'); };
  const hub = a.hub, orig = hub.fetch;
  let fail = false; hub.fetch = (u, o) => (fail ? { getResponseCode: () => 500, getContentText: () => '{}' } : orig(u, o));
  const origPull = a.ctx.pullData_;
  a.ctx.pullData_ = (x) => { if (fail) throw new Error('HubSpot 500'); return origPull(x); };
  fail = true;
  const r = a.call('apiAdminChange', { action: 'invite', email: 'dan.soltis@findigs.com', name: 'Dan Soltis', access: 'leadership' }, { sendInvite: true });
  assert.match(r.result.summary, /Invited Dan Soltis.*invite email FAILED.*Resend invite.*HubSpot refresh failed/);
  assert.ok(C.rosterUsers(JSON.parse(a.store.props.ROSTER_JSON)).some((u) => u.email === 'dan.soltis@findigs.com'));
});

