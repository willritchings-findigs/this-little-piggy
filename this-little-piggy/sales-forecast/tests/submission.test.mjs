import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { loadApp, fakeHubSpot, ROOT } from './helpers/gas_harness.mjs';

const C = createRequire(import.meta.url)('../core/forecast_core.js');
const CUT = { weekday: 'Friday', time_et: '12:00' };
const wk = (iso) => C.forecastWeekFor(Date.parse(iso), CUT);

// ------------------------------------------------------------------ week / cutoff
test('forecast week: Mon–Fri 11:59:59.999 ET → that Friday; Fri 12:00:00 ET and later → next Friday', () => {
  assert.equal(wk('2026-09-28T09:00:00-04:00').forecastWeek, '2026-10-02');   // Monday
  assert.equal(wk('2026-10-02T11:59:59.999-04:00').forecastWeek, '2026-10-02');
  assert.equal(wk('2026-10-02T12:00:00.000-04:00').forecastWeek, '2026-10-09');   // at cutoff → late → next week
  assert.equal(wk('2026-10-02T12:00:01-04:00').forecastWeek, '2026-10-09');
  assert.equal(wk('2026-10-03T10:00:00-04:00').forecastWeek, '2026-10-09');       // Saturday
  assert.equal(wk('2026-10-04T23:59:00-04:00').forecastWeek, '2026-10-09');       // Sunday night
  assert.equal(wk('2026-10-02T11:00:00-04:00').cutoffAt, '2026-10-02T12:00:00.000-04:00');
  assert.equal(wk('2026-10-02T11:00:00-04:00').previousWeek, '2026-09-25');
});
test('configured cutoff is Friday 5:00 PM ET: the 2:00 PM Friday call is before it', () => {
  const cfg = { weekday: 'Friday', time_et: '17:00' };
  assert.equal(C.forecastWeekFor(Date.parse('2026-10-02T14:30:00-04:00'), cfg).forecastWeek, '2026-10-02');
  assert.equal(C.forecastWeekFor(Date.parse('2026-10-02T16:59:59.999-04:00'), cfg).forecastWeek, '2026-10-02');
  assert.equal(C.forecastWeekFor(Date.parse('2026-10-02T17:00:00-04:00'), cfg).forecastWeek, '2026-10-09');
  assert.equal(C.forecastWeekFor(Date.parse('2026-11-06T21:59:59Z'), cfg).forecastWeek, '2026-11-06');        // 4:59:59 PM EST
  assert.equal(C.forecastWeekFor(Date.parse('2026-11-06T22:00:00Z'), cfg).forecastWeek, '2026-11-13');
  assert.equal(C.forecastWeekFor(Date.parse('2026-10-02T12:00:00-04:00'), cfg).cutoffAt, '2026-10-02T17:00:00.000-04:00');
});
test('forecast week: DST (Nov 6 cutoff is 12:00 EST) and a UTC timestamp that is still Friday morning in ET', () => {
  assert.equal(wk('2026-11-06T16:59:59Z').forecastWeek, '2026-11-06');   // 11:59:59 EST
  assert.equal(wk('2026-11-06T17:00:00Z').forecastWeek, '2026-11-13');   // 12:00 EST
  assert.equal(wk('2026-11-06T17:00:00Z').cutoffAt, '2026-11-13T12:00:00.000-05:00');
  assert.equal(wk('2026-10-02T03:30:00Z').forecastWeek, '2026-10-02');   // Thu 11:30 PM ET
});
test('forecast week: no holiday adjustment; year rollover to 2027-01-01', () => {
  assert.equal(wk('2026-12-24T10:00:00-05:00').forecastWeek, '2026-12-25');
  assert.equal(wk('2026-12-25T12:30:00-05:00').forecastWeek, '2027-01-01');
  assert.deepEqual(C.forecastPeriodFor('2026-12-28', '2027-01-01'), { start: '2027-01-01', end: '2027-12-31', fiscalYear: 2027 });
  assert.deepEqual(C.forecastPeriodFor('2026-10-01', '2026-10-02'), { start: '2026-10-01', end: '2026-12-31', fiscalYear: 2026 });
});

// ------------------------------------------------------------------ validation
test('validateForecast: nesting rule, negative, non-numeric, blank, precision block', () => {
  const v = (c, g, b, ctx) => C.validateForecast({ commit: c, gut: g, best_case: b }, ctx || {});
  assert.equal(v(100, 200, 300).ok, true);
  assert.equal(v(100, 100, 100).ok, true);                          // equal is allowed
  assert.equal(v(0, 0, 0).ok, true);
  assert.deepEqual(v(300, 200, 400).errors.map((e) => e.code), ['nesting']);
  assert.deepEqual(v(100, 500, 400).errors.map((e) => e.code), ['nesting']);
  assert.deepEqual(v(500, 400, 300).errors.map((e) => e.code), ['nesting', 'nesting']);
  assert.deepEqual(v(-1, 5, 10).errors.map((e) => e.code), ['negative']);
  assert.deepEqual(v('abc', 5, 10).errors.map((e) => e.code), ['non_numeric']);
  assert.deepEqual(v('', 5, 10).errors.map((e) => e.code), ['required']);
  assert.deepEqual(v(1.234, 5, 10).errors.map((e) => e.code), ['precision']);
  assert.deepEqual(v('NaN', 'Infinity', '1e9').errors.map((e) => e.code), ['non_numeric', 'non_numeric', 'non_numeric']);
  assert.deepEqual(v('$1,200,000', '1,500,000.50', 2000000).values, { commit: 1200000, gut: 1500000.5, best_case: 2000000 });
});
test('validateForecast: Best Case above in-period pipeline warns but does not block', () => {
  const r = C.validateForecast({ commit: 1, gut: 2, best_case: 1000 }, { inPeriodPipeline: 999, periodEnd: '2026-12-31' });
  assert.equal(r.ok, true); assert.deepEqual(r.warnings.map((w) => w.code), ['best_case_exceeds_in_period_pipeline']);
  assert.equal(C.validateForecast({ commit: 1, gut: 2, best_case: 999 }, { inPeriodPipeline: 999 }).warnings.length, 0);
});

// ------------------------------------------------------------------ official / status / naming
test('officialAssignments + status: latest per AE per week is official; sequence counts resubmissions', () => {
  const rows = [
    { ae_slug: 'a', forecast_week: 'W1', submitted_at: '2026-09-28T10:00' }, { ae_slug: 'a', forecast_week: 'W1', submitted_at: '2026-10-01T10:00' },
    { ae_slug: 'b', forecast_week: 'W1', submitted_at: '2026-09-29T10:00' }, { ae_slug: 'a', forecast_week: 'W2', submitted_at: '2026-10-05T10:00' }];
  assert.deepEqual(C.officialAssignments(rows), [{ seq: 1, official: false }, { seq: 2, official: true }, { seq: 1, official: true }, { seq: 1, official: true }]);
  assert.equal(C.submissionStatus(rows, 'a', 'W1'), 'resubmitted');
  assert.equal(C.submissionStatus(rows, 'b', 'W1'), 'submitted');
  assert.equal(C.submissionStatus(rows, 'b', 'W2'), 'not_submitted');
});
test('snapshotFileName', () => {
  assert.equal(C.snapshotFileName('2026-10-02', 'phil-aroian', '2026-10-02T10:41:07.312-04:00'),
               'forecast_2026-10-02_phil-aroian_2026-10-02T10-41-07.312-04-00.json');
});

// ------------------------------------------------------------------ API end-to-end (real .gs, fake HubSpot/Drive/Sheets)
const PROD = '1WGzeVVLMlfTHpU9S5GKVB45EDRx84I_P';
function app(email, opts = {}) { const a = loadApp({ email, now: '2026-09-28T10:00:00-04:00', ...opts }); a.ctx.pullData_(); return a; }
const snapFiles = (a, folderId = PROD) => a.store.drive.filesIn(a.store.drive.folder(folderId)).filter((f) => f.name.startsWith('forecast_'));

test('submit: writes one immutable snapshot + rollup row with submission-time context and builder tags', () => {
  const a = app('ben.dewinter@findigs.com');
  const deals = a.call('apiGetBuilder', null).deals;
  a.call('apiSaveTags', 'ben-de-winter', [{ dealId: deals[0].id, tag: 'commit' }, { dealId: deals[1].id, tag: 'gut' }]);
  const r = a.call('apiSubmitForecast', { commit: 100000, gut: '250,000', best_case: 900000 }).result;
  assert.equal(r.forecastWeek, '2026-10-02'); assert.equal(r.resubmissionSeq, 1);
  const files = snapFiles(a);
  assert.equal(files.length, 1); assert.equal(files[0].name, r.fileName); assert.match(r.fileName, /^forecast_2026-10-02_ben-de-winter_2026-09-28T10-00-00\.000-04-00\.json$/);
  const snap = JSON.parse(files[0].body);
  assert.equal(snap.schema_version, '1.1'); assert.deepEqual(snap.forecast, { commit: 100000, gut: 250000, best_case: 900000 });
  assert.deepEqual(snap.forecast_period, { start: '2026-09-28', end: '2026-12-31' });
  assert.equal(snap.context_at_submission.closed_won_ytd.amount, 484825.04);
  assert.equal(snap.context_at_submission.gross_open_pipeline.amount, 6325852);
  assert.equal(snap.context_at_submission.weighted_open_pipeline.amount, 987700.4);
  assert.equal(snap.context_at_submission.implied_landing.gut, 734825.04);
  assert.equal(snap.builder.saved, true); assert.equal(snap.builder.deals.length, 12);
  assert.equal(snap.builder.deals.filter((d) => d.tag === 'none').length, 10);
  assert.equal(snap.ae.hubspot_owner_id, '2111244871');
  assert.equal(createHash('sha256').update(files[0].body).digest('hex'), r.sha256);
  const rows = a.store.sheets.submissions.rows;
  assert.equal(rows.length, 2); const rec = Object.fromEntries(rows[0].map((h, i) => [h, rows[1][i]]));
  assert.deepEqual([rec.forecast_week, rec.ae_slug, rec.is_official, rec.resubmission_seq, rec.builder_saved, rec.drive_file_id], ['2026-10-02', 'ben-de-winter', true, 1, true, files[0].id]);
  assert.equal(typeof rec.owner_id, 'string');
});

test('resubmission before the cutoff: new file, earlier row un-officialed; only is_official changed in place', () => {
  const a = app('ben.dewinter@findigs.com');
  a.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 });
  const before = a.store.sheets.submissions.rows[1].slice();
  a.setNow('2026-10-02T11:59:00-04:00');
  const r2 = a.call('apiSubmitForecast', { commit: 10, gut: 20, best_case: 30 }).result;
  assert.equal(r2.forecastWeek, '2026-10-02'); assert.equal(r2.resubmissionSeq, 2);
  const rows = a.store.sheets.submissions.rows, H = rows[0], io = H.indexOf('is_official');
  assert.deepEqual([rows[1][io], rows[2][io]], [false, true]);
  rows[1].forEach((v, i) => { if (i !== io) assert.deepEqual(v, before[i], 'column ' + H[i] + ' changed'); });
  assert.equal(snapFiles(a).length, 2);
  assert.ok(snapFiles(a).every((f) => f.writes === 1 && !f.trashed), 'snapshot files never rewritten or trashed');
  const view = a.call('apiGetSubmission');
  const ben = view.rows.find((x) => x.key === 'ben-de-winter');
  assert.equal(ben.status, 'resubmitted'); assert.equal(ben.forecast.commit.current, 10);
  assert.equal(view.history.length, 2);
});

test('submission after the cutoff counts toward next week and leaves this week intact', () => {
  const a = app('ben.dewinter@findigs.com', { now: '2026-10-02T16:59:59-04:00' });            // configured cutoff: Fri 5:00 PM ET (P5-5)
  a.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 });
  a.setNow('2026-10-02T17:00:00-04:00');
  const late = a.call('apiSubmitForecast', { commit: 5, gut: 6, best_case: 7 }).result;
  assert.equal(late.forecastWeek, '2026-10-09'); assert.equal(late.resubmissionSeq, 1);
  const rows = a.store.sheets.submissions.rows, io = rows[0].indexOf('is_official');
  assert.deepEqual([rows[1][io], rows[2][io]], [true, true]);   // both official, different weeks
  const view = a.call('apiGetSubmission');                       // now in the week ending 10/09
  assert.equal(view.week.forecastWeek, '2026-10-09');
  const f = view.rows.find((x) => x.key === 'ben-de-winter').forecast;
  assert.deepEqual([f.commit.current, f.commit.lastWeek, f.commit.delta.amount], [5, 1, 4]);
});

test('blocking validation happens server-side too (nothing written)', () => {
  const a = app('ben.dewinter@findigs.com');
  for (const bad of [{ commit: 5, gut: 4, best_case: 9 }, { commit: -1, gut: 4, best_case: 9 }, { commit: 'x', gut: 4, best_case: 9 }, {}]) {
    assert.throws(() => a.call('apiSubmitForecast', bad), /Not submitted/);
  }
  assert.equal(snapFiles(a).length, 0); assert.equal(a.store.sheets.submissions.rows.length, 1);
});

test('Best Case above in-period pipeline: submitted with a warning recorded in snapshot and row', () => {
  const a = app('ben.dewinter@findigs.com');
  const r = a.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 5041853 }).result;
  assert.deepEqual(r.warnings.map((w) => w.code), ['best_case_exceeds_in_period_pipeline']);
  assert.deepEqual(JSON.parse(snapFiles(a)[0].body).validation.warnings, ['best_case_exceeds_in_period_pipeline']);
});

test('permissions: everyone sees all rows + totals; leadership cannot submit; AEs submit only their own; Phil (admin) for anyone', () => {
  const lead = app('alexander.schaper@findigs.com');
  assert.throws(() => lead.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 }), /Only AEs/);
  assert.throws(() => lead.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 }, 'ben-de-winter'), /Only AEs/);
  const v = lead.call('apiGetSubmission');
  assert.equal(v.rows.length, 5); assert.equal(v.editableSlug, null); assert.deepEqual(v.editableSlugs, []);
  assert.equal(v.nonRoster.owners.length, 3); assert.equal(v.company.closedWonYtd.amount, 7571305.12);
  assert.equal(v.team.metrics.grossOpen.amount, 66909631.13);
  const ian = app('ian.mclaughlin@findigs.com');
  const iv = ian.call('apiGetSubmission');
  assert.equal(iv.rows.length, 5); assert.equal(iv.team.metrics.grossOpen.amount, 66909631.13); assert.equal(iv.editableSlug, 'ian-mclaughlin');
  assert.equal(ian.call('apiGetSubmission', 'ben-de-winter').editableSlug, 'ian-mclaughlin');   // AEs always act for themselves
  assert.throws(() => ian.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 }, 'ben-de-winter'), /only submit your own/);
  const phil = app('phil.aroian@findigs.com');
  const pv = phil.call('apiGetSubmission');
  assert.equal(pv.editableSlug, 'phil-aroian'); assert.equal(pv.onBehalf, false); assert.equal(pv.editableSlugs.length, 5);
  assert.equal(phil.call('apiGetSubmission', 'matt-lynch').onBehalf, true);
  const r = phil.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 }, 'matt-lynch');
  assert.equal(r.result.onBehalf, true); assert.equal(r.result.aeName, 'Matt Lynch'); assert.equal(r.view.editableSlug, 'matt-lynch');
  assert.equal(phil.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 }).result.aeName, 'Phil Aroian');   // default: himself
});

test('admin submits on behalf of an AE: snapshot and row record the admin as submitter', () => {
  const a = app('will.ritchings@findigs.com');
  const v0 = a.call('apiGetSubmission');
  assert.equal(v0.editableSlug, null); assert.equal(v0.editableSlugs.length, 5);
  assert.throws(() => a.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 }), /Choose the AE/);
  assert.equal(a.call('apiGetSubmission', 'matt-lynch').onBehalf, true);
  const out = a.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 }, 'matt-lynch');
  assert.deepEqual([out.result.onBehalf, out.result.aeName, out.view.editableSlug], [true, 'Matt Lynch', 'matt-lynch']);
  const snap = JSON.parse(snapFiles(a)[0].body);
  assert.deepEqual([snap.ae.slug, snap.submitted_by_email, snap.submitted_on_behalf], ['matt-lynch', 'will.ritchings@findigs.com', true]);
  assert.match(snapFiles(a)[0].name, /_matt-lynch_/);
  const rows = a.store.sheets.submissions.rows, rec = Object.fromEntries(rows[0].map((h, i) => [h, rows[1][i]]));
  assert.deepEqual([rec.ae_slug, rec.ae_email, rec.submitted_by, rec.on_behalf], ['matt-lynch', 'matt.lynch@findigs.com', 'will.ritchings@findigs.com', true]);
  assert.deepEqual(out.view.history.map((h) => [h.onBehalf, h.submittedBy]), [[true, 'will.ritchings@findigs.com']]);
  // the AE's own later submission supersedes the admin's
  a.session.email = 'matt.lynch@findigs.com'; a.setNow('2026-09-29T10:00:00-04:00');
  const own = a.call('apiSubmitForecast', { commit: 5, gut: 6, best_case: 7 });
  assert.equal(own.result.onBehalf, false); assert.equal(own.result.resubmissionSeq, 2);
  const io = rows[0].indexOf('is_official');
  assert.deepEqual([rows[1][io], rows[2][io]], [false, true]);
});

test('rollup header migration: new columns are appended; a mismatched header stops with an error', () => {
  const a = app('ben.dewinter@findigs.com');
  const expected = JSON.parse(JSON.stringify(a.store.sheets.submissions.rows[0]));
  const FakeSheet = a.store.sheets.submissions.constructor;
  const old = new FakeSheet('submissions', expected.slice(0, 27));
  old.appendRow(Array(27).fill('x'));
  a.ctx.ensureHeader_(old, expected);
  const hdr = JSON.parse(JSON.stringify(old.rows[0]));
  assert.deepEqual(hdr, expected); assert.deepEqual(hdr.slice(-2), ['submitted_by', 'on_behalf']);
  assert.equal(old.rows[1].length, 27, 'data rows untouched');
  const bad = new FakeSheet('submissions', ['submission_id', 'WRONG']);
  assert.throws(() => a.ctx.ensureHeader_(bad, expected), /header differs at column 2/);
});

test('two AEs submitting in the same week: separate files and rows, each official, team total sums both', () => {
  const a = app('ben.dewinter@findigs.com');
  a.call('apiSubmitForecast', { commit: 100, gut: 200, best_case: 300 });
  a.session.email = 'matt.lynch@findigs.com';
  a.call('apiSubmitForecast', { commit: 10, gut: 20, best_case: 30 });
  assert.equal(snapFiles(a).length, 2);
  a.session.email = 'brian.korchin@findigs.com';
  const t = a.call('apiGetSubmission').team.forecast;
  assert.deepEqual([t.submittedCount, t.commit.current, t.gut.current, t.best_case.current], [2, 110, 220, 330]);
});

test('lock contention: clear error, nothing written', () => {
  const a = app('ben.dewinter@findigs.com');
  a.store.lockBusy = true;
  assert.throws(() => a.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 }), /Another submission is being saved/);
  assert.equal(snapFiles(a).length, 0);
});

test('zero open pipeline AE can submit $0; Best Case > $0 warns', () => {
  const hub = fakeHubSpot(); hub.open = hub.open.filter((d) => d.properties.hubspot_owner_id !== '167857460');
  const a = app('spencer.wuthrich@findigs.com', { hub });
  const r = a.call('apiSubmitForecast', { commit: 0, gut: 0, best_case: 0 }).result;
  assert.equal(r.warnings.length, 0);
  const snap = JSON.parse(snapFiles(a)[0].body);
  assert.deepEqual([snap.builder.deals.length, snap.builder.saved, snap.context_at_submission.closed_won_ytd.amount], [0, false, 0]);
  a.setNow('2026-09-29T10:00:00-04:00');
  assert.deepEqual(a.call('apiSubmitForecast', { commit: 0, gut: 0, best_case: 5 }).result.warnings.map((w) => w.code), ['best_case_exceeds_in_period_pipeline']);
});

test('year rollover: FY2027 folder not configured blocks the submission; test mode routes to test folder', () => {
  const a = app('ben.dewinter@findigs.com', { now: '2026-12-28T10:00:00-05:00' });
  assert.throws(() => a.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 }), /No Drive folder configured for FY2027/);
  const t = app('ben.dewinter@findigs.com', { now: '2026-12-28T10:00:00-05:00', testFolderId: 'TESTROOT' });
  const r = t.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 }).result;
  assert.equal(r.forecastWeek, '2027-01-01');
  assert.ok(r.warnings.some((w) => w.code === 'fy_rollover_closed_won_reset'));
  const fy27 = t.store.drive.folder('TESTROOT').getFoldersByName('FY2027').next();
  const snap = JSON.parse(t.store.drive.filesIn(fy27).find((f) => f.name.startsWith('forecast_')).body);
  assert.equal(snap.context_at_submission.closed_won_ytd.amount, 0);
  assert.deepEqual(snap.forecast_period, { start: '2027-01-01', end: '2027-12-31' });
  assert.equal(snapFiles(t).length, 0, 'nothing written to the production folder in test mode');
  assert.equal(t.call('apiGetSubmission').testMode, true);
});

test('verifySnapshots detects edited and deleted files', () => {
  const a = app('ben.dewinter@findigs.com');
  a.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 });
  a.setNow('2026-09-29T10:00:00-04:00');
  a.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 4 });
  assert.equal(a.ctx.verifySnapshots(2026).ok, true);
  const [f1, f2] = snapFiles(a);
  f1.body += ' '; f2.trashed = true;
  const v = JSON.parse(JSON.stringify(a.ctx.verifySnapshots(2026)));
  assert.equal(v.ok, false); assert.deepEqual(v.problems.map((p) => p.problem.split(' ')[0]), ['content', 'file']);
});

test('Snapshots.gs never rewrites or deletes Drive files', () => {
  const src = readFileSync(join(ROOT, 'appsscript', 'Snapshots.gs'), 'utf8').replace(/^\s*\*.*$/gm, '');
  for (const bad of ['setContent(', 'setTrashed(', 'removeFile(', '.moveTo(', 'deleteRow', 'clearContent']) assert.ok(!src.includes(bad), bad);
});
