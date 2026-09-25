import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadApp, fakeHubSpot, FIXTURE } from './helpers/gas_harness.mjs';

const C = createRequire(import.meta.url)('../core/forecast_core.js');
const END = '2026-12-31';
const D = (id, amount, closeDate, extra = {}) => ({ id, name: 'Deal ' + id, amount, closeDate, units: 10, stage: 'Intro & Challenge', stageOrder: 0, pipeline: 'New Logo', flags: [], ...extra });
const T = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { tag: v }]));

// ------------------------------------------------------------------ core: summary / nesting
test('builderSummary: cumulative totals honor the nesting rule; tagged-only subtotals incl. Lost and None', () => {
  const deals = [D('a', 100, '2026-10-01'), D('b', 200, '2026-11-01'), D('c', 400, '2026-12-01'), D('d', 800, '2026-10-15'), D('e', 1600, '2026-10-20'), D('f', 3200, '2026-10-21')];
  const s = C.builderSummary(deals, T({ a: 'commit', b: 'gut', c: 'best_case', d: 'lost', e: 'none' }), END);   // f untagged → none
  assert.deepEqual(s.cumulative, { commit: { amount: 100, count: 1 }, gut: { amount: 300, count: 2 }, best_case: { amount: 700, count: 3 } });
  assert.deepEqual([s.byTag.commit.amount, s.byTag.gut.amount, s.byTag.best_case.amount, s.byTag.lost.amount, s.byTag.none.amount], [100, 200, 400, 800, 4800]);
  assert.deepEqual([s.byTag.lost.count, s.byTag.none.count], [1, 2]);
  assert.ok(s.cumulative.commit.amount <= s.cumulative.gut.amount && s.cumulative.gut.amount <= s.cumulative.best_case.amount);
});
test('builderSummary: missing amount counted but $0 and listed; out-of-period and missing-close tagged deals listed', () => {
  const deals = [D('a', null, '2026-10-01'), D('b', 50, '2027-02-01'), D('c', 25, null), D('d', null, '2027-03-01')];
  const s = C.builderSummary(deals, T({ a: 'commit', b: 'gut', c: 'best_case', d: 'lost' }), END);
  assert.deepEqual(s.cumulative.commit, { amount: 0, count: 1 });
  assert.equal(s.byTag.commit.nullAmountCount, 1);
  assert.deepEqual(s.warnings.missingAmountTagged, ['a']);           // Lost deal d not warned
  assert.deepEqual(s.warnings.outOfPeriodTagged, ['b']);
  assert.deepEqual(s.warnings.missingCloseDateTagged, ['c']);
  assert.equal(s.cumulative.best_case.amount, 75);
});
test('builderSummary: totals ignore the table filter (computed over all open deals)', () => {
  const deals = [D('a', 100, '2026-10-01'), D('b', 900, '2027-06-01')];
  const tags = T({ a: 'commit', b: 'commit' });
  assert.equal(C.builderSummary(deals, tags, END).cumulative.commit.amount, 1000);
  assert.equal(C.builderFilter(deals, false, END).length, 1);
});
test('builderSummary: no tags → everything None, zero forecast', () => {
  const s = C.builderSummary([D('a', 5, '2026-10-01')], {}, END);
  assert.deepEqual([s.cumulative.best_case.amount, s.byTag.none.count], [0, 1]);
  assert.deepEqual(C.builderSummary([], {}, END).cumulative.commit, { amount: 0, count: 0 });
});

// ------------------------------------------------------------------ core: filter / sort / stale / validation
test('builderFilter: default ≤ period end incl. past due; missing close date always shown; toggle shows all', () => {
  const deals = [D('past', 1, '2026-01-05'), D('in', 1, '2026-12-31'), D('out', 1, '2027-01-01'), D('none', 1, null)];
  assert.deepEqual(C.builderFilter(deals, false, END).map((d) => d.id), ['past', 'in', 'none']);
  assert.equal(C.builderFilter(deals, true, END).length, 4);
});
test('sortDeals: every column, both directions, blanks last', () => {
  const deals = [D('1', 300, '2026-11-01', { name: 'bravo', units: 5, stageOrder: 2 }), D('2', null, null, { name: 'alpha', units: null, stageOrder: 0 }),
                 D('3', 100, '2026-10-01', { name: 'charlie', units: 50, stageOrder: 1 })];
  const ids = (k, dir, tags) => C.sortDeals(deals, k, dir, tags).map((d) => d.id).join('');
  assert.equal(ids('amount', 'asc'), '312'); assert.equal(ids('amount', 'desc'), '132');
  assert.equal(ids('closeDate', 'asc'), '312'); assert.equal(ids('closeDate', 'desc'), '132');
  assert.equal(ids('units', 'desc'), '312');
  assert.equal(ids('name', 'asc'), '213'); assert.equal(ids('name', 'desc'), '312');
  assert.equal(ids('stage', 'asc'), '231');
  assert.equal(ids('tag', 'asc', T({ 1: 'lost', 3: 'commit' })), '312');   // commit < lost < none
  assert.equal(ids('bogus', 'asc'), ids('closeDate', 'asc'));
});
test('validateTagChanges: rejects unknown deals and tags; last change per deal wins', () => {
  const ok = C.validateTagChanges([{ dealId: 'a', tag: 'Gut' }, { dealId: 'a', tag: 'commit' }, { dealId: 'b', tag: 'none' }], ['a', 'b']);
  assert.equal(ok.ok, true); assert.deepEqual(ok.clean, [{ dealId: 'a', tag: 'commit' }, { dealId: 'b', tag: 'none' }]);
  const bad = C.validateTagChanges([{ dealId: 'zzz', tag: 'commit' }, { dealId: 'a', tag: 'maybe' }], ['a']);
  assert.equal(bad.ok, false); assert.equal(bad.errors.length, 2);
  assert.equal(C.validateTagChanges('nope', ['a']).ok, false);
});

// ------------------------------------------------------------------ API (real .gs code in the harness)
function appAs(email, opts) { const app = loadApp({ email, ...opts }); app.ctx.pullData_(); return app; }
const BEN = 'ben.dewinter@findigs.com';

test('apiGetBuilder: AE gets own deals, editable; defaults to self; can view another AE read-only', () => {
  const { call } = appAs(BEN);
  const b = call('apiGetBuilder', null);
  assert.equal(b.ae.slug, 'ben-de-winter'); assert.equal(b.readOnly, false);
  assert.equal(b.deals.length, 12); assert.equal(b.aes.length, 5);
  assert.equal(b.tagsSavedAt, null);
  const other = call('apiGetBuilder', 'phil-aroian');
  assert.equal(other.readOnly, true); assert.equal(other.deals.length, 32);
  assert.throws(() => call('apiSaveTags', 'phil-aroian', [{ dealId: other.deals[0].id, tag: 'commit' }]), /only edit your own/);
});
test('apiGetBuilder: leadership and ae_leader view any AE read-only; Phil edits only his own', () => {
  const lead = appAs('asaf.raz@findigs.com');
  const b = lead.call('apiGetBuilder', 'matt-lynch');
  assert.equal(b.readOnly, true); assert.equal(b.deals.length, 21); assert.equal(b.aes.length, 5);
  assert.equal(lead.call('apiGetBuilder', null).ae.slug, 'ben-de-winter');   // alphabetical default for non-AE leadership
  const phil = appAs('phil.aroian@findigs.com');
  assert.equal(phil.call('apiGetBuilder', null).readOnly, false);
  assert.equal(phil.call('apiGetBuilder', 'ian-mclaughlin').readOnly, true);
  assert.throws(() => phil.call('apiSaveTags', 'ian-mclaughlin', [{ dealId: 'x', tag: 'commit' }]), /only edit your own/);
  assert.throws(() => lead.call('apiSaveTags', 'matt-lynch', []), /only edit your own/);
});
test('apiSaveTags: persists across sessions, updates in place, rejects foreign deals, never calls HubSpot writes', () => {
  const app = appAs(BEN);
  const ids = app.call('apiGetBuilder', null).deals.map((d) => d.id);
  const r1 = app.call('apiSaveTags', 'ben-de-winter', [{ dealId: ids[0], tag: 'commit' }, { dealId: ids[1], tag: 'gut' }]);
  assert.equal(r1.tags[ids[0]].tag, 'commit'); assert.ok(r1.savedAt.endsWith('-04:00'));
  app.call('apiSaveTags', 'ben-de-winter', [{ dealId: ids[0], tag: 'best_case' }]);
  const rows = app.store.sheets.builder_state.rows.slice(1);
  assert.equal(rows.length, 2, 'updated in place, not duplicated');
  assert.equal(rows.find((r) => r[1] === ids[0])[2], 'best_case');
  assert.equal(typeof rows[0][1], 'string');
  // "new session": same store, fresh read
  const again = app.call('apiGetBuilder', null);
  assert.deepEqual([again.tags[ids[0]].tag, again.tags[ids[1]].tag], ['best_case', 'gut']);
  assert.ok(again.tagsSavedAt);
  // a Phil deal ID is not Ben's
  const philDeal = FIXTURE.open.find((d) => d.properties.hubspot_owner_id === '1053057926').id;
  assert.throws(() => app.call('apiSaveTags', 'ben-de-winter', [{ dealId: String(philDeal), tag: 'commit' }]), /not one of this AE's open deals/);
  assert.ok(app.hub.calls.every((c) => c.method === 'get' || c.url.endsWith('/search')));
});
test('apiSaveTags: AE tags are isolated per AE (Phil and Ben in the same sheet)', () => {
  const app = appAs(BEN);
  const benId = app.call('apiGetBuilder', null).deals[0].id;
  app.call('apiSaveTags', 'ben-de-winter', [{ dealId: benId, tag: 'commit' }]);
  app.session.email = 'phil.aroian@findigs.com';
  const phil = app.call('apiGetBuilder', null);
  assert.equal(Object.keys(phil.tags).length, 0);
  app.call('apiSaveTags', 'phil-aroian', [{ dealId: phil.deals[0].id, tag: 'gut' }]);
  app.session.email = BEN;
  assert.deepEqual(Object.keys(app.call('apiGetBuilder', null).tags), [benId]);
});
test('apiSaveTags: lock contention returns a clear error (tags kept client-side)', () => {
  const app = appAs(BEN);
  const id = app.call('apiGetBuilder', null).deals[0].id;
  app.store.lockBusy = true;
  assert.throws(() => app.call('apiSaveTags', 'ben-de-winter', [{ dealId: id, tag: 'commit' }]), /Another save is in progress/);
});
test('open deals only: a tagged deal that leaves the open pipeline drops out of the builder and totals, with no note', () => {
  const hub = fakeHubSpot();
  const app = appAs(BEN, { hub });
  const b = app.call('apiGetBuilder', null), gone = b.deals[0].id, kept = b.deals[1].id;
  app.call('apiSaveTags', 'ben-de-winter', [{ dealId: gone, tag: 'commit' }, { dealId: kept, tag: 'gut' }]);
  hub.open = hub.open.filter((d) => String(d.id) !== gone);    // e.g. closed won since tagging
  app.ctx.pullData_();
  const after = app.call('apiGetBuilder', null);
  assert.equal(after.deals.length, 11);
  assert.ok(!after.deals.some((d) => d.id === gone));
  assert.equal(after.staleTags, undefined);
  const s = C.builderSummary(after.deals, after.tags, after.period.end);
  assert.deepEqual([s.cumulative.commit.count, s.cumulative.gut.count], [0, 1]);
  // the closed deal can no longer be tagged either
  assert.throws(() => app.call('apiSaveTags', 'ben-de-winter', [{ dealId: gone, tag: 'gut' }]), /not one of this AE's open deals/);
});
test('missing close date: the rep can tag it into the forecast and it counts', () => {
  const deals = [D('x', 500, null), D('y', 100, '2026-10-01')];
  assert.equal(C.builderFilter(deals, false, END).length, 2);
  const s = C.builderSummary(deals, T({ x: 'commit' }), END);
  assert.deepEqual(s.cumulative.commit, { amount: 500, count: 1 });
  assert.deepEqual(s.warnings.missingCloseDateTagged, ['x']);
});
test('zero-pipeline AE gets an empty builder, not an error', () => {
  const hub = fakeHubSpot();
  hub.open = hub.open.filter((d) => d.properties.hubspot_owner_id !== '167857460');
  const app = appAs('spencer.wuthrich@findigs.com', { hub });
  const b = app.call('apiGetBuilder', null);
  assert.equal(b.deals.length, 0);
  assert.deepEqual(C.builderSummary(b.deals, b.tags, b.period.end).cumulative.best_case, { amount: 0, count: 0 });
});

test('concurrent first loads create each folder and cache file once (re-check under the lock)', () => {
  // Simulate a second execution creating the folder between our fast-path miss and our lock.
  const app = loadApp({ email: BEN, testFolderId: 'ROOT' });
  const root = app.store.drive.folder('ROOT');
  const orig = root.getFoldersByName; let calls = 0;
  root.getFoldersByName = (n) => { calls++; if (calls === 1) { const miss = orig('__none__'); root.createFolder(n); return miss; } return orig(n); };
  app.ctx.pullData_();
  root.getFoldersByName = orig;
  const fy = app.store.drive.folders['ROOT'].subfolders;
  const made = (n) => Object.values(app.store.drive.folders).filter((f) => f.name === n).length;
  assert.equal(made('FY2026'), 1, 'FY2026 created exactly once');
  assert.equal(made('_system'), 1, '_system created exactly once');
  const sysId = app.store.drive.folders[fy.FY2026].subfolders._system;
  const caches = app.store.drive.folders[sysId].fileIds.filter((id) => app.store.drive.files[id].name === 'data_cache.json');
  assert.equal(caches.length, 1);
  app.ctx.pullData_();   // second pull updates the same cache file
  assert.equal(app.store.drive.folders[sysId].fileIds.length, 1);
  assert.equal(app.store.drive.files[caches[0]].writes, 2);
});
test('withScriptLock_ is re-entrant within one execution', () => {
  const app = loadApp({ email: BEN });
  assert.equal(app.ctx.withScriptLock_(() => app.ctx.withScriptLock_(() => 42, 'x'), 'y'), 42);
  app.store.lockBusy = true;
  assert.throws(() => app.ctx.withScriptLock_(() => 1, 'busy!'), /busy!/);
  assert.equal(app.ctx.withScriptLock_(() => 1, null), undefined);
});
