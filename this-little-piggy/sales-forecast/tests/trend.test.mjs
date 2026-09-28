/** Section 3: trend series, change table, movement drill-down, synthetic seeding, and the trend/methodology APIs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadApp } from './helpers/gas_harness.mjs';

const C = createRequire(import.meta.url)('../core/forecast_core.js');
const AES = [{ slug: 'a', name: 'A' }, { slug: 'b', name: 'B' }];
const row = (ae, week, v, extra = {}) => ({ ae_slug: ae, forecast_week: week, submitted_at: C.addDays(week, -1) + 'T11:00:00.000-04:00',
  commit: v[0], gut: v[1], best_case: v[2], closed_won_ytd: v[3] ?? 1000, is_official: true, ...extra });
const J = (x) => JSON.parse(JSON.stringify(x));

// ------------------------------------------------------------------ trendSeries
test('trendSeries: a missing week is a null gap (never zero, never carried forward) and the axis has every Friday', () => {
  const rows = [row('a', '2026-09-04', [10, 20, 30]), row('a', '2026-09-18', [11, 21, 31]), row('b', '2026-09-04', [1, 2, 3]),
                row('b', '2026-09-11', [1, 2, 3]), row('b', '2026-09-18', [1, 2, 3])];
  const s = C.trendSeries(rows, AES, { mode: 'incremental' });
  assert.deepEqual(s.weeks, ['2026-09-04', '2026-09-11', '2026-09-18']);
  const gap = s.byAe.a[1];
  assert.equal(gap.submitted, false);
  for (const k of ['commit', 'gut', 'best_case', 'closed_won_ytd']) assert.equal(gap[k], null);
  assert.equal(s.byAe.a[2].wow.commit, null);            // no WoW across a gap
  assert.equal(s.trendAvailable, true);
});

test('trendSeries: implied landing adds each snapshot\'s own Closed Won YTD; incremental plots raw values', () => {
  const rows = [row('a', '2026-09-04', [10, 20, 30, 500]), row('a', '2026-09-11', [5, 20, 40, 600])];
  const il = C.trendSeries(rows, [AES[0]], { mode: 'implied_landing' }).byAe.a;
  assert.deepEqual([il[0].commit, il[0].gut, il[0].best_case, il[0].closed_won_ytd], [510, 520, 530, 500]);
  assert.deepEqual(il[1].wow, { commit: 95, gut: 100, best_case: 110 });
  const inc = C.trendSeries(rows, [AES[0]], { mode: 'incremental' }).byAe.a;
  assert.deepEqual([inc[1].commit, inc[1].closed_won_ytd], [5, 600]);
  assert.deepEqual(inc[1].wow, { commit: -5, gut: 0, best_case: 10 });
});

test('trendSeries: team sums submitters only, reports coverage, and shows WoW only when both weeks are complete', () => {
  const rows = [row('a', '2026-09-04', [10, 20, 30, 0]), row('b', '2026-09-04', [1, 2, 3, 0]),
                row('a', '2026-09-11', [12, 22, 32, 0]),
                row('a', '2026-09-18', [13, 23, 33, 0]), row('b', '2026-09-18', [2, 3, 4, 0])];
  const t = C.trendSeries(rows, AES, { mode: 'incremental' }).team;
  assert.deepEqual(t.map((p) => [p.coverage, p.complete, p.commit]), [[2, true, 11], [1, false, 12], [2, true, 15]]);
  assert.equal(t[1].wow.commit, null); assert.equal(t[2].wow.commit, null);   // 11 → 12 would be a false drop/rise
});

test('trendSeries: one week of data → trendAvailable false (points only); throughWeek extends the axis with a gap', () => {
  const s = C.trendSeries([row('a', '2026-09-18', [1, 2, 3])], AES, { throughWeek: '2026-09-25' });
  assert.equal(s.weeksWithData, 1); assert.equal(s.trendAvailable, false);
  assert.deepEqual(s.weeks, ['2026-09-18', '2026-09-25']);
  assert.equal(s.byAe.a[1].submitted, false); assert.equal(s.team[1].commit, null);
  assert.deepEqual(C.trendSeries([], AES).weeks, []);
});

test('trendSeries: only official rows are plotted; superseded same-week submissions feed the overlay and resubmission count', () => {
  const rows = [row('a', '2026-09-11', [5, 6, 7, 100], { is_official: false, submitted_at: '2026-09-10T09:00:00.000-04:00' }),
                row('a', '2026-09-11', [8, 9, 10, 100], { is_official: false, submitted_at: '2026-09-10T10:00:00.000-04:00' }),
                row('a', '2026-09-11', [11, 12, 13, 100])];
  const p = C.trendSeries(rows, [AES[0]], { mode: 'implied_landing' }).byAe.a[0];
  assert.equal(p.commit, 111); assert.equal(p.submissions, 3); assert.equal(p.resubmissions, 2);
  assert.deepEqual(p.overlay.map((o) => [o.submittedAt.slice(11, 16), o.commit]), [['09:00', 105], ['10:00', 108]]);
});

// ------------------------------------------------------------------ changeTable / defaultReportWeek
test('changeTable: highlight strictly beyond ±threshold, and any change from $0; Team Δ is like-for-like', () => {
  const rows = [row('a', '2026-09-11', [100, 1000, 0]), row('a', '2026-09-18', [110, 1101, 5]),
                row('b', '2026-09-18', [50, 60, 70])];
  const ct = C.changeTable(rows, AES, '2026-09-18', 0.10);
  const a = ct.rows[0].values;
  assert.equal(a.commit.delta, 10); assert.equal(a.commit.highlight, false);          // exactly 10% is not "beyond"
  assert.equal(a.gut.highlight, true); assert.ok(Math.abs(a.gut.pct - 0.101) < 1e-9);
  assert.equal(a.best_case.pct, null); assert.equal(a.best_case.highlight, true);     // from $0
  const b = ct.rows[1];
  assert.equal(b.submittedPrior, false); assert.equal(b.values.commit.prior, null); assert.equal(b.values.commit.delta, null);
  assert.equal(ct.team.values.commit.current, 160); assert.equal(ct.team.values.commit.prior, 100);
  assert.equal(ct.team.values.commit.delta, 10);                                       // A only; B's 50 is not "growth"
  assert.equal(ct.team.likeForLike, 1);
});

test('defaultReportWeek: latest closed week with data; the open week only when nothing closed exists', () => {
  const rows = [row('a', '2026-09-18', [1, 2, 3]), row('a', '2026-10-02', [1, 2, 3])];
  assert.equal(C.defaultReportWeek(rows, '2026-10-02'), '2026-09-18');
  assert.equal(C.defaultReportWeek([row('a', '2026-10-02', [1, 2, 3])], '2026-10-02'), '2026-10-02');
  assert.equal(C.defaultReportWeek([], '2026-10-02'), '2026-10-02');
});

// ------------------------------------------------------------------ movementDrilldown
function snap(week, forecast, deals, saved = true) {
  const tags = {}; deals.forEach((d) => { tags[d.id] = { tag: d.tag }; });
  const s = C.builderSummary(deals.map((d) => ({ id: d.id, amount: d.amount, closeDate: '2026-12-01' })), tags, '2026-12-31');
  return { forecast_week: week, forecast: { commit: forecast[0], gut: forecast[1], best_case: forecast[2] },
           builder: { saved, totals: { commit: s.cumulative.commit.amount, gut_cumulative: s.cumulative.gut.amount, best_case_cumulative: s.cumulative.best_case.amount },
                      deals: deals.map((d) => ({ deal_id: d.id, deal_name: 'Deal ' + d.id, amount: d.amount, stage: 'S', tag: d.tag })) } };
}
const P = [{ id: '1', amount: 100, tag: 'commit' }, { id: '2', amount: 50, tag: 'gut' }, { id: '3', amount: 30, tag: 'best_case' },
           { id: '4', amount: 20, tag: 'none' }, { id: '5', amount: 10, tag: 'commit' }];
const N = [{ id: '1', amount: 120, tag: 'commit' }, { id: '2', amount: 50, tag: 'commit' }, { id: '3', amount: 30, tag: 'lost' },
           { id: '4', amount: 20, tag: 'gut' }, { id: '6', amount: 40, tag: 'best_case' }];     // 5 left; 6 joined

test('movementDrilldown: added/removed per tag, tag changes with amounts, left/joined pipeline, and the reconciliation identity', () => {
  const prev = snap('2026-09-11', [110, 160, 190], P), cur = snap('2026-09-18', [170, 190, 230], N);
  const m = C.movementDrilldown(prev, cur);
  assert.equal(m.status, 'ok');
  assert.deepEqual(m.added.commit.map((x) => x.deal_id), ['2']);
  assert.deepEqual(m.removed.gut.map((x) => x.deal_id), ['2']);
  assert.deepEqual(m.added.lost.map((x) => x.deal_id), ['3']);
  assert.deepEqual(m.removed.commit.map((x) => x.deal_id), ['5']);                 // left pipeline while tagged
  assert.deepEqual(m.changed.map((x) => [x.deal_id, x.before.tag, x.after.tag]), [['2', 'gut', 'commit'], ['3', 'best_case', 'lost'], ['4', 'none', 'gut']]);
  assert.deepEqual(m.leftPipeline.map((x) => x.deal_id), ['5']); assert.deepEqual(m.joinedPipeline.map((x) => x.deal_id), ['6']);
  assert.deepEqual(m.amountChanges.map((x) => [x.deal_id, x.before.amount, x.after.amount]), [['1', 100, 120]]);
  const r = m.reconciliation;
  // Commit: 110 → 170: +50 (2 retagged in) −10 (5 left) +20 (1 amount) = +60
  assert.deepEqual([r.commit.byCategory.retaggedIn, r.commit.byCategory.leftPipeline, r.commit.amountChange, r.commit.tagMovement, r.commit.unexplained], [50, -10, 20, 60, 0]);
  // Gut (commit+gut): +20 (4 in) −10 (5 left) +20 (amount) = +30
  assert.equal(r.gut.tagMovement, 30); assert.equal(r.gut.reconciles, true);
  // Best Case: +20 (4) +40 (6 joined) −30 (3 → lost) −10 (5 left) +20 = +40
  assert.equal(r.best_case.tagMovement, 40); assert.equal(r.best_case.byCategory.joinedPipeline, 40);
  assert.equal(m.allReconcile, true);
  for (const k of ['commit', 'gut', 'best_case']) {
    assert.equal(C.round2(r[k].builderCurrent - r[k].builderPrior), r[k].tagMovement);   // tags explain builder totals exactly
  }
});

test('movementDrilldown: a submitted change tag movement does not explain is reported as unexplained, never hidden', () => {
  const m = C.movementDrilldown(snap('2026-09-11', [110, 160, 190], P), snap('2026-09-18', [500, 500, 500], N));
  assert.equal(m.allReconcile, false);
  assert.equal(m.reconciliation.commit.unexplained, 330);       // 390 submitted − 60 explained
  assert.equal(m.reconciliation.commit.reconciles, false);
  assert.equal(C.movementDrilldown(snap('w1', [110, 160, 190], P), snap('w2', [170.01, 190, 230], N)).reconciliation.commit.reconciles, true);  // $0.01 tolerance
});

test('movementDrilldown: no builder tags saved in either week → no movement inferred; missing snapshot → says so', () => {
  const m = C.movementDrilldown(snap('2026-09-11', [1, 2, 3], P), snap('2026-09-18', [4, 5, 6], N, false));
  assert.equal(m.status, 'no_builder_tags'); assert.match(m.message, /this week.*not inferred/);
  assert.equal(m.added, undefined); assert.equal(m.reconciliation, undefined);
  assert.deepEqual(m.submittedDelta, { commit: 3, gut: 3, best_case: 3 });
  assert.match(C.movementDrilldown(snap('a', [1, 2, 3], P, false), snap('b', [1, 2, 3], N)).message, /prior week/);
  assert.equal(C.movementDrilldown(null, snap('b', [1, 2, 3], N)).status, 'missing_snapshot');
  assert.match(C.movementDrilldown(snap('a', [1, 2, 3], P), null).message, /this week/);
});

// ------------------------------------------------------------------ synthetic seeding + APIs
const seeded = () => { const app = loadApp({ testFolderId: 'TEST', now: '2026-09-28T10:00:00-04:00' }); const r = app.call('seedSyntheticSnapshots'); return { app, r }; };

test('seedSyntheticSnapshots: refuses outside test mode and refuses to seed twice', () => {
  const prod = loadApp();
  assert.throws(() => prod.call('seedSyntheticSnapshots'), /TEST MODE/);
  assert.equal(prod.store.rollups.P2026.submissions.rows.length, 1);
  const { app, r } = seeded();
  assert.deepEqual(r.weeks, ['2026-09-04', '2026-09-11', '2026-09-18', '2026-09-25']);
  assert.equal(r.snapshotsWritten, 22); assert.deepEqual(r.skippedExisting, []);
  assert.throws(() => app.call('seedSyntheticSnapshots'), /not seeding twice/);
  assert.equal(app.store.rollups.P2026.submissions.rows.length, 1);                   // production rollup never touched (header only)
  const files = Object.values(app.store.drive.files).filter((f) => f.name.startsWith('forecast_synthetic_'));
  assert.equal(files.length, 22);
  assert.ok(files.every((f) => JSON.parse(f.body).synthetic === true && f.writes === 1));
});

test('seedSyntheticSnapshots: skips any AE/week that already has a real test submission', () => {
  const app = loadApp({ testFolderId: 'TEST', email: 'ben.dewinter@findigs.com', now: '2026-09-24T10:00:00-04:00' });
  app.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 });
  app.setNow('2026-09-28T10:00:00-04:00');
  app.session.email = 'will.ritchings@findigs.com';
  const r = app.call('seedSyntheticSnapshots');
  assert.deepEqual(r.skippedExisting, ['ben-de-winter|2026-09-25']);
  const t = app.call('apiGetTrend');
  assert.equal(t.rows.filter((x) => x.ae_slug === 'ben-de-winter' && x.forecast_week === '2026-09-25' && x.is_official).length, 1);
});

test('apiGetTrend + trendSeries on seeded data: Spencer gap, Ian resubmissions, report week = last closed week', () => {
  const { app } = seeded();
  const t = app.call('apiGetTrend');
  assert.equal(t.testMode, true); assert.equal(t.syntheticRows, 22); assert.equal(t.reportWeek, '2026-09-25'); assert.equal(t.threshold, 0.1);
  assert.equal(t.rows[0].email, undefined);                                            // light rows only
  const s = C.trendSeries(t.rows, t.aes, {});
  assert.equal(s.byAe['spencer-wuthrich'][1].submitted, false);
  assert.equal(s.byAe['spencer-wuthrich'][1].commit, null);
  assert.equal(s.team[1].coverage, 4);
  assert.equal(s.byAe['ian-mclaughlin'][2].resubmissions, 1); assert.equal(s.byAe['ian-mclaughlin'][2].overlay.length, 1);
  assert.equal(s.trendAvailable, true);
});

test('apiGetMovement: planned scenarios, integrity check on read, and unknown AE', () => {
  const { app } = seeded();
  assert.equal(app.call('apiGetMovement', 'phil-aroian', '2026-09-18').allReconcile, true);
  const matt = app.call('apiGetMovement', 'matt-lynch', '2026-09-25');
  assert.equal(matt.status, 'ok'); assert.equal(matt.allReconcile, false); assert.equal(matt.synthetic, true);
  assert.ok(matt.reconciliation.commit.unexplained !== 0);
  assert.equal(app.call('apiGetMovement', 'ben-de-winter', '2026-09-18').status, 'no_builder_tags');
  assert.equal(app.call('apiGetMovement', 'spencer-wuthrich', '2026-09-18').status, 'missing_snapshot');
  assert.deepEqual(app.call('apiGetMovement', 'phil-aroian', '2026-09-04').integrity, { current: 'ok', prior: 'none' });
  // Tamper with a file behind the app's back: the drill-down says so rather than trusting it silently.
  const f = Object.values(app.store.drive.files).find((x) => x.name.includes('_phil-aroian_') && x.name.includes('2026-09-18'));
  f.body = f.body.replace('"synthetic": true', '"synthetic": true ');
  assert.equal(app.call('apiGetMovement', 'phil-aroian', '2026-09-18').integrity.current, 'changed');
  f.trashed = true;
  assert.equal(app.call('apiGetMovement', 'phil-aroian', '2026-09-18').integrity.current, 'missing');
  assert.throws(() => app.call('apiGetMovement', 'nobody', '2026-09-18'), /Unknown AE/);
});

test('apiGetMethodology: lists fields, pipelines incl. Renewal exclusion, stages, weighting counts, pull time, definitions, cutoff, storage, caveats', () => {
  const app = loadApp();
  const m = app.call('apiGetMethodology');
  assert.equal(m.fields.bookings_amount, 'amount');
  assert.ok(['hs_acv', 'hs_forecast_amount'].every((f) => f in m.notUsed));
  const renewal = m.pipelines.find((p) => p.id === '2559714036');
  assert.equal(renewal.inScope, false);
  assert.deepEqual(m.pipelines.filter((p) => p.inScope).map((p) => p.id).sort(), ['2313721535', '2313830082']);
  assert.ok(m.stages.length > 0 && m.stages.every((s) => s.id && 'probability' in s));
  assert.equal(m.weighting.method, 'stage_probability'); assert.equal(m.weighting.stageWeightedCount, 107); assert.equal(m.weighting.weightedTotal, 11304048.49);
  assert.ok(m.pulledAt); assert.equal(m.tieOut.ok, true); assert.equal(m.refreshMinutes, 30);
  assert.match(m.definitions.nesting_rule, /Commit ≤ Gut ≤ Best Case/);
  assert.equal(m.cutoff.time_et, '17:00');
  assert.equal(m.storage.productionFolderId, '1WGzeVVLMlfTHpU9S5GKVB45EDRx84I_P');
  assert.ok(m.flags.length > 0 && m.nonRoster.length === 3);
  assert.equal(JSON.stringify(m).includes('@findigs.com'), true);                     // viewer only
  assert.equal(JSON.stringify(J(m.nonRoster)).includes('@'), false);
});

test('syntheticHistory is deterministic and every non-mismatch week with tags reconciles', () => {
  const { app } = seeded();
  const t = app.call('apiGetTrend');
  for (const a of t.aes) for (const w of ['2026-09-11', '2026-09-18', '2026-09-25']) {
    const m = app.call('apiGetMovement', a.slug, w);
    if (m.status !== 'ok') continue;
    assert.equal(m.allReconcile, !(a.slug === 'matt-lynch' && w === '2026-09-25'), a.slug + ' ' + w);
  }
});

test('apiGetTrend: the open week is hidden until its cutoff passes, and counted for the note', () => {
  const app = loadApp({ email: 'ben.dewinter@findigs.com', now: '2026-09-24T10:00:00-04:00' });
  app.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 });
  let t = app.call('apiGetTrend');
  assert.equal(t.rows.length, 0); assert.equal(t.openWeekRows, 1);
  app.setNow('2026-09-25T16:59:59-04:00');
  assert.equal(app.call('apiGetTrend').rows.length, 0);
  app.setNow('2026-09-25T17:00:00-04:00');                                               // cutoff passed → week of Sep 25 closes
  t = app.call('apiGetTrend');
  assert.deepEqual(t.rows.map((r) => r.forecast_week), ['2026-09-25']); assert.equal(t.openWeekRows, 0); assert.equal(t.reportWeek, '2026-09-25');
});

