/**
 * Runs the real Apps Script files (Generated_Config.gs, Generated_Core.gs, HubSpot.gs, Data.gs, Main.gs)
 * in a Node vm with stubbed Google services and a fake HubSpot that serves the 2026-09-25 live pulls.
 * Verifies orchestration, pagination, read-only guard, retry, and the runtime (Search vs Objects list) tie-out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V = join(ROOT, 'verification', '2026-09-25');
const J = (f) => JSON.parse(readFileSync(join(V, f), 'utf8'));
const OPEN = J('deals_open_raw.json').results, WON = J('deals_won_raw.json').results;
const PIPES = J('pipelines_observed.json'), OWNERS = J('owners.json').results;
// Extra records only the objects-list path sees: must be ignored by classification.
const EXTRA = [
  { id: '1', properties: { pipeline: '2559714036', dealstage: 'x', amount: '999999', hubspot_owner_id: '1053057926', closedate: '2026-05-01T04:00:00Z' } },
  { id: '2', properties: { pipeline: '2313721535', dealstage: '3753890503', amount: '555', hubspot_owner_id: '26451111', closedate: '2026-05-01T04:00:00Z' } }
];

function fakeHubSpot({ page = 50, fail429 = 0, dropFromList = null } = {}) {
  const calls = [];
  let throttle = fail429;
  const res = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
  function pageOf(all, after, size) {
    const start = after ? Number(after) : 0, slice = all.slice(start, start + size);
    return { results: slice, total: all.length, paging: start + size < all.length ? { next: { after: String(start + size) } } : undefined };
  }
  return {
    calls,
    fetch(url, opts) {
      calls.push({ url, method: opts.method });
      assert.match(opts.headers.Authorization, /^Bearer test-token$/);
      if (throttle > 0) { throttle--; return res(429, { message: 'rate limited' }); }
      const u = new URL(url), path = u.pathname;
      if (path === '/crm/v3/pipelines/deals') return res(200, PIPES);
      if (path === '/crm/v3/owners') {
        const arch = u.searchParams.get('archived') === 'true';
        return res(200, { results: OWNERS.filter((o) => o.archived === arch) });
      }
      if (path === '/crm/v3/objects/deals/search') {
        const b = JSON.parse(opts.payload);
        const f = b.filterGroups[0].filters, stage = f.find((x) => x.propertyName === 'dealstage');
        let set;
        if (stage.operator === 'NOT_IN') set = OPEN;
        else {
          const cd = f.find((x) => x.propertyName === 'closedate');
          set = WON.filter((d) => { const ms = Date.parse(d.properties.closedate); return ms >= Number(cd.value) && ms <= Number(cd.highValue); });
        }
        return res(200, pageOf(set, b.after, Math.min(page, b.limit)));
      }
      if (path === '/crm/v3/objects/deals') {
        let all = [...OPEN, ...WON, ...EXTRA];
        if (dropFromList) all = all.filter((d) => String(d.id) !== dropFromList);
        const p = pageOf(all, u.searchParams.get('after'), Number(u.searchParams.get('limit')));
        delete p.total;
        return res(200, p);
      }
      return res(404, { message: 'no route ' + path });
    }
  };
}

function loadApp(hub, { email = 'will.ritchings@findigs.com', token = 'test-token' } = {}) {
  const logs = { build: [], cache: [] };
  const ctx = {
    console, JSON, Math, Date, Object, Array, String, Number, Error, encodeURIComponent,
    UrlFetchApp: { fetch: (u, o) => hub.fetch(u, o) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'HUBSPOT_TOKEN' ? token : null) }) },
    Utilities: {
      sleep: () => {}, DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_a, s) => [...require_crypto().createHash('sha256').update(s).digest()].map((b) => (b > 127 ? b - 256 : b))
    },
    Session: { getActiveUser: () => ({ getEmail: () => email }) },
    Logger: { log: () => {} }
  };
  vm.createContext(ctx);
  for (const f of ['Generated_Config.gs', 'Generated_Core.gs', 'HubSpot.gs', 'Data.gs', 'Main.gs']) {
    vm.runInContext(readFileSync(join(ROOT, 'appsscript', f), 'utf8'), ctx, { filename: f });
  }
  ctx.appendBuildLog_ = (e) => logs.build.push(e);
  ctx.writeDataCache_ = (d) => logs.cache.push(d);
  ctx.readDataCache_ = () => logs.cache[logs.cache.length - 1] || null;
  ctx.todayEt_ = () => '2026-09-25';
  return { ctx, logs };
}
import { createRequire } from 'node:module';
const require_crypto = () => createRequire(import.meta.url)('node:crypto');

test('pullData_: live fixture reconciles on the runtime tie-out path; totals match reporting API', () => {
  const hub = fakeHubSpot();
  const { ctx, logs } = loadApp(hub);
  const ds = ctx.pullData_({ asOf: '2026-09-25' });
  assert.equal(ds.tieOut.ok, true, JSON.stringify(ds.tieOut.mismatches));
  assert.equal(ds.metrics.company.closedWonYtd.amount, 7571305.12);
  assert.equal(ds.metrics.company.closedWonYtd.count, 73);
  assert.equal(ds.metrics.company.grossOpen.amount, 69616046.13);
  assert.equal(ds.metrics.company.grossOpen.count, 107);
  assert.equal(ds.metrics.company.weightedOpen.fallbackCount, 58);
  assert.equal(logs.build.at(-1).status, 'OK');
  assert.equal(logs.cache.length, 1);
  assert.ok(hub.calls.some((c) => c.url.includes('/crm/v3/objects/deals?')), 'independent list path used');
  assert.ok(hub.calls.every((c) => c.method === 'get' || c.url.endsWith('/search')), 'read-only calls only');
});

test('runtime tie-out mismatch is surfaced (build log + deal-level diff), not hidden', () => {
  const { ctx, logs } = loadApp(fakeHubSpot({ dropFromList: '315306386143' }));  // Highmark missing from primary store view
  const ds = ctx.pullData_({ asOf: '2026-09-25' });
  assert.equal(ds.tieOut.ok, false);
  assert.ok(ds.tieOut.mismatches.some((r) => r.scope === 'Company' && r.measure === 'Closed Won YTD' && r.deltaAmount === 3660589.8));
  assert.deepEqual(ds.tieOut.wonDiff.onlyPrimary.map((d) => d.id), ['315306386143']);
  assert.equal(logs.build.at(-1).status, 'TIE-OUT MISMATCH');
});

test('hsRequest_: blocks writes; retries 429 with backoff', () => {
  const hub = fakeHubSpot({ fail429: 2 });
  const { ctx } = loadApp(hub);
  for (const [m, p] of [['patch', '/crm/v3/objects/deals/1'], ['post', '/crm/v3/objects/deals'], ['delete', '/crm/v3/objects/deals/1'],
                        ['post', '/crm/v3/objects/deals/batch/update']]) {
    assert.throws(() => ctx.hsRequest_(m, p, {}), /Blocked non-read HubSpot call/);
  }
  assert.equal(hub.calls.length, 0);
  const r = ctx.hsRequest_('get', '/crm/v3/pipelines/deals');
  assert.equal(r.results.length, 2); assert.equal(hub.calls.length, 3);
});

test('hsSearchDeals_: paginates and asserts count == total', () => {
  const hub = fakeHubSpot({ page: 25 });
  const { ctx } = loadApp(hub);
  const r = ctx.hsSearchDeals_(ctx.hsOpenFilter_(ctx.FORECAST_CONFIG.hubspot), ['dealname']);
  assert.equal(r.results.length, 107);
  assert.equal(hub.calls.filter((c) => c.url.endsWith('/search')).length, 5);
});

test('missing token fails loudly', () => {
  const { ctx } = loadApp(fakeHubSpot(), { token: null });
  assert.throws(() => ctx.hsGetPipelines_(), /HUBSPOT_TOKEN is not set/);
});

test('apiGetData: AE sees only own row and own flags; leadership sees all; stranger denied', () => {
  const hub = fakeHubSpot();
  let app = loadApp(hub, { email: 'ben.dewinter@findigs.com' });
  app.ctx.pullData_({ asOf: '2026-09-25' });
  const ae = app.ctx.apiGetData(false);
  assert.deepEqual(ae.rows.map((r) => r.key), ['ben-de-winter']);
  assert.equal(ae.team, null); assert.equal(ae.nonRoster, null);
  assert.ok(ae.flags.every((f) => f.ownerId === '2111244871'));

  app = loadApp(hub, { email: 'brian.korchin@findigs.com' });
  app.ctx.pullData_({ asOf: '2026-09-25' });
  const lead = app.ctx.apiGetData(false);
  assert.equal(lead.rows.length, 5); assert.equal(lead.company.grossOpen.count, 107);

  app = loadApp(hub, { email: 'phil.aroian@findigs.com' });
  app.ctx.pullData_({ asOf: '2026-09-25' });
  assert.equal(app.ctx.apiGetData(false).rows.length, 5);   // ae_leader sees all rows

  app = loadApp(hub, { email: 'reese.ryan@findigs.com' });
  assert.throws(() => app.ctx.apiGetData(false), /Access denied/);
  app = loadApp(hub, { email: '' });
  assert.throws(() => app.ctx.apiGetData(false), /could not determine your Google account/);
});
