/**
 * Phase 5 QA cases that need the whole stack (real .gs on fake HubSpot/Drive/Sheets): concurrent submissions,
 * an inactive owner holding an open deal, and a deal with no amount, end to end. See docs/QA.md for the full list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadApp, fakeHubSpot, FIXTURE } from './helpers/gas_harness.mjs';

const C = createRequire(import.meta.url)('../core/forecast_core.js');
const PROD = '1WGzeVVLMlfTHpU9S5GKVB45EDRx84I_P';
const BEN = '2111244871', HAYDEN = '1542312872';
const clone = (x) => JSON.parse(JSON.stringify(x));
function app(email, opts = {}) { const a = loadApp({ email, now: '2026-09-28T10:00:00-04:00', ...opts }); a.ctx.pullData_(); return a; }
const snapFiles = (a) => a.store.drive.filesIn(a.store.drive.folder(PROD)).filter((f) => f.name.startsWith('forecast_'));
const subRows = (a) => clone(a.ctx.readSubmissions_(2026));

/** Run `during` while `a`'s submission is between its HubSpot pull and its locked write. */
function interleave(a, during) {
  const orig = a.ctx.pullOwnerFigures_;
  let done = false;
  a.ctx.pullOwnerFigures_ = (id) => { const r = orig(id); if (!done) { done = true; during(); } return r; };
  return () => { a.ctx.pullOwnerFigures_ = orig; };
}

test('concurrent submissions by two AEs: both land, each official, nothing overwritten', () => {
  const a = app('ben.dewinter@findigs.com');
  const restore = interleave(a, () => {
    a.session.email = 'matt.lynch@findigs.com'; a.setNow('2026-09-28T10:00:01-04:00');
    a.call('apiSubmitForecast', { commit: 10, gut: 20, best_case: 30 });
    a.session.email = 'ben.dewinter@findigs.com';
  });
  const r = a.call('apiSubmitForecast', { commit: 100, gut: 200, best_case: 300 }).result;
  restore();
  assert.equal(r.official, true);
  const rows = subRows(a);
  assert.deepEqual(rows.map((x) => [x.ae_slug, x.is_official, x.commit]).sort(), [['ben-de-winter', true, 100], ['matt-lynch', true, 10]]);
  assert.equal(snapFiles(a).length, 2);
  assert.ok(snapFiles(a).every((f) => f.writes === 1));
});

test('overlapping submissions for the same AE: the later submitted_at stays official even if it was written first', () => {
  const a = app('ben.dewinter@findigs.com');
  // Ben starts at 10:00:00; while his HubSpot pull runs, the admin submits for him at 10:00:05 and finishes first.
  const restore = interleave(a, () => {
    a.session.email = 'will.ritchings@findigs.com'; a.setNow('2026-09-28T10:00:05-04:00');
    a.call('apiSubmitForecast', { commit: 50, gut: 60, best_case: 70 }, 'ben-de-winter');
    a.session.email = 'ben.dewinter@findigs.com';
  });
  const r = a.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 }).result;
  restore();
  assert.equal(r.official, false);
  const rows = subRows(a).sort((x, y) => (x.submitted_at < y.submitted_at ? -1 : 1));
  assert.deepEqual(rows.map((x) => [x.submitted_at.slice(11, 19), x.commit, x.is_official]), [['10:00:00', 1, false], ['10:00:05', 50, true]]);
  assert.equal(rows.filter((x) => x.is_official).length, 1);
  assert.equal(snapFiles(a).length, 2);                                   // both snapshots kept
});

test('inactive owner holding an open deal: in the non-roster row and company total, flagged, in no AE row or builder', () => {
  const open = clone(FIXTURE.open);
  const moved = open.find((d) => d.properties.hubspot_owner_id === BEN);
  moved.properties.hubspot_owner_id = HAYDEN;                             // Hayden Ashwill is archived (inactive) in HubSpot
  const hub = fakeHubSpot({ openOverride: open });
  const a = app('brian.korchin@findigs.com', { hub });
  const d = a.call('apiGetData', false);
  assert.equal(d.tieOut.ok, true);                                        // still reconciles to the independent query
  const hayden = d.nonRoster.owners.find((o) => o.ownerId === HAYDEN);
  assert.equal(hayden.ownerStatus, 'inactive');
  assert.equal(hayden.metrics.grossOpen.count, 1); assert.equal(hayden.metrics.grossOpen.amount, Number(moved.properties.amount));
  assert.ok(d.flags.some((f) => f.code === 'NON_ROSTER_OPEN_DEALS' && f.ownerId === HAYDEN));
  const aeSum = d.rows.reduce((s, r) => s + r.metrics.grossOpen.amount, 0);
  assert.equal(C.round2(aeSum + d.nonRoster.total.grossOpen.amount), d.company.grossOpen.amount);
  assert.ok(!a.call('apiGetBuilder', 'ben-de-winter').deals.some((x) => x.id === String(moved.id)));
});

test('deal with no amount: blank and flagged, never imputed; tagging it adds $0 and warns; snapshot stores null', () => {
  const open = clone(FIXTURE.open);
  const blank = open.find((d) => d.properties.hubspot_owner_id === BEN);
  blank.properties.amount = null;
  const a = app('ben.dewinter@findigs.com', { hub: fakeHubSpot({ openOverride: open }) });
  const d = a.call('apiGetData', false);
  assert.equal(d.tieOut.ok, true);
  const f = d.flags.find((x) => x.code === 'MISSING_AMOUNT');
  assert.equal(f.count, 1); assert.deepEqual(f.dealIds, [String(blank.id)]);
  const ben = d.rows.find((r) => r.key === 'ben-de-winter');
  assert.equal(ben.metrics.grossOpen.nullAmountCount, 1);
  const b = a.call('apiGetBuilder', null), deal = b.deals.find((x) => x.id === String(blank.id));
  assert.equal(deal.amount, null); assert.equal(deal.weighted, null); assert.ok(deal.flags.includes('missing_amount'));
  a.call('apiSaveTags', 'ben-de-winter', [{ dealId: deal.id, tag: 'commit' }]);
  const s = C.builderSummary(b.deals, { [deal.id]: { tag: 'commit' } }, b.period.end);
  assert.deepEqual(s.cumulative.commit, { amount: 0, count: 1 });
  assert.deepEqual(s.warnings.missingAmountTagged, [deal.id]);
  a.call('apiSubmitForecast', { commit: 0, gut: 0, best_case: 0 });
  const snap = JSON.parse(snapFiles(a)[0].body), sd = snap.builder.deals.find((x) => x.deal_id === deal.id);
  assert.equal(sd.amount, null); assert.equal(sd.tag, 'commit'); assert.ok(sd.flags.includes('missing_amount'));
});

// ------------------------------------------------------------------ year rollover
test('lastWeekOfYear + rolloverStatus: warning from Dec 1 until next FY folder exists; blocks at the last Friday cutoff', () => {
  const CUT = { weekday: 'Friday', time_et: '12:00' };
  assert.equal(C.lastWeekOfYear(2026, CUT), '2026-12-25');
  assert.equal(C.lastWeekOfYear(2027, CUT), '2027-12-31');                               // Dec 31 is itself a Friday
  const F = { 2026: 'x' };
  assert.equal(C.rolloverStatus('2026-11-30', F, CUT), null);
  const r = C.rolloverStatus('2026-12-01', F, CUT);
  assert.equal(r.nextFiscalYear, 2027); assert.equal(r.blocksSubmissionsAt, '2026-12-25T12:00:00.000-05:00'); assert.equal(r.blocksAppAt, '2027-01-01');
  assert.match(r.message, /week of 2027-01-01 are blocked from 2026-12-25 12:00 ET/);
  assert.equal(C.rolloverStatus('2026-12-01', { 2026: 'x', 2027: 'y' }, CUT), null);
});

test('rollover banner data goes to admins only', () => {
  const admin = loadApp({ email: 'will.ritchings@findigs.com', asOf: '2026-12-02', now: '2026-12-02T10:00:00-05:00' });
  admin.ctx.pullData_();
  assert.equal(admin.call('apiGetSubmission').viewer.rollover.nextFiscalYear, 2027);
  admin.session.email = 'ben.dewinter@findigs.com';
  assert.equal(admin.call('apiGetSubmission').viewer.rollover, null);
});

test('trend in the first week of January defaults to the year just ended; the axis runs to its last Friday', () => {
  const a = loadApp({ email: 'ben.dewinter@findigs.com', asOf: '2026-12-17', now: '2026-12-17T10:00:00-05:00' });
  a.ctx.pullData_();
  a.call('apiSubmitForecast', { commit: 1, gut: 2, best_case: 3 });                         // week of Dec 18
  a.setNow('2026-12-28T10:00:00-05:00');                                                     // open week = 2027-01-01 (FY2027, not configured)
  const t = a.call('apiGetTrend');
  assert.equal(t.fiscalYear, 2026); assert.deepEqual(t.years, [2026]);
  assert.equal(t.throughWeek, '2026-12-25');
  assert.deepEqual(C.trendSeries(t.rows, t.aes, { throughWeek: t.throughWeek }).weeks, ['2026-12-18', '2026-12-25']);  // Dec 25 = gap
  assert.throws(() => a.call('apiGetTrend', 2025), /No Drive folder is configured for FY2025/);
});
