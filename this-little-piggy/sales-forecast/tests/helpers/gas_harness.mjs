/**
 * Loads the real Apps Script project (every .gs file) into a Node vm with in-memory stand-ins for
 * UrlFetchApp (fake HubSpot serving the 2026-09-25 live pulls), Session, LockService, PropertiesService,
 * HtmlService, and the Drive/Sheets storage layer. Used by API tests, the UI test, and the local preview.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
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
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getName() { return this.name; }
  appendRow(r) { this.rows.push(r.map(clean)); }
  getDataRange() { const rows = this.rows; return { getValues: () => rows.map((r) => r.slice()) }; }
  getRange(r, c, nr = 1, nc = 1) {
    const self = this;
    return { getValues() { return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => ((self.rows[r - 1 + i] || [])[c - 1 + j] ?? ''))); },
             setValue(v) { self.getRange(r, c, 1, 1).setValues([[v]]); }, setValues(vals) {
      if (vals.length !== nr || vals.some((v) => v.length !== nc)) throw new Error('setValues dimension mismatch');
      for (let i = 0; i < nr; i++) { const row = self.rows[r - 1 + i] || (self.rows[r - 1 + i] = []);
        for (let j = 0; j < nc; j++) row[c - 1 + j] = clean(vals[i][j]); }
    } };
  }
}
const clean = (v) => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);   // Sheets strips the text-forcing apostrophe

/** In-memory Drive: folders by id, files by id. Only the calls the app makes. */
export class FakeDrive {
  constructor() { this.folders = {}; this.files = {}; this.n = 0; }
  folder(id, name = id) {
    if (!this.folders[id]) {
      const self = this, f = { id, name, subfolders: {}, fileIds: [] };
      const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
      f.api = {
        getId: () => id, getName: () => name,
        getFoldersByName: (n) => iter(f.subfolders[n] ? [self.folders[f.subfolders[n]].api] : []),
        createFolder: (n) => { const cid = 'fld' + ++self.n; self.folder(cid, n); f.subfolders[n] = cid; return self.folders[cid].api; },
        getFilesByName: (n) => iter(f.fileIds.filter((x) => self.files[x] && self.files[x].name === n).map((x) => self.fileApi(x))),
        createFile: (n, body, mime) => { const fid = 'file' + ++self.n; self.files[fid] = { id: fid, name: n, body, mime, folder: id, writes: 1 }; f.fileIds.push(fid); return self.fileApi(fid); }
      };
      this.folders[id] = f;
    }
    return this.folders[id].api;
  }
  fileApi(fid) {
    const rec = this.files[fid];
    return { getId: () => fid, getName: () => rec.name, getBlob: () => ({ getDataAsString: () => rec.body }),
             setContent: (b) => { rec.body = b; rec.writes++; }, setTrashed: () => { rec.trashed = true; } };
  }
  filesIn(folderApi) { return this.folders[folderApi.getId()].fileIds.map((x) => this.files[x]); }
}

export function loadApp({ email = 'will.ritchings@findigs.com', hub = fakeHubSpot(), token = 'test-token', asOf = '2026-09-25', lockBusy = false,
                          now = '2026-09-25T14:00:00-04:00', testFolderId = null } = {}) {
  const store = { build: [], rollups: {}, sheets: null, clock: Date.parse(now), drive: new FakeDrive(), props: {}, mail: [], triggers: [] };
  const session = { email };
  const props = () => ({ HUBSPOT_TOKEN: token, FORECAST_TEST_FOLDER_ID: testFolderId, ...store.props });
  const ctx = {
    console, JSON, Math, Date, Object, Array, String, Number, Error, encodeURIComponent, RegExp,
    UrlFetchApp: { fetch: (u, o) => hub.fetch(u, o) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props()[k] ?? null, setProperty: (k, v) => { store.props[k] = String(v); },
                                                       deleteProperty: (k) => { delete store.props[k]; } }) },
    MailApp: { sendEmail: (o) => { store.mail.push(o); } },
    ScriptApp: {
      getService: () => ({ getUrl: () => 'https://script.google.com/a/macros/findigs.com/s/TESTDEPLOY/exec' }),
      getProjectTriggers: () => store.triggers.map((t) => ({ getHandlerFunction: () => t.fn })),
      deleteTrigger: (t) => { store.triggers = store.triggers.filter((x) => x.fn !== t.getHandlerFunction()); },
      newTrigger: (fn) => { const b = { timeBased: () => b, everyMinutes: (m) => { b.m = m; return b; }, create: () => { store.triggers.push({ fn, every: b.m }); } }; return b; }
    },
    Utilities: { sleep() {}, DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: () => randomUUID(),
      computeDigest: (_a, s) => [...createHash('sha256').update(s).digest()].map((b) => (b > 127 ? b - 256 : b)) },
    Session: { getActiveUser: () => ({ getEmail: () => session.email }) },
    LockService: { getScriptLock: () => ({ tryLock: () => !store.lockBusy, waitLock() {}, releaseLock() {} }) },
    DriveApp: { getFolderById: (id) => store.drive.folder(id), getFileById: (id) => { if (!store.drive.files[id] || store.drive.files[id].trashed) throw new Error('No item with the given ID'); return store.drive.fileApi(id); } },
    Logger: { log() {} },
    HtmlService: {
      XFrameOptionsMode: { DEFAULT: 'DEFAULT' },
      createHtmlOutput: (html) => htmlOut(html),
      createHtmlOutputFromFile: (name) => htmlOut(readFileSync(join(GAS, name + '.html'), 'utf8')),
      createTemplateFromFile: (name) => ({ evaluate: () => htmlOut(renderTemplate(readFileSync(join(GAS, name + '.html'), 'utf8'), ctx)) })
    }
  };
  store.lockBusy = lockBusy;
  vm.createContext(ctx);
  // Same order Apps Script uses (clasp pushes alphabetically), so top-level cross-file dependencies fail here too.
  const files = readdirSync(GAS).filter((f) => f.endsWith('.gs')).sort();
  for (const f of files) vm.runInContext(readFileSync(join(GAS, f), 'utf8'), ctx, { filename: f });

  // Sheets → memory, one rollup per (mode, FY). Drive, cache, and folder routing run the real Storage.gs code on FakeDrive.
  const tabs = vm.runInContext('ROLLUP_TABS_', ctx);
  const rollup = (key) => {
    if (!store.rollups[key]) { store.rollups[key] = {}; for (const [t, h] of Object.entries(tabs)) store.rollups[key][t] = new FakeSheet(t, h); }
    return store.rollups[key];
  };
  ctx.getRollup_ = (fy) => {
    ctx.getYearFolder_(fy);                       // same "folder not configured" block as production
    const sheets = rollup((ctx.isTestMode_() ? 'T' : 'P') + fy);
    return { getSheetByName: (n) => sheets[n] || null };
  };
  store.sheets = rollup('P2026');
  ctx.appendBuildLog_ = (e) => store.build.push(e);
  ctx.todayEt_ = () => asOf;
  ctx.nowMs_ = () => store.clock;
  const origPull = ctx.pullData_;
  ctx.pullData_ = (opts) => origPull(Object.assign({ asOf }, opts || {}));

  /** Call a server function the way google.script.run would: JSON in, JSON out. */
  const call = (fn, ...args) => JSON.parse(JSON.stringify(ctx[fn](...JSON.parse(JSON.stringify(args)))));
  const setNow = (iso) => { store.clock = Date.parse(iso); };
  return { ctx, store, session, hub, call, setNow };
}

function htmlOut(html) {
  const o = { content: html, getContent: () => o.content, setTitle: () => o, addMetaTag: () => o, setXFrameOptionsMode: () => o };
  return o;
}
/** Supports the only scriptlet the project uses: <?!= include('Name') ?> (recursively). */
export function renderTemplate(src, ctx) {
  return src.replace(/<\?!=\s*include\('([A-Za-z0-9_]+)'\)\s*\?>/g, (_, n) => renderTemplate(ctx.include(n), ctx));
}
