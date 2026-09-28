import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildConfig } from '../scripts/build.mjs';

const require = createRequire(import.meta.url);
const C = require('../core/forecast_core.js');
const { config: CFG } = buildConfig();
const HS = CFG.hubspot;
const NL = '2313721535', UP = '2313830082', REN = '2559714036';

// ------------------------------------------------------------------ fixtures
function pipelines(overrides = {}) {
  const st = (id, label, order, prob, closed) => ({ id, label, displayOrder: order, metadata: { isClosed: String(!!closed), probability: String(prob) } });
  return { results: [
    { id: NL, label: 'New Logo', stages: [st('3753890497', 'Intro & Challenge', 0, 0.1), st('3753890498', 'Discovery / Demo', 1, 0.2),
      st('3753890500', 'Negotiation & Execution', 3, 0.6), st('3753890502', 'Closed Won', 5, overrides.nlWonProb ?? 1, true),
      st('3753890503', 'Closed Lost', 6, 0, true)] },
    { id: UP, label: 'Upsell / Expansion', stages: [st('3752297191', 'Intro & Challenge', 0, 0.2), st('3752297196', 'Closed Won', 5, 1, true),
      st('3752297197', 'Closed Lost', 6, 0, true)] },
    { id: REN, label: 'Renewal', stages: [st('9999', 'Renewed', 0, 1, true)] }
  ].filter((p) => !(overrides.dropUpsell && p.id === UP)) };
}
const SM = C.buildStageMap(pipelines(), HS);
const deal = (id, o) => ({ id, properties: { dealname: 'D' + id, pipeline: NL, dealstage: '3753890497', hubspot_owner_id: '1', amount: '1000',
  units__c: '10', closedate: '2026-11-15T05:00:00Z', hs_deal_stage_probability: '0.1', ...o } });
const ctx = (asOf = '2026-09-25') => ({ hs: HS, stageMap: SM, portalId: CFG.portalId, asOf, fyStart: '2026-01-01', periodEnd: '2026-12-31' });
const ROSTER = {
  aes: [{ name: 'A One', slug: 'a-one', email: 'a.one@findigs.com', hubspot_owner_id: '1', role: 'ae' },
        { name: 'B Two', slug: 'b-two', email: 'b.two@findigs.com', hubspot_owner_id: '2', role: 'ae_leader' },
        { name: 'Z Zero', slug: 'z-zero', email: 'z.zero@findigs.com', hubspot_owner_id: '3', role: 'ae' }],
  leadership: [{ name: 'Lead', email: 'lead@findigs.com' }], admins: [{ name: 'Adm', email: 'adm@findigs.com' }],
  non_roster_owners: { owners: [{ name: 'Gone', hubspot_owner_id: '9', reason: 'departed' }] }
};
const OWNERS = C.normalizeOwners([
  { id: '1', firstName: 'A', lastName: 'One', userId: 11, archived: false }, { id: '2', firstName: 'B', lastName: 'Two', userId: 12, archived: false },
  { id: '3', firstName: 'Z', lastName: 'Zero', userId: 13, archived: false }, { id: '9', firstName: 'Gone', lastName: 'Person', userId: null, archived: false }
]);

// ------------------------------------------------------------------ numbers
test('num: blanks and empty strings are null, float noise parses', () => {
  assert.equal(C.num(''), null); assert.equal(C.num('  '), null); assert.equal(C.num(null), null); assert.equal(C.num(undefined), null);
  assert.equal(C.num('abc'), null); assert.equal(C.num('0'), 0);
  assert.ok(Math.abs(C.num('0.59999999999999997779553950749686919152736663818359375') - 0.6) < 1e-12);
});

// ------------------------------------------------------------------ ET time
test('etDate: FY boundary in UTC vs ET', () => {
  assert.equal(C.etDate('2025-12-31T05:00:00Z'), '2025-12-31');        // live case: OneSource RE
  assert.equal(C.etDate('2027-01-01T04:59:59Z'), '2026-12-31');
  assert.equal(C.etDate('2027-01-01T05:00:00Z'), '2027-01-01');
  assert.equal(C.etDate('2026-07-01T03:59:00Z'), '2026-06-30');        // EDT
  assert.equal(C.etDate('1790344506514'), C.etDate(1790344506514));   // epoch-ms strings
  assert.equal(C.etDate(''), null); assert.equal(C.etDate(null), null);
});
test('DST transitions 2026 (Mar 8, Nov 1)', () => {
  assert.equal(C.etParts('2026-03-08T06:59:59Z').hh, 1);  // 01:59:59 EST
  assert.equal(C.etParts('2026-03-08T07:00:00Z').hh, 3);  // 03:00 EDT
  assert.equal(C.etParts('2026-11-01T05:59:59Z').hh, 1);  // 01:59:59 EDT
  assert.equal(C.etParts('2026-11-01T06:00:00Z').hh, 1);  // 01:00 EST (repeated hour)
  assert.equal(C.etOffsetMinutes(Date.UTC(2027, 2, 14, 7)), -240);    // 2027 DST starts Mar 14
});
test('etToUtcMs: Friday noon cutoff across DST', () => {
  assert.equal(C.etToUtcMs('2026-10-02', '12:00'), Date.UTC(2026, 9, 2, 16));
  assert.equal(C.etToUtcMs('2026-12-04', '12:00'), Date.UTC(2026, 11, 4, 17));
  assert.equal(C.etToUtcMs('2026-01-01', '00:00'), Date.UTC(2026, 0, 1, 5));
});
test('etIso formats with offset', () => {
  assert.equal(C.etIso(Date.UTC(2026, 9, 2, 14, 41, 7, 312)), '2026-10-02T10:41:07.312-04:00');
  assert.equal(C.etIso(Date.UTC(2026, 11, 4, 17, 0, 0, 0)), '2026-12-04T12:00:00.000-05:00');
});
test('periodFor', () => {
  assert.deepEqual(C.periodFor('2026-09-25'), { fyStart: '2026-01-01', fyEnd: '2026-12-31', start: '2026-09-25', end: '2026-12-31', fiscalYear: 2026 });
});

// ------------------------------------------------------------------ stage map
test('stage map: config IDs agree with pipelines API; renewal ignored', () => {
  assert.ok(SM.ok, SM.errors.join());
  assert.deepEqual(SM.wonIds, HS.wonStageIds);
  assert.ok(!SM.stages['9999']);
  assert.ok(SM.openIds.includes('3753890497') && !SM.openIds.includes('3753890502'));
});
test('stage map: drift and malformed stages stop the pull', () => {
  const d1 = C.buildStageMap(pipelines({ nlWonProb: 0.9 }), HS);
  assert.equal(d1.ok, false); assert.ok(d1.errors.some((e) => /cannot classify/.test(e))); assert.ok(d1.errors.some((e) => /Won stage drift/.test(e)));
  const d2 = C.buildStageMap(pipelines({ dropUpsell: true }), HS);
  assert.equal(d2.ok, false); assert.ok(d2.errors.some((e) => /2313830082 not returned/.test(e)));
});

// ------------------------------------------------------------------ owners / viewer
test('owners: archived → inactive, no userId → no seat, active record wins', () => {
  const o = C.normalizeOwners([{ id: 5, firstName: 'C', lastName: 'S', userId: null, archived: false },
    { id: 6, email: 'X@F.com', userId: 1, archived: true }, { id: 6, email: 'x@f.com', userId: 1, archived: false }]);
  assert.deepEqual([o['5'].isActive, o['5'].hasUserSeat], [true, false]);
  assert.equal(o['6'].isActive, true); assert.equal(o['6'].email, 'x@f.com');
});
test('resolveViewer: roles, case-insensitivity, unknown and blank rejected', () => {
  assert.equal(C.resolveViewer('A.One@Findigs.com', ROSTER).role, 'ae');
  assert.equal(C.resolveViewer('a.one@findigs.com', ROSTER).canViewAll, true);      // full transparency (2026-09-25)
  assert.equal(C.resolveViewer('a.one@findigs.com', ROSTER).canRefresh, false);
  assert.deepEqual(C.submittableSlugs(C.resolveViewer('a.one@findigs.com', ROSTER), ROSTER), ['a-one']);
  assert.deepEqual(C.submittableSlugs(C.resolveViewer('b.two@findigs.com', ROSTER), ROSTER), ['b-two']);   // ae_leader: own only
  assert.deepEqual(C.submittableSlugs(C.resolveViewer('lead@findigs.com', ROSTER), ROSTER), []);
  assert.deepEqual(C.submittableSlugs(C.resolveViewer('adm@findigs.com', ROSTER), ROSTER), ['a-one', 'b-two', 'z-zero']);
  assert.equal(C.resolveViewer('b.two@findigs.com', ROSTER).canViewAll, true);
  assert.equal(C.resolveViewer('b.two@findigs.com', ROSTER).ae.slug, 'b-two');
  assert.equal(C.resolveViewer('lead@findigs.com', ROSTER).role, 'leadership');
  assert.equal(C.resolveViewer('adm@findigs.com', ROSTER).isAdmin, true);
  assert.equal(C.resolveViewer('stranger@findigs.com', ROSTER), null);
  assert.equal(C.resolveViewer('', ROSTER), null);
});
test('real roster: Phil is ae_leader + admin; Brian and Will are admins; leadership list matches decision', () => {
  const r = CFG.roster;
  const phil = C.resolveViewer('phil.aroian@findigs.com', r);
  assert.equal(phil.role, 'ae_leader'); assert.equal(phil.isAdmin, true);
  assert.equal(C.submittableSlugs(phil, r).length, 5);
  assert.equal(C.resolveViewer('brian.korchin@findigs.com', r).role, 'admin');
  assert.equal(C.resolveViewer('ben.dewinter@findigs.com', r).isAdmin, false);
  assert.deepEqual(r.leadership.map((l) => l.email).sort(), ['alexander.schaper@findigs.com', 'asaf.raz@findigs.com']);
  assert.deepEqual(r.admins.map((l) => l.email).sort(), ['brian.korchin@findigs.com', 'will.ritchings@findigs.com']);
  assert.ok(!r.aes.some((a) => a.name === 'Reese Ryan'));
});

// ------------------------------------------------------------------ deals
test('weighting (default, decision 2026-09-25): amount × pipeline stage probability; weighted_amount reference only', () => {
  assert.equal(HS.weightingMethod, 'stage_probability');
  const s1 = C.deriveOpenDeal(deal('1', { weighted_amount: '50' }), ctx());
  assert.deepEqual([s1.weighted, s1.weightedMethod, s1.hubspotWeightedAmount], [100, 'stage', 50]);
  assert.ok(s1.flags.includes('weighted_stored_differs_from_calc'));
  const e = C.deriveOpenDeal(deal('2', { weighted_amount: '' }), ctx());
  assert.deepEqual([e.weighted, e.hubspotWeightedAmount], [100, null]);
  // deal-level probability is ignored for weighting; stage default is used and the deviation flagged
  const dv = C.deriveOpenDeal(deal('3', { dealstage: '3753890498', hs_deal_stage_probability: '0.15', amount: '1000' }), ctx());
  assert.deepEqual([dv.weighted, dv.probability, dv.dealProbability], [200, 0.2, 0.15]);
  assert.ok(dv.flags.includes('prob_deviates_from_stage') && !dv.flags.includes('prob_from_stage'));
  const eq = C.deriveOpenDeal(deal('4', { weighted_amount: '100' }), ctx());
  assert.ok(!eq.flags.includes('weighted_stored_differs_from_calc'));
});
test('weighting (stored_first, gtm-dashboard rule) still available: stored first; "" and null fall back', () => {
  const c2 = { ...ctx(), hs: { ...HS, weightingMethod: 'stored_first' } };
  const s1 = C.deriveOpenDeal(deal('1', { weighted_amount: '50' }), c2);
  assert.deepEqual([s1.weighted, s1.weightedMethod], [50, 'stored']);
  const e = C.deriveOpenDeal(deal('2', { weighted_amount: '' }), c2);
  assert.deepEqual([e.weighted, e.weightedMethod], [100, 'fallback']); assert.ok(e.flags.includes('weighted_fallback'));
  const b = C.deriveOpenDeal(deal('3', { hs_deal_stage_probability: '' }), c2);
  assert.equal(b.probability, 0.1); assert.ok(b.flags.includes('prob_from_stage'));
});
test('missing amount: blank + flag, never imputed', () => {
  const d = C.deriveOpenDeal(deal('1', { amount: '' }), ctx());
  assert.equal(d.amount, null); assert.equal(d.weighted, null); assert.equal(d.weightedMethod, 'none');
  assert.ok(d.flags.includes('missing_amount') && d.flags.includes('weighted_unavailable'));
});
test('missing close date: not in period, flagged, not past due', () => {
  const d = C.deriveOpenDeal(deal('1', { closedate: '' }), ctx());
  assert.equal(d.closeDate, null); assert.equal(d.inPeriod, false);
  assert.ok(d.flags.includes('missing_close_date')); assert.ok(!d.flags.includes('past_due'));
});
test('past due and in-period', () => {
  const p = C.deriveOpenDeal(deal('1', { closedate: '2026-09-24T04:00:00Z' }), ctx());
  assert.ok(p.flags.includes('past_due')); assert.equal(p.inPeriod, true);
  const today = C.deriveOpenDeal(deal('2', { closedate: '2026-09-25T04:00:00Z' }), ctx());
  assert.ok(!today.flags.includes('past_due'));
  const later = C.deriveOpenDeal(deal('3', { closedate: '2027-01-01T05:00:00Z' }), ctx());
  assert.equal(later.inPeriod, false);
  const nye = C.deriveOpenDeal(deal('4', { closedate: '2027-01-01T04:00:00Z' }), ctx());
  assert.equal(nye.closeDate, '2026-12-31'); assert.equal(nye.inPeriod, true);
});
test('classify: renewal + lost excluded, won filtered by ET FY window and as-of, dedupe', () => {
  const raw = [
    deal('o1', {}), deal('o1', {}),
    deal('r1', { pipeline: REN, dealstage: '9999' }),
    deal('l1', { dealstage: '3753890503' }),
    deal('w1', { dealstage: '3753890502', closedate: '2026-03-01T05:00:00Z' }),
    deal('w2', { dealstage: '3753890502', closedate: '2025-12-31T05:00:00Z' }),   // FY2025 in ET
    deal('w3', { dealstage: '3753890502', closedate: '2026-01-01T05:00:00Z' }),   // FY2026 00:00 ET
    deal('w4', { dealstage: '3752297196', pipeline: UP, closedate: '2026-09-26T04:00:00Z' })  // after as-of
  ];
  const c = C.classifyDeals(raw, ctx());
  assert.deepEqual(c.open.map((d) => d.id), ['o1']);
  assert.deepEqual(c.wonYtd.map((d) => d.id).sort(), ['w1', 'w3']);
  assert.equal(c.outOfScope, 1);
});

// ------------------------------------------------------------------ aggregation
function metrics(openRaw, wonRaw, owners = OWNERS) {
  return C.computeMetrics({ openRaw, wonRaw, stageMap: SM, owners, roster: ROSTER, hs: HS, portalId: CFG.portalId, asOf: '2026-09-25' });
}
test('computeMetrics: rows, zero-pipeline AE, non-roster, unassigned, totals tie', () => {
  const m = metrics(
    [deal('1', { weighted_amount: '100' }), deal('2', { hubspot_owner_id: '2', amount: '' }), deal('3', { hubspot_owner_id: '9', closedate: '2026-09-01T04:00:00Z' }),
     deal('4', { hubspot_owner_id: '' }), deal('5', { hubspot_owner_id: '1', closedate: '2027-03-01T05:00:00Z' })],
    [deal('w1', { dealstage: '3753890502', closedate: '2026-02-01T05:00:00Z', amount: '500' }),
     deal('w2', { dealstage: '3753890502', closedate: '2026-02-01T05:00:00Z', amount: '700', hubspot_owner_id: '9' })]);
  const a = m.rows.find((r) => r.key === 'a-one').metrics, b = m.rows.find((r) => r.key === 'b-two').metrics, z = m.rows.find((r) => r.key === 'z-zero').metrics;
  assert.deepEqual([a.grossOpen.amount, a.grossOpen.count, a.grossOpenInPeriod.count, a.closedWonYtd.amount], [2000, 2, 1, 500]);
  assert.deepEqual([a.weightedOpen.stageCount, a.weightedOpen.amount, a.weightedOpen.hubspotStoredCount, a.weightedOpen.hubspotStoredAmount], [2, 200, 1, 100]);
  assert.deepEqual([b.grossOpen.amount, b.grossOpen.count, b.grossOpen.nullAmountCount, b.weightedOpen.unavailableCount], [0, 1, 1, 1]);
  assert.deepEqual([z.grossOpen.count, z.closedWonYtd.count, z.weightedOpen.amount], [0, 0, 0]);            // zero-pipeline AE still has a row
  assert.equal(m.team.grossOpen.amount, 2000); assert.equal(m.team.closedWonYtd.amount, 500);
  assert.deepEqual(m.nonRoster.owners.map((o) => [o.name, o.ownerStatus]), [['Unassigned (no owner)', 'unassigned'], ['Gone Person', 'no_user_seat']]);
  assert.equal(m.company.grossOpen.amount, m.team.grossOpen.amount + m.nonRoster.total.grossOpen.amount);
  assert.equal(m.company.closedWonYtd.amount, 1200);
  const codes = m.flags.map((f) => f.code);
  for (const c of ['NON_ROSTER_OPEN_DEALS', 'NON_ACTIVE_OWNER_WON_YTD', 'MISSING_AMOUNT', 'PAST_DUE', 'WEIGHTED_UNAVAILABLE']) assert.ok(codes.includes(c), c);
  assert.equal(m.flags.find((f) => f.code === 'NON_ROSTER_OPEN_DEALS' && f.ownerId === '9').severity, 'high');
});
test('computeMetrics: roster owner inactive / unknown / seatless flagged high', () => {
  const owners = C.normalizeOwners([{ id: '1', userId: 1, archived: true }, { id: '2', userId: null, archived: false }]);
  const m = metrics([], [], owners);
  const f = Object.fromEntries(m.flags.map((x) => [x.code + ':' + x.ownerId, x.severity]));
  assert.equal(f['ROSTER_OWNER_INACTIVE:1'], 'high'); assert.equal(f['ROSTER_OWNER_NO_SEAT:2'], 'high'); assert.equal(f['ROSTER_OWNER_UNKNOWN:3'], 'high');
  assert.deepEqual(m.rows.map((r) => r.ownerStatus), ['inactive', 'no_user_seat', 'unknown']);
});

// ------------------------------------------------------------------ tie-out
test('tieOut: tolerance, counts, one-sided owners', () => {
  const s = (a, n, oa, on) => ({ company: { cwYtd: { amount: a, count: n }, grossOpen: { amount: 0, count: 0 } },
                                  byOwner: oa === undefined ? {} : { '1': { cwYtd: { amount: oa, count: on }, grossOpen: { amount: 0, count: 0 } } } });
  assert.equal(C.tieOut(s(100, 1, 100, 1), s(100.004, 1, 100.004, 1), 0.01).ok, true);
  assert.equal(C.tieOut(s(100, 1, 100, 1), s(100.02, 1, 100.02, 1), 0.01).ok, false);
  assert.equal(C.tieOut(s(100, 1, 100, 1), s(100, 2, 100, 2), 0.01).ok, false);
  const one = C.tieOut(s(100, 1, 100, 1), s(100, 1), 0.01);
  assert.equal(one.ok, false); assert.ok(one.mismatches.every((r) => r.scope === '1'));
});
test('diffDealSets names the records behind a miss', () => {
  const d = C.diffDealSets([{ id: 'a', amount: 1 }, { id: 'b', amount: 2 }], [{ id: 'b', amount: 3 }, { id: 'c', amount: 1 }]);
  assert.deepEqual([d.onlyPrimary.map((x) => x.id), d.onlyIndependent.map((x) => x.id), d.amountDiffers], [['a'], ['c'], ['b']]);
});

// ------------------------------------------------------------------ config guards
test('config: reuses gtm-dashboard definitions, excludes renewal, never pulls forbidden fields', () => {
  assert.deepEqual(HS.inScopePipelineIds, [NL, UP]); assert.deepEqual(HS.excludedPipelineIds, [REN]);
  assert.deepEqual(HS.wonStageIds, ['3753890502', '3752297196']); assert.deepEqual(HS.lostStageIds, ['3753890503', '3752297197']);
  assert.equal(HS.fields.bookings_amount, 'amount'); assert.equal(HS.tieOutToleranceUsd, 0.01);
  for (const f of ['hs_acv', 'acv__c', 'acv', 'hs_forecast_amount', 'hs_is_closed_won', 'hs_is_closed_lost']) assert.ok(!HS.pullProperties.includes(f), f);
  assert.equal(CFG.forecast.definitions.commit.confidence, 'High confidence');
  assert.equal(CFG.forecast.cutoff.late_rule, 'next_week');
  assert.equal(CFG.roster.admins[0].email, 'will.ritchings@findigs.com');
  assert.deepEqual(CFG.forecast.cutoff.holiday_overrides, {});
});
