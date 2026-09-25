/**
 * Loads the real Apps Script project (every .gs file) into a Node vm with in-memory stand-ins for
 * UrlFetchApp (fake HubSpot serving the 2026-09-25 live pulls), Session, LockService, PropertiesService,
 * HtmlService, and the Drive/Sheets storage layer. Used by API tests, the UI test, and the local preview.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GAS = join(ROOT, 'appsscript');
const V = join(ROOT, 'verification', '2026-09-25');
const J = (f) => JSON.parse(readFileSync(join(V, f), 'utf8'));
export const FIXTURE = { open: J('deals_open_raw.json').results, won: J('deals_won_raw.json').results,
  pipelines: J('pipelines_observed.json'), owners: J('owners.json').results };

export function fakeHubSpot({ page = 200, fail429 = 0, dropFromList = null, openOverride = null } = {}) {
  const calls = [];
  let throttle = fail429;
  const res = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
  const pageOf = (all, after, size) => {
    const start = after ? Number(after) : 0;
    return { results: all.slice(start, start + size), total: all.length,
             paging: start + size < all.length ? { next: { after: String(start + size) } } : undefined };
  };
  const hub = {
    calls,
    open: openOverride || FIXTURE.open,
    fetch(url, opts) {
      calls.push({ url, method: opts.method });
      if (throttle > 0) { throttle--; return res(429, { message: 'rate limited' }); }
      const u = new URL(url), path = u.pathname;
      if (path === '/crm/v3/pipelines/deals') return res(200, FIXTURE.pipelines);
      if (path === '/crm/v3/owners') return res(200, { results: FIXTURE.owners.filter((o) => o.archived === (u.searchParams.get('archived') === 'true')) });
      if (path === '/crm/v3/objects/deals/search') {
        const b = JSON.parse(opts.payload), f = b.filterGroups[0].filters, stage = f.find((x) => x.propertyName === 'dealstage');
        let set;
        if (stage.operator === 'NOT_IN') set = hub.open;
        else { const cd = f.find((x) => x.propertyName === 'closedate');
               set = FIXTURE.won.filter((d) => { const ms = Date.parse(d.properties.closedate); return ms >= Number(cd.value) && ms <= Number(cd.highValue); }); }
        return res(200, pageOf(set, b.after, Math.min(page, b.limit)));
      }
      if (path === '/crm/v3/objects/deals') {
        let all = [...hub.open, ...FIXTURE.won];
        if (dropFromList) all = all.filter((d) => String(d.id) !== dropFromList);
        const p = pageOf(all, u.searchParams.get('after'), Number(u.searchParams.get('limit'))); delete p.total;
        return res(200, p);
      }
      return res(404, { message: 'no route ' + path });
    }
  };
  return hub;
}

/** Minimal Sheet: getDataRange().getValues(), getRange(r,c,nr,nc).setValues(), appendRow, getLastRow. */
export class FakeSheet {
  constructor(name, header) { this.name = name; this.rows = header ? [header.slice()] : []; }
  getLastRow() { return this.rows.length; }
  appendRow(r) { this.rows.push(r.map(clean)); }
  getDataRange() { const rows = this.rows; return { getValues: () => rows.map((r) => r.slice()) }; }
  getRange(r, c, nr = 1, nc = 1) {
    const self = this;
    return { setValues(vals) {
      if (vals.length !== nr || vals.some((v) => v.length !== nc)) throw new Error('setValues dimension mismatch');
      for (let i = 0; i < nr; i++) { const row = self.rows[r - 1 + i] || (self.rows[r - 1 + i] = []);
        for (let j = 0; j < nc; j++) row[c - 1 + j] = clean(vals[i][j]); }
    } };
  }
}
const clean = (v) => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);   // Sheets strips the text-forcing apostrophe

export function loadApp({ email = 'will.ritchings@findigs.com', hub = fakeHubSpot(), token = 'test-token', asOf = '2026-09-25', lockBusy = false } = {}) {
  const store = { build: [], cache: null, sheets: {} };
  const session = { email };
  const ctx = {
    console, JSON, Math, Date, Object, Array, String, Number, Error, encodeURIComponent, RegExp,
    UrlFetchApp: { fetch: (u, o) => hub.fetch(u, o) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'HUBSPOT_TOKEN' ? token : null), setProperty() {} }) },
    Utilities: { sleep() {}, DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_a, s) => [...createHash('sha256').update(s).digest()].map((b) => (b > 127 ? b - 256 : b)) },
    Session: { getActiveUser: () => ({ getEmail: () => session.email }) },
    LockService: { getScriptLock: () => ({ tryLock: () => !lockBusy, waitLock() {}, releaseLock() {} }) },
    Logger: { log() {} },
    HtmlService: {
      XFrameOptionsMode: { DEFAULT: 'DEFAULT' },
      createHtmlOutput: (html) => htmlOut(html),
      createHtmlOutputFromFile: (name) => htmlOut(readFileSync(join(GAS, name + '.html'), 'utf8')),
      createTemplateFromFile: (name) => ({ evaluate: () => htmlOut(renderTemplate(readFileSync(join(GAS, name + '.html'), 'utf8'), ctx)) })
    }
  };
  vm.createContext(ctx);
  const files = readdirSync(GAS).filter((f) => f.endsWith('.gs')).sort((a, b) => (a.startsWith('Generated') ? -1 : b.startsWith('Generated') ? 1 : a < b ? -1 : 1));
  for (const f of files) vm.runInContext(readFileSync(join(GAS, f), 'utf8'), ctx, { filename: f });

  // Storage layer → memory
  const tabs = vm.runInContext('ROLLUP_TABS_', ctx);
  for (const [t, h] of Object.entries(tabs)) store.sheets[t] = new FakeSheet(t, h);
  ctx.getRollup_ = () => ({ getSheetByName: (n) => store.sheets[n] || null });
  ctx.writeDataCache_ = (d) => { d._writtenMs = Date.now(); store.cache = JSON.parse(JSON.stringify(d)); };
  ctx.readDataCache_ = () => (store.cache ? JSON.parse(JSON.stringify(store.cache)) : null);
  ctx.appendBuildLog_ = (e) => store.build.push(e);
  ctx.todayEt_ = () => asOf;
  const origPull = ctx.pullData_;
  ctx.pullData_ = (opts) => origPull(Object.assign({ asOf }, opts || {}));

  /** Call a server function the way google.script.run would: JSON in, JSON out. */
  const call = (fn, ...args) => JSON.parse(JSON.stringify(ctx[fn](...JSON.parse(JSON.stringify(args)))));
  return { ctx, store, session, hub, call };
}

function htmlOut(html) {
  const o = { content: html, getContent: () => o.content, setTitle: () => o, addMetaTag: () => o, setXFrameOptionsMode: () => o };
  return o;
}
/** Supports the only scriptlet the project uses: <?!= include('Name') ?> (recursively). */
export function renderTemplate(src, ctx) {
  return src.replace(/<\?!=\s*include\('([A-Za-z0-9_]+)'\)\s*\?>/g, (_, n) => renderTemplate(ctx.include(n), ctx));
}
