/**
 * Findigs Sales Forecast — pure business logic.
 *
 * One file, two runtimes: loaded by Node for tests (module.exports) and copied verbatim into the
 * Apps Script project as Generated_Core.gs by scripts/build.mjs (global `ForecastCore`).
 * No I/O, no Apps Script services, no Date.now() — every "now" is passed in.
 *
 * HubSpot definitions mirror gtm-dashboard/config.json (via FORECAST_CONFIG.hubspot). Differences
 * from gtm-dashboard/build.py, both deliberate:
 *   - a null amount / units / close date is surfaced as blank + flag, never a hard stop and never imputed;
 *   - "" is treated as null (HubSpot returns empty strings on some cleared fields; the reporting API
 *     counts them as null, so we must too or the tie-out drifts);
 *   - weighted pipeline = amount × pipeline stage probability (decision 2026-09-25, hs.weightingMethod
 *     'stage_probability'); gtm-dashboard's stored-first rule remains available as 'stored_first'.
 */
var ForecastCore = (function () {
  'use strict';

  // ------------------------------------------------------------------ numbers
  function num(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).trim();
    if (s === '') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }
  function round2(x) { return x === null ? null : Math.round((x + (x >= 0 ? 1e-9 : -1e-9)) * 100) / 100; }
  function blank(v) { return v === null || v === undefined || String(v).trim() === ''; }

  // ------------------------------------------------------------------ America/New_York time
  // US DST rules (Energy Policy Act 2005, in force since 2007): EDT from the second Sunday of March
  // 02:00 local to the first Sunday of November 02:00 local. Implemented by hand so results are
  // identical in Node and Apps Script regardless of Intl support.
  function nthSunday_(year, monthIdx, n) {
    var firstDow = new Date(Date.UTC(year, monthIdx, 1)).getUTCDay();
    return 1 + ((7 - firstDow) % 7) + 7 * (n - 1);
  }
  function etOffsetMinutes(utcMs) {
    var y = new Date(utcMs).getUTCFullYear();
    var start = Date.UTC(y, 2, nthSunday_(y, 2, 2), 7);  // 02:00 EST = 07:00 UTC
    var end = Date.UTC(y, 10, nthSunday_(y, 10, 1), 6);  // 02:00 EDT = 06:00 UTC
    return (utcMs >= start && utcMs < end) ? -240 : -300;
  }
  function toMs_(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
    var s = String(v).trim();
    if (/^\d+$/.test(s)) return Number(s);           // epoch ms (HubSpot sometimes returns these)
    var ms = Date.parse(s);
    return isNaN(ms) ? null : ms;
  }
  function pad_(n, w) { var s = String(n); while (s.length < (w || 2)) s = '0' + s; return s; }
  function etParts(v) {
    var ms = toMs_(v); if (ms === null) return null;
    var off = etOffsetMinutes(ms);
    var d = new Date(ms + off * 60000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(),
             mi: d.getUTCMinutes(), ss: d.getUTCSeconds(), ms: d.getUTCMilliseconds(), offsetMin: off,
             dow: d.getUTCDay() };
  }
  /** UTC timestamp → 'YYYY-MM-DD' in America/New_York, or null. */
  function etDate(v) {
    var p = etParts(v); if (!p) return null;
    return p.y + '-' + pad_(p.m) + '-' + pad_(p.d);
  }
  /** UTC ms → ISO 8601 with ET offset, e.g. 2026-10-02T10:41:07.312-04:00 */
  function etIso(v) {
    var p = etParts(v); if (!p) return null;
    var o = -p.offsetMin, sign = p.offsetMin <= 0 ? '-' : '+';
    return p.y + '-' + pad_(p.m) + '-' + pad_(p.d) + 'T' + pad_(p.hh) + ':' + pad_(p.mi) + ':' + pad_(p.ss) + '.' +
           pad_(p.ms, 3) + sign + pad_(Math.floor(Math.abs(o) / 60)) + ':' + pad_(Math.abs(o) % 60);
  }
  /** 'YYYY-MM-DD' + 'HH:MM' ET → UTC ms. Not valid inside the 02:00 DST gap (never used there). */
  function etToUtcMs(dateStr, timeStr) {
    var a = dateStr.split('-').map(Number), t = (timeStr || '00:00').split(':').map(Number);
    var guess = Date.UTC(a[0], a[1] - 1, a[2], t[0], t[1] || 0, t[2] || 0) + 300 * 60000; // assume EST
    var off = etOffsetMinutes(guess);
    return Date.UTC(a[0], a[1] - 1, a[2], t[0], t[1] || 0, t[2] || 0) - off * 60000;
  }
  function addDays(dateStr, n) {
    var a = dateStr.split('-').map(Number);
    var d = new Date(Date.UTC(a[0], a[1] - 1, a[2] + n));
    return d.getUTCFullYear() + '-' + pad_(d.getUTCMonth() + 1) + '-' + pad_(d.getUTCDate());
  }

  // ------------------------------------------------------------------ fiscal / forecast period
  function fiscalYearOf(dateStr) { return Number(dateStr.slice(0, 4)); }
  function periodFor(asOfDate) {
    var y = fiscalYearOf(asOfDate);
    return { fyStart: y + '-01-01', fyEnd: y + '-12-31', start: asOfDate, end: y + '-12-31', fiscalYear: y };
  }

  // ------------------------------------------------------------------ stage map (pipelines API)
  /**
   * pipelinesResponse: GET /crm/v3/pipelines/deals body ({results:[{id,label,stages:[{id,label,displayOrder,metadata:{isClosed,probability}}]}]}).
   * hs: FORECAST_CONFIG.hubspot. Config terminal stage IDs are the authority (shared with gtm-dashboard);
   * the pipelines API must agree with them or the pull stops (same trip-wire as build.py exit 3).
   */
  function buildStageMap(pipelinesResponse, hs) {
    var errors = [], stages = {}, byPipe = {};
    (pipelinesResponse.results || []).forEach(function (p) { byPipe[String(p.id)] = p; });
    var apiWon = [], apiLost = [];
    hs.inScopePipelineIds.forEach(function (pid) {
      var p = byPipe[pid];
      if (!p) { errors.push('In-scope pipeline ' + pid + ' not returned by pipelines API'); return; }
      (p.stages || []).forEach(function (s) {
        var md = s.metadata || {};
        var isClosed = String(md.isClosed) === 'true';
        var prob = num(md.probability);
        var won = isClosed && prob === 1, lost = isClosed && prob === 0;
        if (isClosed && !won && !lost) errors.push('Stage ' + s.id + ' (' + s.label + ') is closed with probability ' + md.probability + ' — cannot classify as won or lost');
        if (won) apiWon.push(String(s.id));
        if (lost) apiLost.push(String(s.id));
        stages[String(s.id)] = { id: String(s.id), label: s.label, pipelineId: pid, pipelineLabel: p.label,
                                 order: num(s.displayOrder), probability: prob, isClosed: isClosed, won: won, lost: lost };
      });
    });
    function sameSet(a, b) { return a.length === b.length && a.slice().sort().join() === b.slice().sort().join(); }
    if (!sameSet(apiWon, hs.wonStageIds)) errors.push('Won stage drift: pipelines API ' + JSON.stringify(apiWon.sort()) + ' vs config ' + JSON.stringify(hs.wonStageIds.slice().sort()));
    if (!sameSet(apiLost, hs.lostStageIds)) errors.push('Lost stage drift: pipelines API ' + JSON.stringify(apiLost.sort()) + ' vs config ' + JSON.stringify(hs.lostStageIds.slice().sort()));
    var terminal = hs.wonStageIds.concat(hs.lostStageIds);
    var openIds = Object.keys(stages).filter(function (id) { return terminal.indexOf(id) < 0; });
    return { ok: errors.length === 0, errors: errors, stages: stages, wonIds: hs.wonStageIds.slice(),
             lostIds: hs.lostStageIds.slice(), openIds: openIds };
  }

  // ------------------------------------------------------------------ owners (owners API v3)
  /** v3 owners → {id: {id,name,email,isActive,hasUserSeat}}. v3 expresses isActive as !archived. */
  function normalizeOwners(v3Results) {
    var out = {};
    (v3Results || []).forEach(function (o) {
      var id = String(o.id);
      var name = [o.firstName, o.lastName].filter(function (x) { return !blank(x); }).join(' ') || o.email || ('Owner ' + id);
      var rec = { id: id, name: name, email: (o.email || '').toLowerCase(), isActive: o.archived !== true,
                  hasUserSeat: o.userId !== null && o.userId !== undefined };
      // An owner can appear in both the active and archived lists; active wins.
      if (!out[id] || (rec.isActive && !out[id].isActive)) out[id] = rec;
    });
    return out;
  }

  // ------------------------------------------------------------------ viewer / roster
  /**
   * Everyone on the roster sees everything, read-only (decision 2026-09-25: full transparency).
   * Edits: an AE (incl. ae_leader) edits their own builder and submits their own forecast; an admin can
   * submit on behalf of any AE and edit any AE's builder tags (P3-7, P5-4). An AE entry may carry admin: true
   * (Phil Aroian). canRefresh gates the expensive forced HubSpot refresh.
   */
  function resolveViewer(email, roster) {
    var e = String(email || '').trim().toLowerCase();
    if (!e) return null;
    var ae = (roster.aes || []).filter(function (a) { return a.email.toLowerCase() === e; })[0];
    if (ae) return { email: e, name: ae.name, role: ae.role, ae: ae, canViewAll: true, canRefresh: ae.role === 'ae_leader' || ae.admin === true, isAdmin: ae.admin === true };
    var lead = (roster.leadership || []).filter(function (a) { return a.email.toLowerCase() === e; })[0];
    if (lead) return { email: e, name: lead.name, role: 'leadership', ae: null, canViewAll: true, canRefresh: true, isAdmin: false };
    var adm = (roster.admins || []).filter(function (a) { return a.email.toLowerCase() === e; })[0];
    if (adm) return { email: e, name: adm.name, role: 'admin', ae: null, canViewAll: true, canRefresh: true, isAdmin: true };
    return null;
  }
  /** Roster AE slugs this viewer may submit a forecast for. */
  function submittableSlugs(viewer, roster) {
    if (!viewer) return [];
    if (viewer.isAdmin) return (roster.aes || []).map(function (a) { return a.slug; });
    return viewer.ae ? [viewer.ae.slug] : [];
  }

  // ------------------------------------------------------------------ roster administration (admin panel)
  var ACCESS_LEVELS = ['ae', 'ae_leader', 'leadership', 'admin'];
  var ACCESS_LABELS = { ae: 'AE', ae_leader: 'AE and leadership', leadership: 'Leadership (view only)', admin: 'Admin' };
  function isActive_(p) { return p.active !== false; }
  function clone_(x) { return JSON.parse(JSON.stringify(x)); }

  /**
   * The roster as the app uses it at runtime: only active people can sign in or submit, and a deactivated AE's
   * HubSpot owner moves to "Other owners" (their deals stay in the company total; their history stays in the trend).
   */
  function activeRoster(roster) {
    var r = clone_(roster);
    var inactiveAes = r.aes.filter(function (a) { return !isActive_(a); });
    r.aes = r.aes.filter(isActive_);
    r.leadership = (r.leadership || []).filter(isActive_);
    r.admins = (r.admins || []).filter(isActive_);
    r.non_roster_owners = r.non_roster_owners || { owners: [] };
    r.non_roster_owners.owners = r.non_roster_owners.owners || [];
    var listed = {};
    r.non_roster_owners.owners.forEach(function (o) { listed[String(o.hubspot_owner_id)] = true; });
    inactiveAes.forEach(function (a) {
      var oid = String(a.hubspot_owner_id);
      if (listed[oid] || r.aes.some(function (x) { return String(x.hubspot_owner_id) === oid; })) return;
      r.non_roster_owners.owners.push({ name: a.name, hubspot_owner_id: oid, reason: 'Deactivated in the forecast tool' + (a.deactivated_at ? ' on ' + String(a.deactivated_at).slice(0, 10) : '') });
      listed[oid] = true;
    });
    return r;
  }

  /** One flat, display-ready list of everyone on the roster (active and inactive), for the admin panel. */
  function rosterUsers(roster, owners) {
    owners = owners || {};
    var out = [];
    function ownerInfo(oid) { var o = owners[String(oid)]; return o ? { name: o.name, email: o.email, status: !o.isActive ? 'inactive' : (!o.hasUserSeat ? 'no_user_seat' : 'active') } : null; }
    roster.aes.forEach(function (a) {
      out.push({ email: a.email, name: a.name, access: a.role, admin: a.admin === true, isAe: true, slug: a.slug,
                 hubspotOwnerId: String(a.hubspot_owner_id), hubspotOwner: ownerInfo(a.hubspot_owner_id), active: isActive_(a),
                 invitedAt: a.invited_at || null, invitedBy: a.invited_by || null, deactivatedAt: a.deactivated_at || null });
    });
    (roster.leadership || []).forEach(function (l) {
      out.push({ email: l.email, name: l.name, access: 'leadership', admin: false, isAe: false, active: isActive_(l),
                 invitedAt: l.invited_at || null, invitedBy: l.invited_by || null, deactivatedAt: l.deactivated_at || null });
    });
    (roster.admins || []).forEach(function (l) {
      out.push({ email: l.email, name: l.name, access: 'admin', admin: true, isAe: false, active: isActive_(l),
                 invitedAt: l.invited_at || null, invitedBy: l.invited_by || null, deactivatedAt: l.deactivated_at || null });
    });
    // An AE moved to leadership/admin keeps an inactive AE record for history; show the person once, active record first.
    var seen = {}, dedup = [];
    out.sort(function (a, b) { return (b.active - a.active) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); })
       .forEach(function (u) { var k = u.email.toLowerCase(); if (seen[k]) { seen[k].priorAeSlug = seen[k].priorAeSlug || (u.isAe ? u.slug : null); return; } seen[k] = u; dedup.push(u); });
    return dedup;
  }

  function slugify_(name) { return String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
  function activeAdminCount_(r) {
    return r.aes.filter(function (a) { return isActive_(a) && a.admin === true; }).length + (r.admins || []).filter(isActive_).length;
  }

  /**
   * Apply one admin change to the roster. Pure: returns { roster, target, summary, before, after } or throws a
   * user-facing Error. ctx: { owners (normalizeOwners map), now (ET ISO), actor (email) }.
   *   invite       { email, name, access, admin?, ownerId? }
   *   update       { email, name?, access?, admin?, ownerId? }
   *   deactivate   { email }            reactivate { email }
   *   nonroster_set { ownerId, name?, reason }   nonroster_remove { ownerId }
   * Guardrails: findigs.com emails only; one active entry per email; an AE needs a HubSpot owner that exists and is not
   * already another AE's; AE slugs never change (they name snapshot files); the last active admin cannot be removed;
   * an admin cannot deactivate or demote themselves (another admin must do it).
   */
  function applyRosterChange(roster, change, ctx) {
    ctx = ctx || {};
    var r = clone_(roster), owners = ctx.owners || {}, now = ctx.now || null, actor = String(ctx.actor || '').toLowerCase();
    r.leadership = r.leadership || []; r.admins = r.admins || [];
    r.non_roster_owners = r.non_roster_owners || { owners: [] }; r.non_roster_owners.owners = r.non_roster_owners.owners || [];
    var c = change || {}, action = c.action;
    var email = String(c.email || '').trim().toLowerCase(), name = String(c.name || '').trim();
    function err(m) { throw new Error(m); }
    function findAll(e) {
      return { ae: r.aes.filter(function (a) { return a.email.toLowerCase() === e; }),
               lead: r.leadership.filter(function (a) { return a.email.toLowerCase() === e; }),
               adm: r.admins.filter(function (a) { return a.email.toLowerCase() === e; }) };
    }
    function activeEntry(e) {
      var f = findAll(e);
      return f.ae.filter(isActive_)[0] ? { kind: 'ae', rec: f.ae.filter(isActive_)[0] }
           : f.lead.filter(isActive_)[0] ? { kind: 'leadership', rec: f.lead.filter(isActive_)[0] }
           : f.adm.filter(isActive_)[0] ? { kind: 'admin', rec: f.adm.filter(isActive_)[0] } : null;
    }
    function anyEntry(e) {
      var a = activeEntry(e); if (a) return a;
      var f = findAll(e);
      return f.ae[0] ? { kind: 'ae', rec: f.ae[0] } : f.lead[0] ? { kind: 'leadership', rec: f.lead[0] } : f.adm[0] ? { kind: 'admin', rec: f.adm[0] } : null;
    }
    function describe(e) { var x = anyEntry(e); if (!x) return null; var u = clone_(x.rec); u.kind = x.kind; return u; }
    function checkOwner(oid, exceptEmail) {
      oid = String(oid || '').trim();
      if (!/^\d+$/.test(oid)) err('Choose the HubSpot owner for this AE.');
      if (!owners[oid]) err('HubSpot owner ' + oid + ' was not found. Refresh data and try again.');
      var clash = r.aes.filter(function (a) { return String(a.hubspot_owner_id) === oid && a.email.toLowerCase() !== exceptEmail; })[0];
      if (clash) err('HubSpot owner ' + owners[oid].name + ' is already assigned to ' + clash.name + (isActive_(clash) ? '' : ' (inactive)') + '.');
      if (r.non_roster_owners.owners.some(function (o) { return String(o.hubspot_owner_id) === oid; }))
        r.non_roster_owners.owners = r.non_roster_owners.owners.filter(function (o) { return String(o.hubspot_owner_id) !== oid; });
      return oid;
    }
    function placeAs(access, rec, isAdminFlag, ownerId) {
      // Put an active entry for this person in the right list. AE records are reused (never recreated) so the slug holds.
      if (access === 'ae' || access === 'ae_leader') {
        var existing = r.aes.filter(function (a) { return a.email.toLowerCase() === rec.email; })[0];
        var oid = checkOwner(ownerId || (existing && existing.hubspot_owner_id), rec.email);
        if (existing) {
          existing.name = rec.name; existing.role = access; existing.hubspot_owner_id = oid; existing.active = true; delete existing.deactivated_at;
          if (isAdminFlag) existing.admin = true; else delete existing.admin;
        } else {
          var slug = slugify_(rec.name), base = slug, n = 2;
          if (!slug) err('Enter the person\'s name.');
          while (r.aes.some(function (a) { return a.slug === slug; })) slug = base + '-' + n++;
          var ae = { name: rec.name, slug: slug, email: rec.email, hubspot_owner_id: oid, role: access };
          if (isAdminFlag) ae.admin = true;
          if (rec.invited_at) { ae.invited_at = rec.invited_at; ae.invited_by = rec.invited_by; }
          r.aes.push(ae);
        }
      } else {
        var list = access === 'admin' ? r.admins : r.leadership;
        var e2 = { name: rec.name, email: rec.email };
        if (rec.invited_at) { e2.invited_at = rec.invited_at; e2.invited_by = rec.invited_by; }
        list.push(e2);
      }
    }
    function retire(entry) {
      // Leave the current active entry. AEs are kept inactive (history); leadership/admin entries are removed.
      if (entry.kind === 'ae') { entry.rec.active = false; entry.rec.deactivated_at = now; }
      else if (entry.kind === 'leadership') r.leadership = r.leadership.filter(function (x) { return x !== entry.rec; });
      else r.admins = r.admins.filter(function (x) { return x !== entry.rec; });
    }
    function guardAdmins(msg) { if (activeAdminCount_(r) < 1) err(msg || 'At least one active admin is required.'); }

    var before = email ? describe(email) : null, summary, target = email;
    if (action === 'invite') {
      if (!/^[a-z0-9._%+\-]+@findigs\.com$/.test(email)) err('Use a findigs.com email address.');
      if (!name) err('Enter the person\'s name.');
      if (ACCESS_LEVELS.indexOf(c.access) < 0) err('Choose an access level.');
      if (activeEntry(email)) err(email + ' already has access. Change their access instead.');
      if (anyEntry(email)) err(email + ' is on the roster but inactive. Reactivate them instead.');
      placeAs(c.access, { email: email, name: name, invited_at: now, invited_by: actor }, c.admin === true, c.ownerId);
      summary = 'Invited ' + name + ' as ' + ACCESS_LABELS[c.access] + (c.admin === true && c.access !== 'admin' ? ' + admin' : '');
    } else if (action === 'update') {
      var cur = activeEntry(email);
      if (!cur) err(email + ' is not an active user.');
      var curAccess = cur.kind === 'ae' ? cur.rec.role : cur.kind;
      var access = c.access || curAccess;
      if (ACCESS_LEVELS.indexOf(access) < 0) err('Choose an access level.');
      var newName = name || cur.rec.name;
      var isAe = access === 'ae' || access === 'ae_leader';
      var adminFlag = access === 'admin' ? true : (isAe ? (c.admin === undefined ? cur.rec.admin === true : c.admin === true) : false);
      var wasAdmin = cur.kind === 'admin' || cur.rec.admin === true;
      if (email === actor && wasAdmin && !adminFlag) err('You can\'t remove your own admin access. Ask another admin.');
      if ((cur.kind === 'ae') === isAe && cur.kind !== 'leadership' && cur.kind !== 'admin') {
        // AE stays an AE: edit in place
        cur.rec.name = newName; cur.rec.role = access;
        if (c.ownerId && String(c.ownerId) !== String(cur.rec.hubspot_owner_id)) cur.rec.hubspot_owner_id = checkOwner(c.ownerId, email);
        if (adminFlag) cur.rec.admin = true; else delete cur.rec.admin;
      } else if (!isAe && cur.kind === access) {
        cur.rec.name = newName;                      // leadership→leadership / admin→admin: rename only
      } else {
        retire(cur);
        placeAs(access, { email: email, name: newName }, adminFlag, c.ownerId);
      }
      guardAdmins('That change would leave no active admin.');
      summary = 'Changed ' + newName + ' to ' + ACCESS_LABELS[access] + (adminFlag && access !== 'admin' ? ' + admin' : '');
    } else if (action === 'deactivate') {
      var d = activeEntry(email);
      if (!d) err(email + ' is not an active user.');
      if (email === actor) err('You can\'t deactivate yourself. Ask another admin.');
      retire(d);
      guardAdmins('You can\'t deactivate the last active admin.');
      summary = 'Deactivated ' + d.rec.name + (d.kind === 'ae' ? ' (forecast history kept)' : '');
    } else if (action === 'reactivate') {
      if (activeEntry(email)) err(email + ' is already active.');
      var ia = r.aes.filter(function (a) { return a.email.toLowerCase() === email && !isActive_(a); })[0];
      if (!ia) err(email + ' was not found. Invite them instead.');
      checkOwner(ia.hubspot_owner_id, email);
      ia.active = true; delete ia.deactivated_at;
      summary = 'Reactivated ' + ia.name;
    } else if (action === 'nonroster_set') {
      var oid = String(c.ownerId || '').trim();
      if (!/^\d+$/.test(oid)) err('Choose a HubSpot owner.');
      if (r.aes.some(function (a) { return isActive_(a) && String(a.hubspot_owner_id) === oid; })) err('That owner is an active AE on the roster.');
      var reason = String(c.reason || '').trim();
      if (!reason) err('Enter a reason (shown in Sources & methodology and the Other owners row).');
      var nm = name || (owners[oid] ? owners[oid].name : 'Owner ' + oid);
      var ex = r.non_roster_owners.owners.filter(function (o) { return String(o.hubspot_owner_id) === oid; })[0];
      before = ex ? clone_(ex) : null;
      if (ex) { ex.reason = reason; ex.name = nm; } else r.non_roster_owners.owners.push({ name: nm, hubspot_owner_id: oid, reason: reason });
      target = oid; summary = (ex ? 'Updated' : 'Added') + ' other owner ' + nm;
    } else if (action === 'nonroster_remove') {
      var rid = String(c.ownerId || '');
      var rx = r.non_roster_owners.owners.filter(function (o) { return String(o.hubspot_owner_id) === rid; })[0];
      if (!rx) err('That owner is not on the Other owners list.');
      before = clone_(rx);
      r.non_roster_owners.owners = r.non_roster_owners.owners.filter(function (o) { return o !== rx; });
      target = rid; summary = 'Removed other owner ' + rx.name + ' (they still appear under Other owners, with a default reason, while they hold deals)';
    } else err('Unknown admin action: ' + action);

    var after = action.indexOf('nonroster') === 0
      ? (r.non_roster_owners.owners.filter(function (o) { return String(o.hubspot_owner_id) === target; })[0] || null)
      : describe(email);
    return { roster: r, target: target, action: action, summary: summary, before: before, after: after ? clone_(after) : null };
  }

  /** Invite email (subject, plain text, HTML). Plain wording; the link is the production web app URL. */
  function inviteMessage(o) {
    var t = String((o.cutoff && o.cutoff.time_et) || '17:00').split(':'), h = +t[0];
    var cutoff = ((o.cutoff && o.cutoff.weekday) || 'Friday') + ' ' + ((h % 12) || 12) + ':' + t[1] + (h >= 12 ? ' PM' : ' AM') + ' ET';
    var isAe = o.access === 'ae' || o.access === 'ae_leader';
    var can = isAe
      ? ['Submit your weekly Commit, Gut, and Best Case forecast before ' + cutoff + '.', 'Tag your open HubSpot deals in the Forecast builder.', 'See every AE\'s forecast and the team trend.']
      : ['See every AE\'s forecast, builder, and the week-over-week trend.'];
    if (o.admin || o.access === 'admin') can.push('As an admin: edit any AE\'s tags, submit on an AE\'s behalf, and manage users in the Admin tab.');
    var first = String(o.name || '').split(' ')[0] || 'there';
    var subject = 'You now have access to the Findigs Sales Forecast Tool';
    var lines = ['Hi ' + first + ',', '', (o.invitedBy || 'An admin') + ' added you to the Findigs Sales Forecast Tool as ' + ACCESS_LABELS[o.access] + (o.admin && o.access !== 'admin' ? ' + admin' : '') + '.', '',
                 'What you can do:'].concat(can.map(function (x) { return '- ' + x; })).concat(['',
                 'Open the tool: ' + (o.appUrl || '(link will be shared separately)'), 'Sign in with your findigs.com Google account.']);
    if (o.docsUrl) lines.push('', 'How it works (5-minute read): ' + o.docsUrl);
    if (isAe) lines.push('', 'Weekly deadline: ' + cutoff + '. Your last submission before then is your official number for the week.');
    lines.push('', 'Questions: reply to this email.');
    var esc = function (x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    var html = '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#212B14">' +
      '<p>Hi ' + esc(first) + ',</p><p>' + esc(o.invitedBy || 'An admin') + ' added you to the <strong>Findigs Sales Forecast Tool</strong> as <strong>' + esc(ACCESS_LABELS[o.access] + (o.admin && o.access !== 'admin' ? ' + admin' : '')) + '</strong>.</p>' +
      '<p>What you can do:</p><ul>' + can.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      (o.appUrl ? '<p><a href="' + esc(o.appUrl) + '" style="background:#8EDE65;color:#212B14;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:bold;display:inline-block">Open the Sales Forecast Tool</a></p>' : '<p>The link to the tool will be shared separately.</p>') +
      '<p>Sign in with your findigs.com Google account.</p>' +
      (o.docsUrl ? '<p>How it works (5-minute read): <a href="' + esc(o.docsUrl) + '">Sales Forecast Tool guide</a></p>' : '') +
      (isAe ? '<p><strong>Weekly deadline: ' + esc(cutoff) + '.</strong> Your last submission before then is your official number for the week.</p>' : '') +
      '<p>Questions: reply to this email.</p></div>';
    return { subject: subject, text: lines.join('\n'), html: html };
  }

  /** Runtime Drive folder map: config folders plus any years an admin added in the panel (config wins on conflict). */
  function mergeFolders(configFolders, addedFolders) {
    var out = {};
    Object.keys(addedFolders || {}).forEach(function (y) { out[y] = addedFolders[y]; });
    Object.keys(configFolders || {}).forEach(function (y) { out[y] = configFolders[y]; });
    return out;
  }

  // ------------------------------------------------------------------ deals
  var HS_RECORD_URL = 'https://app.hubspot.com/contacts/{portal}/record/0-3/{id}';
  function dealUrl(portalId, id) { return HS_RECORD_URL.replace('{portal}', portalId).replace('{id}', id); }

  function deriveOpenDeal(raw, ctx) {
    var p = raw.properties || {}, f = ctx.hs.fields;
    var id = String(raw.id), sid = String(p.dealstage);
    var st = ctx.stageMap.stages[sid] || null;
    var amount = num(p[f.bookings_amount]), units = num(p[f.units]);
    var close = etDate(p[f.close_date]);
    var probDeal = num(p[f.stage_probability]);
    var probStage = st ? st.probability : null;
    var stored = num(p[f.weighted_stored]);
    var mode = ctx.hs.weightingMethod || 'stage_probability';
    var prob, weighted = null, method = 'none';
    if (mode === 'stage_probability') {
      // Decision 2026-09-25: amount × pipeline stage probability (pipelines API) for every open deal.
      // HubSpot weighted_amount is kept only as a reference value; it is not used.
      prob = probStage;
      if (amount !== null && prob !== null) { weighted = amount * prob; method = 'stage'; }
    } else {
      // gtm-dashboard rule: stored weighted_amount, else amount × hs_deal_stage_probability.
      prob = probDeal !== null ? probDeal : probStage;
      if (stored !== null) { weighted = stored; method = 'stored'; }
      else if (amount !== null && prob !== null) { weighted = amount * prob; method = 'fallback'; }
    }
    var flags = [];
    if (amount === null) flags.push('missing_amount');
    if (close === null) flags.push('missing_close_date');
    if (units === null) flags.push('missing_units');
    if (close !== null && close < ctx.asOf) flags.push('past_due');
    if (!st) flags.push('unknown_stage');
    if (mode !== 'stage_probability' && probDeal === null) flags.push('prob_from_stage');
    if (probDeal !== null && probStage !== null && Math.abs(probDeal - probStage) > 1e-9) flags.push('prob_deviates_from_stage');
    if (stored !== null && amount !== null && probStage !== null && Math.abs(stored - amount * probStage) > 0.01) flags.push('weighted_stored_differs_from_calc');
    if (method === 'fallback') flags.push('weighted_fallback');
    if (method === 'none') flags.push('weighted_unavailable');
    return {
      id: id, name: p.dealname || '', url: dealUrl(ctx.portalId, id),
      pipelineId: String(p.pipeline), pipeline: st ? st.pipelineLabel : String(p.pipeline),
      stageId: sid, stage: st ? st.label : sid, stageOrder: st ? st.order : null,
      ownerId: blank(p[f.owner]) ? '' : String(p[f.owner]),
      amount: amount, units: units, closeDate: close,
      probability: prob, dealProbability: probDeal, weighted: weighted, weightedMethod: method,
      hubspotWeightedAmount: stored,
      inPeriod: close !== null && close <= ctx.periodEnd,
      flags: flags
    };
  }

  function deriveWonDeal(raw, ctx) {
    var p = raw.properties || {}, f = ctx.hs.fields, id = String(raw.id);
    var close = etDate(p[f.close_date]);
    var amount = num(p[f.bookings_amount]);
    return { id: id, name: p.dealname || '', url: dealUrl(ctx.portalId, id), pipelineId: String(p.pipeline),
             stageId: String(p.dealstage), ownerId: blank(p[f.owner]) ? '' : String(p[f.owner]),
             amount: amount, units: num(p[f.units]), closeDate: close,
             flags: amount === null ? ['missing_amount'] : [] };
  }

  /**
   * Split any set of raw deal records (search results OR a full objects-list dump) into the two
   * populations. Used identically by the primary and independent tie-out paths.
   */
  function classifyDeals(rawDeals, ctx) {
    var hs = ctx.hs, inScope = hs.inScopePipelineIds, won = hs.wonStageIds, lost = hs.lostStageIds;
    var open = [], wonYtd = [], outOfScope = 0, seen = {};
    (rawDeals || []).forEach(function (r) {
      var id = String(r.id); if (seen[id]) return; seen[id] = true;
      var p = r.properties || {}, pipe = String(p.pipeline), sid = String(p.dealstage);
      if (inScope.indexOf(pipe) < 0) { outOfScope++; return; }
      if (won.indexOf(sid) >= 0) {
        var d = deriveWonDeal(r, ctx);
        if (d.closeDate !== null && d.closeDate >= ctx.fyStart && d.closeDate <= ctx.asOf) wonYtd.push(d);
      } else if (lost.indexOf(sid) < 0) {
        open.push(deriveOpenDeal(r, ctx));
      }
    });
    return { open: open, wonYtd: wonYtd, outOfScope: outOfScope };
  }

  // ------------------------------------------------------------------ aggregation
  function emptyMetrics_() {
    return {
      closedWonYtd: { amount: 0, count: 0, nullAmountCount: 0 },
      grossOpen: { amount: 0, count: 0, nullAmountCount: 0 },
      grossOpenInPeriod: { amount: 0, count: 0, nullAmountCount: 0, noCloseDateCount: 0 },
      weightedOpen: { amount: 0, stageCount: 0, storedCount: 0, storedAmount: 0, fallbackCount: 0, fallbackAmount: 0, unavailableCount: 0,
                      hubspotStoredCount: 0, hubspotStoredAmount: 0 },
      dq: { pastDue: 0, pastDueAmount: 0, missingAmount: 0, missingCloseDate: 0, missingUnits: 0, probDeviates: 0 }
    };
  }
  function addOpen_(m, d) {
    m.grossOpen.count++;
    if (d.amount === null) m.grossOpen.nullAmountCount++; else m.grossOpen.amount += d.amount;
    if (d.closeDate === null) m.grossOpenInPeriod.noCloseDateCount++;
    if (d.inPeriod) {
      m.grossOpenInPeriod.count++;
      if (d.amount === null) m.grossOpenInPeriod.nullAmountCount++; else m.grossOpenInPeriod.amount += d.amount;
    }
    var w = m.weightedOpen;
    if (d.hubspotWeightedAmount !== null) { w.hubspotStoredCount++; w.hubspotStoredAmount += d.hubspotWeightedAmount; }
    if (d.weightedMethod === 'stage') { w.stageCount++; w.amount += d.weighted; }
    else if (d.weightedMethod === 'stored') { w.storedCount++; w.storedAmount += d.weighted; w.amount += d.weighted; }
    else if (d.weightedMethod === 'fallback') { w.fallbackCount++; w.fallbackAmount += d.weighted; w.amount += d.weighted; }
    else w.unavailableCount++;
    if (d.flags.indexOf('past_due') >= 0) { m.dq.pastDue++; m.dq.pastDueAmount += d.amount || 0; }
    if (d.flags.indexOf('missing_amount') >= 0) m.dq.missingAmount++;
    if (d.flags.indexOf('missing_close_date') >= 0) m.dq.missingCloseDate++;
    if (d.flags.indexOf('missing_units') >= 0) m.dq.missingUnits++;
    if (d.flags.indexOf('prob_deviates_from_stage') >= 0) m.dq.probDeviates++;
  }
  function addWon_(m, d) {
    m.closedWonYtd.count++;
    if (d.amount === null) m.closedWonYtd.nullAmountCount++; else m.closedWonYtd.amount += d.amount;
  }
  function mergeInto_(t, m) {
    Object.keys(m).forEach(function (k) { Object.keys(m[k]).forEach(function (j) { t[k][j] += m[k][j]; }); });
  }
  function roundMetrics_(m) {
    var money = { amount: 1, storedAmount: 1, fallbackAmount: 1, pastDueAmount: 1, hubspotStoredAmount: 1 };
    Object.keys(m).forEach(function (k) { Object.keys(m[k]).forEach(function (j) { if (money[j]) m[k][j] = round2(m[k][j]); }); });
    return m;
  }

  /**
   * input: { openRaw, wonRaw, stageMap, owners, roster, hs, portalId, asOf }
   * openRaw / wonRaw are raw HubSpot records (the won pull may over-fetch across the FY boundary;
   * ET filtering happens here).
   */
  function computeMetrics(input) {
    var per = periodFor(input.asOf);
    var ctx = { hs: input.hs, stageMap: input.stageMap, portalId: input.portalId, asOf: input.asOf,
                fyStart: per.fyStart, periodEnd: per.end };
    var cls = classifyDeals((input.openRaw || []).concat(input.wonRaw || []), ctx);
    var owners = input.owners || {}, roster = input.roster;
    var rosterByOwner = {};
    roster.aes.forEach(function (a) { rosterByOwner[String(a.hubspot_owner_id)] = a; });
    var nonRosterNotes = {};
    ((roster.non_roster_owners || {}).owners || []).forEach(function (o) { nonRosterNotes[String(o.hubspot_owner_id)] = o.reason; });

    var byOwner = {}, openByOwner = {}, wonByOwner = {};
    function bucket(oid) { if (!byOwner[oid]) byOwner[oid] = emptyMetrics_(); return byOwner[oid]; }
    cls.open.forEach(function (d) { addOpen_(bucket(d.ownerId), d); (openByOwner[d.ownerId] = openByOwner[d.ownerId] || []).push(d); });
    cls.wonYtd.forEach(function (d) { addWon_(bucket(d.ownerId), d); (wonByOwner[d.ownerId] = wonByOwner[d.ownerId] || []).push(d); });

    var flags = [];
    function flag(code, severity, message, extra) { var f = { code: code, severity: severity, message: message }; for (var k in (extra || {})) f[k] = extra[k]; flags.push(f); }

    var rows = roster.aes.map(function (a) {
      var oid = String(a.hubspot_owner_id), o = owners[oid];
      var m = byOwner[oid] ? byOwner[oid] : emptyMetrics_();
      var ownerStatus = !o ? 'unknown' : (!o.isActive ? 'inactive' : (!o.hasUserSeat ? 'no_user_seat' : 'active'));
      if (ownerStatus === 'unknown') flag('ROSTER_OWNER_UNKNOWN', 'high', a.name + ': owner ID ' + oid + ' not returned by the owners API', { ownerId: oid });
      if (ownerStatus === 'inactive') flag('ROSTER_OWNER_INACTIVE', 'high', a.name + ' is on the roster but inactive in HubSpot', { ownerId: oid });
      if (ownerStatus === 'no_user_seat') flag('ROSTER_OWNER_NO_SEAT', 'high', a.name + ' has no HubSpot user seat', { ownerId: oid });
      return { key: a.slug, name: a.name, email: a.email, role: a.role, ownerId: oid, ownerStatus: ownerStatus,
               metrics: roundMetrics_(JSON.parse(JSON.stringify(m))) };
    });

    var team = emptyMetrics_();
    roster.aes.forEach(function (a) { if (byOwner[String(a.hubspot_owner_id)]) mergeInto_(team, byOwner[String(a.hubspot_owner_id)]); });

    var nonRoster = { total: emptyMetrics_(), owners: [] };
    Object.keys(byOwner).sort().forEach(function (oid) {
      if (rosterByOwner[oid]) return;
      var o = owners[oid], m = byOwner[oid];
      var name = oid === '' ? 'Unassigned (no owner)' : (o ? o.name : 'Unknown owner ' + oid);
      var status = oid === '' ? 'unassigned' : (!o ? 'unknown' : (!o.isActive ? 'inactive' : (!o.hasUserSeat ? 'no_user_seat' : 'active')));
      mergeInto_(nonRoster.total, m);
      nonRoster.owners.push({ ownerId: oid, name: name, ownerStatus: status, reason: nonRosterNotes[oid] || 'Not on forecast roster',
                              metrics: roundMetrics_(JSON.parse(JSON.stringify(m))) });
      if (m.grossOpen.count > 0) {
        var sev = (status === 'active') ? 'medium' : 'high';
        flag('NON_ROSTER_OPEN_DEALS', sev, name + ' holds ' + m.grossOpen.count + ' open deal(s) outside the forecast roster (' + status.replace(/_/g, ' ') + ')',
             { ownerId: oid, count: m.grossOpen.count, amount: round2(m.grossOpen.amount), dealIds: (openByOwner[oid] || []).map(function (d) { return d.id; }) });
      }
      if (m.closedWonYtd.count > 0 && status !== 'active') {
        flag('NON_ACTIVE_OWNER_WON_YTD', 'medium', name + ' (' + status.replace(/_/g, ' ') + ') holds closed-won YTD counted in company total but in no AE row',
             { ownerId: oid, count: m.closedWonYtd.count, amount: round2(m.closedWonYtd.amount) });
      }
    });

    var company = emptyMetrics_(); mergeInto_(company, team); mergeInto_(company, nonRoster.total);

    function dealFlag(code, sev, label, test) {
      var ds = cls.open.filter(test);
      if (ds.length) flag(code, sev, ds.length + ' open deal(s) ' + label, { count: ds.length,
        amount: round2(ds.reduce(function (s, d) { return s + (d.amount || 0); }, 0)), amountBasis: 'gross amount of flagged deals', dealIds: ds.map(function (d) { return d.id; }) });
    }
    dealFlag('WEIGHTED_FALLBACK', 'medium', 'use amount × hs_deal_stage_probability because weighted_amount is null', function (d) { return d.weightedMethod === 'fallback'; });
    var stageMode = (input.hs.weightingMethod || 'stage_probability') === 'stage_probability';
    dealFlag('WEIGHTED_STORED_DIVERGES', stageMode ? 'low' : 'medium',
             'carry a HubSpot weighted_amount that differs from amount × stage probability' + (stageMode ? ' (weighted_amount is not used; reference only)' : ' (stored value used, per weighting rule)'),
             function (d) { return d.flags.indexOf('weighted_stored_differs_from_calc') >= 0; });
    dealFlag('WEIGHTED_UNAVAILABLE', 'high', 'have no weighted value (missing amount or stage probability); shown blank', function (d) { return d.weightedMethod === 'none'; });
    dealFlag('PAST_DUE', 'medium', 'have a close date before today', function (d) { return d.flags.indexOf('past_due') >= 0; });
    dealFlag('MISSING_AMOUNT', 'high', 'have no amount (shown blank, excluded from $ sums, counted)', function (d) { return d.flags.indexOf('missing_amount') >= 0; });
    dealFlag('MISSING_CLOSE_DATE', 'high', 'have no close date (shown blank, excluded from in-period)', function (d) { return d.flags.indexOf('missing_close_date') >= 0; });
    dealFlag('MISSING_UNITS', 'low', 'have no units__c', function (d) { return d.flags.indexOf('missing_units') >= 0; });
    dealFlag('PROB_DEVIATES', 'low', 'carry a deal probability that differs from the stage default', function (d) { return d.flags.indexOf('prob_deviates_from_stage') >= 0; });
    dealFlag('UNKNOWN_STAGE', 'high', 'sit in a stage not returned by the pipelines API', function (d) { return d.flags.indexOf('unknown_stage') >= 0; });
    var wonNull = cls.wonYtd.filter(function (d) { return d.amount === null; });
    if (wonNull.length) flag('WON_MISSING_AMOUNT', 'high', wonNull.length + ' closed-won YTD deal(s) have no amount', { count: wonNull.length, dealIds: wonNull.map(function (d) { return d.id; }) });

    return {
      asOf: input.asOf, period: per, rows: rows,
      team: roundMetrics_(team), nonRoster: { total: roundMetrics_(nonRoster.total), owners: nonRoster.owners },
      company: roundMetrics_(company),
      openDealsByOwner: openByOwner, wonYtdByOwner: wonByOwner,
      counts: { open: cls.open.length, wonYtd: cls.wonYtd.length, outOfScopeIgnored: cls.outOfScope },
      flags: flags
    };
  }

  // ------------------------------------------------------------------ tie-out
  /** Company + per-owner Closed Won YTD and Gross Open Pipeline from classified deals. */
  function summarizeForTieOut(open, wonYtd) {
    var s = { company: { cwYtd: { amount: 0, count: 0 }, grossOpen: { amount: 0, count: 0 } }, byOwner: {} };
    function o(id) { if (!s.byOwner[id]) s.byOwner[id] = { cwYtd: { amount: 0, count: 0 }, grossOpen: { amount: 0, count: 0 } }; return s.byOwner[id]; }
    open.forEach(function (d) { var a = d.amount || 0; s.company.grossOpen.amount += a; s.company.grossOpen.count++; o(d.ownerId).grossOpen.amount += a; o(d.ownerId).grossOpen.count++; });
    wonYtd.forEach(function (d) { var a = d.amount || 0; s.company.cwYtd.amount += a; s.company.cwYtd.count++; o(d.ownerId).cwYtd.amount += a; o(d.ownerId).cwYtd.count++; });
    return s;
  }

  /** Compare two summaries. Money within tolerance, counts exact. Missing side counts as 0. */
  function tieOut(primary, independent, toleranceUsd, labels) {
    var rows = [], lb = labels || {};
    function cmp(scope, measure, p, i) {
      var pa = p ? p.amount : 0, ia = i ? i.amount : 0, pc = p ? p.count : 0, ic = i ? i.count : 0;
      var da = round2(pa - ia);
      rows.push({ scope: scope, measure: measure, primaryAmount: round2(pa), independentAmount: round2(ia), deltaAmount: da,
                  primaryCount: pc, independentCount: ic, deltaCount: pc - ic,
                  ok: Math.abs(pa - ia) <= toleranceUsd + 1e-9 && pc === ic });
    }
    cmp('Company', 'Closed Won YTD', primary.company.cwYtd, independent.company.cwYtd);
    cmp('Company', 'Gross Open Pipeline', primary.company.grossOpen, independent.company.grossOpen);
    var ids = {}; Object.keys(primary.byOwner).concat(Object.keys(independent.byOwner)).forEach(function (k) { ids[k] = 1; });
    Object.keys(ids).sort().forEach(function (id) {
      var p = primary.byOwner[id], i = independent.byOwner[id], name = lb[id] || (id === '' ? 'Unassigned' : id);
      cmp(name, 'Closed Won YTD', p && p.cwYtd, i && i.cwYtd);
      cmp(name, 'Gross Open Pipeline', p && p.grossOpen, i && i.grossOpen);
    });
    var mism = rows.filter(function (r) { return !r.ok; });
    return { ok: mism.length === 0, toleranceUsd: toleranceUsd, rows: rows, mismatches: mism };
  }

  /** List deal IDs present in one population but not the other — the usual cause of a tie-out miss. */
  function diffDealSets(aDeals, bDeals) {
    var a = {}, b = {};
    aDeals.forEach(function (d) { a[d.id] = d; }); bDeals.forEach(function (d) { b[d.id] = d; });
    return {
      onlyPrimary: Object.keys(a).filter(function (k) { return !b[k]; }).map(function (k) { return a[k]; }),
      onlyIndependent: Object.keys(b).filter(function (k) { return !a[k]; }).map(function (k) { return b[k]; }),
      amountDiffers: Object.keys(a).filter(function (k) { return b[k] && (a[k].amount || 0) !== (b[k].amount || 0); })
    };
  }

  // ------------------------------------------------------------------ Section 2: Forecast Builder
  var TAGS = ['commit', 'gut', 'best_case', 'lost', 'none'];
  var TAG_LABELS = { commit: 'Commit', gut: 'Gut', best_case: 'Best Case', lost: 'Lost', none: 'None' };
  var FORECAST_TAGS = ['commit', 'gut', 'best_case'];

  function normalizeTag(t) {
    var s = String(t === null || t === undefined || t === '' ? 'none' : t).toLowerCase();
    return TAGS.indexOf(s) >= 0 ? s : null;
  }
  function tagOf_(tagMap, id) { var t = tagMap && tagMap[id]; return (t && normalizeTag(t.tag)) || 'none'; }

  /**
   * Summary bar. Honors the nesting rule: Commit = Σ commit; Gut = Commit + Σ gut; Best Case = Gut + Σ best_case.
   * Computed over ALL of the AE's open deals (not the current filter), so toggling the filter never changes totals.
   * Deals with no amount count toward tag counts but add $0, and are listed so the AE sees why.
   */
  function builderSummary(deals, tagMap, periodEnd) {
    var byTag = {};
    TAGS.forEach(function (t) { byTag[t] = { amount: 0, count: 0, nullAmountCount: 0 }; });
    var outOfPeriod = [], missingAmount = [], missingClose = [];
    (deals || []).forEach(function (d) {
      var t = tagOf_(tagMap, d.id), b = byTag[t];
      b.count++;
      if (d.amount === null) b.nullAmountCount++; else b.amount += d.amount;
      if (FORECAST_TAGS.indexOf(t) >= 0) {
        if (d.amount === null) missingAmount.push(d.id);
        if (d.closeDate === null) missingClose.push(d.id);
        else if (d.closeDate > periodEnd) outOfPeriod.push(d.id);
      }
    });
    TAGS.forEach(function (t) { byTag[t].amount = round2(byTag[t].amount); });
    var c = byTag.commit, g = byTag.gut, b = byTag.best_case;
    return {
      cumulative: {
        commit: { amount: round2(c.amount), count: c.count },
        gut: { amount: round2(c.amount + g.amount), count: c.count + g.count },
        best_case: { amount: round2(c.amount + g.amount + b.amount), count: c.count + g.count + b.count }
      },
      byTag: byTag,
      warnings: { outOfPeriodTagged: outOfPeriod, missingAmountTagged: missingAmount, missingCloseDateTagged: missingClose },
      totalDeals: (deals || []).length
    };
  }

  /** Default filter: close date on/before period end (includes past-due). Deals with no close date always show (flagged, never excluded). */
  function builderFilter(deals, showAll, periodEnd) {
    return (deals || []).filter(function (d) { return showAll || d.closeDate === null || d.closeDate <= periodEnd; });
  }

  var SORT_KEYS = ['tag', 'name', 'stage', 'amount', 'units', 'closeDate'];
  /** Sort by any column. Blanks always sort last in either direction. Ties break on name, then id. */
  function sortDeals(deals, key, dir, tagMap) {
    if (SORT_KEYS.indexOf(key) < 0) key = 'closeDate';
    var sign = dir === 'desc' ? -1 : 1;
    function val(d) {
      if (key === 'tag') return TAGS.indexOf(tagOf_(tagMap, d.id));
      if (key === 'stage') return d.stageOrder === null || d.stageOrder === undefined ? null : d.stageOrder * 100 + (d.pipeline === 'New Logo' ? 0 : 1);
      if (key === 'name') return (d.name || '').toLowerCase() || null;
      return d[key] === undefined ? null : d[key];
    }
    return (deals || []).slice().sort(function (a, b) {
      var va = val(a), vb = val(b);
      if (va === null && vb !== null) return 1;
      if (vb === null && va !== null) return -1;
      if (va !== null && vb !== null && va !== vb) return (va < vb ? -1 : 1) * sign;
      var na = (a.name || '').toLowerCase(), nb = (b.name || '').toLowerCase();
      if (na !== nb) return na < nb ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  /** Server-side guard for a save request: known tags only, deals must be the AE's currently open deals. */
  function validateTagChanges(changes, openDealIds) {
    var errors = [], clean = [], allowed = {}, seen = {};
    (openDealIds || []).forEach(function (id) { allowed[String(id)] = true; });
    if (!Array.isArray(changes)) return { ok: false, errors: ['changes must be a list'], clean: [] };
    if (changes.length > 1000) return { ok: false, errors: ['too many changes in one save (max 1000)'], clean: [] };
    changes.forEach(function (c) {
      var id = String(c && c.dealId), tag = normalizeTag(c && c.tag);
      if (!allowed[id]) errors.push('deal ' + id + ' is not one of this AE\'s open deals');
      else if (tag === null) errors.push('unknown tag "' + (c && c.tag) + '" for deal ' + id);
      else seen[id] = tag;   // last change for a deal wins
    });
    Object.keys(seen).forEach(function (id) { clean.push({ dealId: id, tag: seen[id] }); });
    return { ok: errors.length === 0, errors: errors, clean: clean };
  }

  // ------------------------------------------------------------------ Section 1: weeks, cutoff, validation, snapshots
  var DOW = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };

  /**
   * Forecast week for a submission time: the first weekly cutoff (configured; Friday 5:00 PM ET) strictly after the
   * submission. Submitting at or after the cutoff therefore lands in the NEXT week (decision 2026-09-25).
   * No holiday overrides (decision 2026-09-25).
   */
  function forecastWeekFor(ms, cutoff) {
    var wd = DOW[(cutoff && cutoff.weekday) || 'Friday'], t = (cutoff && cutoff.time_et) || '12:00';
    var p = etParts(ms), today = p.y + '-' + pad_(p.m) + '-' + pad_(p.d);
    var candidate = addDays(today, (wd - p.dow + 7) % 7);
    var cutMs = etToUtcMs(candidate, t);
    if (ms >= cutMs) { candidate = addDays(candidate, 7); cutMs = etToUtcMs(candidate, t); }
    return { forecastWeek: candidate, cutoffAtMs: cutMs, cutoffAt: etIso(cutMs), previousWeek: addDays(candidate, -7) };
  }

  /** Forecast period for a submission: from the submission date (never before Jan 1 of the week's FY) to Dec 31 of that FY. */
  function forecastPeriodFor(submissionDate, forecastWeek) {
    var fy = fiscalYearOf(forecastWeek), jan1 = fy + '-01-01';
    return { start: submissionDate < jan1 ? jan1 : submissionDate, end: fy + '-12-31', fiscalYear: fy };
  }

  /** Parse a user-entered dollar value: a number, or a string of digits with an optional leading $ and thousands commas. Anything else → NaN. */
  function parseUsd(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    var s = String(v === null || v === undefined ? '' : v).trim().replace(/^\$/, '').replace(/,/g, '');
    if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    return Number(s);
  }

  /**
   * Blocks: non-numeric, negative, more than 2 decimals, or Commit ≤ Gut ≤ Best Case violated.
   * Warns (does not block): Best Case above the AE's in-period gross open pipeline (decision 2026-09-25, Q4).
   */
  function validateForecast(values, ctx) {
    var errors = [], warnings = [], out = {};
    [['commit', 'Commit'], ['gut', 'Gut'], ['best_case', 'Best Case']].forEach(function (f) {
      var raw = values ? values[f[0]] : undefined, n = parseUsd(raw);
      if (raw === null || raw === undefined || String(raw).trim() === '') errors.push({ field: f[0], code: 'required', message: f[1] + ' is required.' });
      else if (isNaN(n)) errors.push({ field: f[0], code: 'non_numeric', message: f[1] + ' must be a number.' });
      else if (n < 0) errors.push({ field: f[0], code: 'negative', message: f[1] + ' cannot be negative.' });
      else if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) errors.push({ field: f[0], code: 'precision', message: f[1] + ' can have at most 2 decimal places.' });
      else out[f[0]] = round2(n);
    });
    if (out.commit !== undefined && out.gut !== undefined && out.commit > out.gut)
      errors.push({ field: 'commit', code: 'nesting', message: 'Commit cannot be greater than Gut. Every Commit deal is also in Gut.' });
    if (out.gut !== undefined && out.best_case !== undefined && out.gut > out.best_case)
      errors.push({ field: 'gut', code: 'nesting', message: 'Gut cannot be greater than Best Case. Every Gut deal is also in Best Case.' });
    var pipe = ctx && ctx.inPeriodPipeline;
    if (!errors.length && pipe !== null && pipe !== undefined && out.best_case > pipe)
      warnings.push({ field: 'best_case', code: 'best_case_exceeds_in_period_pipeline',
                      message: 'Best Case is above your open pipeline closing within the forecast period. You can still submit.', pipeline: round2(pipe) });
    return { ok: errors.length === 0, errors: errors, warnings: warnings, values: errors.length ? null : out };
  }

  function slugTimestamp_(iso) { return String(iso).replace(/:/g, '-'); }
  /** forecast_{week}_{slug}_{submitted_at ISO8601}.json; colons → '-' (Drive sync clients reject ':'). */
  function snapshotFileName(forecastWeek, slug, submittedAtIso) {
    return 'forecast_' + forecastWeek + '_' + slug + '_' + slugTimestamp_(submittedAtIso) + '.json';
  }

  /** Immutable snapshot (schema 1.0, docs/PHASE0_PROPOSAL.md §4). Deals list = every open deal the AE owns, incl. untagged. */
  function buildSnapshot(a) {
    var s = builderSummary(a.openDeals, a.tags, a.period.end);
    var cw = a.row.metrics.closedWonYtd.amount, v = a.values;
    return {
      schema_version: a.schemaVersion, submission_id: a.submissionId, app_version: a.appVersion || null,
      forecast_week: a.week.forecastWeek, cutoff_at: a.week.cutoffAt,
      forecast_period: { start: a.period.start, end: a.period.end },
      ae: { name: a.ae.name, email: a.ae.email, hubspot_owner_id: String(a.ae.hubspot_owner_id), slug: a.ae.slug },
      submitted_at: a.submittedAt, submitted_by_email: a.submittedBy, submitted_on_behalf: !!a.onBehalf,
      forecast: { commit: v.commit, gut: v.gut, best_case: v.best_case },
      validation: { nesting_ok: true, warnings: a.warnings.map(function (w) { return w.code; }) },
      context_at_submission: {
        data_pulled_at: a.pulledAt,
        closed_won_ytd: { amount: cw, count: a.row.metrics.closedWonYtd.count, window: [a.period.fiscalYear + '-01-01', a.asOf] },
        gross_open_pipeline: { amount: a.row.metrics.grossOpen.amount, count: a.row.metrics.grossOpen.count },
        gross_open_pipeline_in_period: { amount: a.row.metrics.grossOpenInPeriod.amount, count: a.row.metrics.grossOpenInPeriod.count },
        weighted_open_pipeline: { amount: a.row.metrics.weightedOpen.amount, method: a.weightingMethod, stage_weighted_count: a.row.metrics.weightedOpen.stageCount,
                                  unavailable_count: a.row.metrics.weightedOpen.unavailableCount },
        implied_landing: { commit: round2(cw + v.commit), gut: round2(cw + v.gut), best_case: round2(cw + v.best_case) },
        tie_out_status: a.tieOutStatus, stage_map_hash: a.stageMapSha256 || null
      },
      builder: {
        saved: !!a.tagsSavedAt, state_updated_at: a.tagsSavedAt || null,
        totals: { commit: s.cumulative.commit.amount, gut_cumulative: s.cumulative.gut.amount, best_case_cumulative: s.cumulative.best_case.amount },
        tag_counts: { commit: s.byTag.commit.count, gut: s.byTag.gut.count, best_case: s.byTag.best_case.count, lost: s.byTag.lost.count, none: s.byTag.none.count },
        deals: a.openDeals.map(function (d) {
          return { deal_id: d.id, deal_name: d.name, pipeline: d.pipelineId, stage_id: d.stageId, stage: d.stage, amount: d.amount, units: d.units,
                   close_date: d.closeDate, tag: tagOf_(a.tags, d.id),
                   tag_updated_by: (a.tags && a.tags[d.id] && a.tags[d.id].updatedBy) || null, tag_updated_at: (a.tags && a.tags[d.id] && a.tags[d.id].updatedAt) || null,
                   flags: d.flags.filter(function (f) { return ['past_due', 'missing_amount', 'missing_close_date'].indexOf(f) >= 0; }) };
        })
      }
    };
  }

  /**
   * Per (AE, week): resubmission sequence and official flag. The latest submission of a week is official
   * (every submission is by construction before its week's cutoff). Input rows need ae_slug, forecast_week, submitted_at.
   */
  function officialAssignments(rows) {
    var groups = {};
    rows.forEach(function (r, i) { var k = r.ae_slug + '|' + r.forecast_week; (groups[k] = groups[k] || []).push({ i: i, t: r.submitted_at }); });
    var out = rows.map(function () { return { seq: 0, official: false }; });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k].slice().sort(function (a, b) { return a.t < b.t ? -1 : a.t > b.t ? 1 : a.i - b.i; });
      g.forEach(function (x, n) { out[x.i] = { seq: n + 1, official: n === g.length - 1 }; });
    });
    return out;
  }

  /** Status for the current week: not_submitted / submitted / resubmitted. */
  function submissionStatus(rows, slug, week) {
    var n = rows.filter(function (r) { return r.ae_slug === slug && r.forecast_week === week; }).length;
    return n === 0 ? 'not_submitted' : n === 1 ? 'submitted' : 'resubmitted';
  }

  function latestFor_(rows, slug, week, officialOnly) {
    var c = rows.filter(function (r) { return r.ae_slug === slug && r.forecast_week === week && (!officialOnly || r.is_official); });
    c.sort(function (a, b) { return a.submitted_at < b.submitted_at ? 1 : -1; });
    return c[0] || null;
  }
  function delta_(cur, prev) {
    if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
    return { amount: round2(cur - prev), pct: prev === 0 ? null : (cur - prev) / prev };
  }

  /**
   * Section 1 row model for one AE: this week's latest submission (never carried forward), last week's official
   * submission, WoW deltas, status, implied landing (live Closed Won YTD + this week's Gut).
   */
  function sectionOneRow(metricsRow, subRows, week) {
    var slug = metricsRow.key, cur = latestFor_(subRows, slug, week.forecastWeek, false), prev = latestFor_(subRows, slug, week.previousWeek, true);
    var f = function (r, k) { return r ? r[k] : null; };
    var fields = {};
    ['commit', 'gut', 'best_case'].forEach(function (k) {
      fields[k] = { current: f(cur, k), lastWeek: f(prev, k), delta: delta_(f(cur, k), f(prev, k)) };
    });
    var cw = metricsRow.metrics.closedWonYtd.amount;
    return {
      key: slug, name: metricsRow.name, role: metricsRow.role, ownerStatus: metricsRow.ownerStatus, metrics: metricsRow.metrics,
      forecast: fields, lastSubmittedAt: cur ? cur.submitted_at : null, status: submissionStatus(subRows, slug, week.forecastWeek),
      submissionsThisWeek: subRows.filter(function (r) { return r.ae_slug === slug && r.forecast_week === week.forecastWeek; }).length,
      impliedLanding: cur ? round2(cw + cur.gut) : null
    };
  }

  /**
   * Team Total forecast: sum of this week's latest submissions from roster AEs that have submitted (count reported).
   * The week-over-week delta is like-for-like: only AEs with both this week's and last week's official submission,
   * so a missing submission never shows up as a forecast drop.
   */
  function sectionOneTeam(rows) {
    var keys = ['commit', 'gut', 'best_case'], t = { aeCount: rows.length, submittedCount: 0, lastWeekCount: 0, likeForLikeCount: 0 };
    keys.forEach(function (k) { t[k] = { current: null, lastWeek: null, delta: null }; });
    var cur = {}, prev = {}, bothCur = {}, bothPrev = {};
    keys.forEach(function (k) { cur[k] = 0; prev[k] = 0; bothCur[k] = 0; bothPrev[k] = 0; });
    rows.forEach(function (r) {
      var hasCur = r.forecast.commit.current !== null, hasPrev = r.forecast.commit.lastWeek !== null;
      if (hasCur) t.submittedCount++;
      if (hasPrev) t.lastWeekCount++;
      if (hasCur && hasPrev) t.likeForLikeCount++;
      keys.forEach(function (k) {
        if (hasCur) cur[k] += r.forecast[k].current;
        if (hasPrev) prev[k] += r.forecast[k].lastWeek;
        if (hasCur && hasPrev) { bothCur[k] += r.forecast[k].current; bothPrev[k] += r.forecast[k].lastWeek; }
      });
    });
    keys.forEach(function (k) {
      if (t.submittedCount) t[k].current = round2(cur[k]);
      if (t.lastWeekCount) t[k].lastWeek = round2(prev[k]);
      if (t.likeForLikeCount) t[k].delta = delta_(round2(bothCur[k]), round2(bothPrev[k]));
    });
    return t;
  }

  // ------------------------------------------------------------------ Section 3: trend, change table, movement
  var VALUE_KEYS = ['commit', 'gut', 'best_case'];

  /** Every Friday from the first to the last week, inclusive (so a missing week is an explicit gap). */
  function weekAxis(firstWeek, lastWeek) {
    var out = [], w = firstWeek;
    while (w <= lastWeek && out.length < 60) { out.push(w); w = addDays(w, 7); }
    return out;
  }

  /**
   * Trend series from rollup rows (one per submission).
   * Official points only; a week without an official submission is null (a gap), never zero, never carried forward.
   * mode 'implied_landing' adds the snapshot's own Closed Won YTD to each value; 'incremental' plots raw values.
   * Team = sum over AEs who submitted that week, with coverage reported (n of N) so partial weeks are visible.
   */
  function trendSeries(rows, aes, opts) {
    opts = opts || {};
    var mode = opts.mode || 'implied_landing';
    var official = rows.filter(function (r) { return r.is_official; });
    var weeks = official.map(function (r) { return r.forecast_week; }).sort();
    if (opts.throughWeek && weeks.length && opts.throughWeek > weeks[weeks.length - 1]) weeks.push(opts.throughWeek);
    var axis = weeks.length ? weekAxis(weeks[0], weeks[weeks.length - 1]) : [];
    function val(r, k) { if (!r) return null; var cw = r.closed_won_ytd || 0; return k === 'closed_won_ytd' ? cw : (mode === 'implied_landing' ? round2(cw + r[k]) : r[k]); }
    var byAe = {};
    aes.forEach(function (a) {
      var pts = axis.map(function (w, i) {
        var off = official.filter(function (r) { return r.ae_slug === a.slug && r.forecast_week === w; })[0] || null;
        var all = rows.filter(function (r) { return r.ae_slug === a.slug && r.forecast_week === w; });
        var p = { week: w, submitted: !!off, submittedAt: off ? off.submitted_at : null, submissions: all.length, resubmissions: Math.max(0, all.length - 1),
                  overlay: all.filter(function (r) { return !r.is_official; }).map(function (r) {
                    var o = { submittedAt: r.submitted_at }; VALUE_KEYS.forEach(function (k) { o[k] = val(r, k); }); return o; }) };
        VALUE_KEYS.concat(['closed_won_ytd']).forEach(function (k) { p[k] = val(off, k); });
        return p;
      });
      pts.forEach(function (p, i) {
        var prev = i > 0 ? pts[i - 1] : null;
        p.wow = {};
        VALUE_KEYS.forEach(function (k) { p.wow[k] = prev && p[k] !== null && prev[k] !== null ? round2(p[k] - prev[k]) : null; });
      });
      byAe[a.slug] = pts;
    });
    var team = axis.map(function (w, i) {
      var p = { week: w, coverage: 0, aeCount: aes.length, submissions: 0, resubmissions: 0 };
      VALUE_KEYS.concat(['closed_won_ytd']).forEach(function (k) { p[k] = 0; });
      aes.forEach(function (a) {
        var x = byAe[a.slug][i];
        p.submissions += x.submissions; p.resubmissions += x.resubmissions;
        if (x.submitted) { p.coverage++; VALUE_KEYS.concat(['closed_won_ytd']).forEach(function (k) { p[k] += x[k]; }); }
      });
      if (!p.coverage) VALUE_KEYS.concat(['closed_won_ytd']).forEach(function (k) { p[k] = null; });
      else VALUE_KEYS.concat(['closed_won_ytd']).forEach(function (k) { p[k] = round2(p[k]); });
      p.submitted = p.coverage > 0; p.complete = p.coverage === aes.length;
      return p;
    });
    team.forEach(function (p, i) {
      var prev = i > 0 ? team[i - 1] : null; p.wow = {};
      VALUE_KEYS.forEach(function (k) { p.wow[k] = prev && p[k] !== null && prev[k] !== null && p.complete && prev.complete ? round2(p[k] - prev[k]) : null; });
    });
    var weeksWithData = axis.filter(function (w, i) { return team[i].submitted; }).length;
    var max = 0;
    Object.keys(byAe).forEach(function (s) { byAe[s].forEach(function (p) { VALUE_KEYS.concat(['closed_won_ytd']).forEach(function (k) { if (p[k] !== null && p[k] > max) max = p[k]; }); }); });
    return { mode: mode, weeks: axis, byAe: byAe, team: team, weeksWithData: weeksWithData, sharedAeMax: max,
             trendAvailable: weeksWithData >= 2 };
  }

  /**
   * Change table for a report week vs the week before (official submissions only).
   * Highlight when |Δ%| exceeds the threshold, or when the prior value was 0 and the current one is not.
   * Team uses like-for-like AEs (both weeks) for its deltas, like Section 1.
   */
  function changeTable(rows, aes, reportWeek, threshold) {
    var prevWeek = addDays(reportWeek, -7);
    var off = function (slug, w) { return rows.filter(function (r) { return r.is_official && r.ae_slug === slug && r.forecast_week === w; })[0] || null; };
    function cells(cur, prev) {
      var o = {};
      VALUE_KEYS.forEach(function (k) {
        var c = cur ? cur[k] : null, p = prev ? prev[k] : null;
        var d = c !== null && p !== null ? round2(c - p) : null, pct = d !== null && p !== 0 ? d / p : null;
        o[k] = { current: c, prior: p, delta: d, pct: pct,
                 highlight: d !== null && ((pct !== null && Math.abs(pct) > threshold + 1e-12) || (p === 0 && c !== 0)) };
      });
      return o;
    }
    var aeRows = aes.map(function (a) {
      var cur = off(a.slug, reportWeek), prev = off(a.slug, prevWeek);
      return { key: a.slug, name: a.name, submittedCurrent: !!cur, submittedPrior: !!prev, values: cells(cur, prev) };
    });
    var both = aeRows.filter(function (r) { return r.submittedCurrent && r.submittedPrior; });
    var sum = function (list, which, k) { return list.length ? round2(list.reduce(function (s, r) { return s + r.values[k][which]; }, 0)) : null; };
    var teamVals = {};
    VALUE_KEYS.forEach(function (k) {
      var c = sum(aeRows.filter(function (r) { return r.submittedCurrent; }), 'current', k);
      var p = sum(aeRows.filter(function (r) { return r.submittedPrior; }), 'prior', k);
      var lc = sum(both, 'current', k), lp = sum(both, 'prior', k);
      var d = both.length ? round2(lc - lp) : null, pct = d !== null && lp !== 0 ? d / lp : null;
      teamVals[k] = { current: c, prior: p, delta: d, pct: pct, likeForLike: both.length,
                      highlight: d !== null && ((pct !== null && Math.abs(pct) > threshold + 1e-12) || (lp === 0 && lc !== 0)) };
    });
    return { reportWeek: reportWeek, priorWeek: prevWeek, threshold: threshold, rows: aeRows,
             team: { values: teamVals, submittedCurrent: aeRows.filter(function (r) { return r.submittedCurrent; }).length,
                     submittedPrior: aeRows.filter(function (r) { return r.submittedPrior; }).length, likeForLike: both.length, aeCount: aes.length } };
  }

  /** Report week for the Monday review: the most recent week whose cutoff has passed, unless only the open week has data. */
  function defaultReportWeek(rows, nowWeek) {
    var closed = addDays(nowWeek, -7);
    var weeks = rows.filter(function (r) { return r.is_official; }).map(function (r) { return r.forecast_week; });
    if (weeks.some(function (w) { return w <= closed; })) return weeks.filter(function (w) { return w <= closed; }).sort().pop();
    return weeks.length ? weeks.sort().pop() : nowWeek;
  }

  /** Last cutoff weekday (Friday) on or before Dec 31 of a year: the final forecast week of that FY. */
  function lastWeekOfYear(year, cutoff) {
    var wd = DOW[(cutoff && cutoff.weekday) || 'Friday'], dec31 = year + '-12-31';
    var dow = new Date(Date.UTC(year, 11, 31)).getUTCDay();
    return addDays(dec31, -((dow - wd + 7) % 7));
  }

  /**
   * Year-rollover readiness. From December 1, if next year's Drive folder is not configured, returns a warning:
   * submissions for next year's first week start at the cutoff of this year's last forecast week (they are blocked
   * without the folder), and from Jan 1 the data refresh itself needs the folder. Returns null when nothing is due.
   */
  function rolloverStatus(todayIso, foldersByFy, cutoff) {
    var y = fiscalYearOf(todayIso), next = y + 1;
    if (todayIso.slice(5) < '12-01' || (foldersByFy && foldersByFy[String(next)])) return null;
    var lastWeek = lastWeekOfYear(y, cutoff);
    return { nextFiscalYear: next, blocksSubmissionsAt: etIso(etToUtcMs(lastWeek, (cutoff && cutoff.time_et) || '12:00')),
             blocksAppAt: next + '-01-01', message: 'No Drive folder is configured for FY' + next + '. Submissions for the week of ' + addDays(lastWeek, 7) +
             ' are blocked from ' + lastWeek + ' ' + ((cutoff && cutoff.time_et) || '12:00') + ' ET, and data refresh stops on ' + next + '-01-01. Add it to config/forecast.json drive.folders_by_fiscal_year, then npm run build and clasp push.' };
  }

  var LEVEL_MEMBERS = { commit: ['commit'], gut: ['commit', 'gut'], best_case: ['commit', 'gut', 'best_case'] };

  /**
   * Forecast movement between two snapshots of the same AE (prior → current), from their builder tags.
   * Lists deals added to / removed from each tag, tag changes (with before/after amounts), deals that left or
   * joined the open pipeline, and reconciles tag movement against the submitted $ change for each nested value.
   * Any unexplained difference is reported, never hidden. If either week saved no builder tags, no movement is inferred.
   */
  function movementDrilldown(prev, cur) {
    var out = { priorWeek: prev ? prev.forecast_week : null, currentWeek: cur ? cur.forecast_week : null };
    if (!prev || !cur) { out.status = 'missing_snapshot'; out.message = !prev ? 'No official submission the prior week to compare against.' : 'No official submission this week.'; return out; }
    var ps = prev.builder && prev.builder.saved, cs = cur.builder && cur.builder.saved;
    if (!ps || !cs) {
      out.status = 'no_builder_tags';
      out.message = (!cs && !ps ? 'No Forecast Builder tags were saved in either week' : !cs ? 'No Forecast Builder tags were saved this week' : 'No Forecast Builder tags were saved the prior week') +
                    '. Deal movement is not inferred.';
      out.submittedDelta = {}; VALUE_KEYS.forEach(function (k) { out.submittedDelta[k] = round2(cur.forecast[k] - prev.forecast[k]); });
      return out;
    }
    var P = {}, Cm = {};
    prev.builder.deals.forEach(function (d) { P[d.deal_id] = d; });
    cur.builder.deals.forEach(function (d) { Cm[d.deal_id] = d; });
    var ids = {}; Object.keys(P).concat(Object.keys(Cm)).forEach(function (k) { ids[k] = 1; });
    var added = {}, removed = {}; TAGS.forEach(function (t) { added[t] = []; removed[t] = []; });
    var changed = [], leftPipeline = [], joinedPipeline = [], amountChanges = [];
    Object.keys(ids).sort().forEach(function (id) {
      var a = P[id], b = Cm[id], ta = a ? (a.tag || 'none') : null, tb = b ? (b.tag || 'none') : null;
      var base = { deal_id: id, deal_name: (b || a).deal_name, before: a ? { tag: ta, amount: a.amount, stage: a.stage } : null, after: b ? { tag: tb, amount: b.amount, stage: b.stage } : null };
      if (a && !b) { leftPipeline.push(base); if (ta !== 'none') removed[ta].push(base); return; }
      if (!a && b) { joinedPipeline.push(base); if (tb !== 'none') added[tb].push(base); return; }
      if (ta !== tb) { changed.push(base); if (ta !== 'none') removed[ta].push(base); if (tb !== 'none') added[tb].push(base); }
      else if ((a.amount || 0) !== (b.amount || 0) && ta !== 'none') amountChanges.push(base);
    });
    var recon = {};
    VALUE_KEYS.forEach(function (k) {
      var m = LEVEL_MEMBERS[k], r = { entered: 0, exited: 0, amountChange: 0, byCategory: { retaggedIn: 0, retaggedOut: 0, joinedPipeline: 0, leftPipeline: 0 } };
      Object.keys(ids).forEach(function (id) {
        var a = P[id], b = Cm[id], inA = !!a && m.indexOf(a.tag || 'none') >= 0, inB = !!b && m.indexOf(b.tag || 'none') >= 0;
        var aa = a ? (a.amount || 0) : 0, bb = b ? (b.amount || 0) : 0;
        if (inB && !inA) { r.entered += bb; r.byCategory[a ? 'retaggedIn' : 'joinedPipeline'] += bb; }
        else if (inA && !inB) { r.exited -= aa; r.byCategory[b ? 'retaggedOut' : 'leftPipeline'] -= aa; }
        else if (inA && inB) r.amountChange += bb - aa;
      });
      var builderPrev = k === 'commit' ? prev.builder.totals.commit : k === 'gut' ? prev.builder.totals.gut_cumulative : prev.builder.totals.best_case_cumulative;
      var builderCur = k === 'commit' ? cur.builder.totals.commit : k === 'gut' ? cur.builder.totals.gut_cumulative : cur.builder.totals.best_case_cumulative;
      var explained = round2(r.entered + r.exited + r.amountChange);
      var submittedDelta = round2(cur.forecast[k] - prev.forecast[k]);
      var unexplained = round2(submittedDelta - explained);
      recon[k] = { submittedPrior: prev.forecast[k], submittedCurrent: cur.forecast[k], submittedDelta: submittedDelta,
                   builderPrior: builderPrev, builderCurrent: builderCur, tagMovement: explained,
                   entered: round2(r.entered), exited: round2(r.exited), amountChange: round2(r.amountChange),
                   byCategory: { retaggedIn: round2(r.byCategory.retaggedIn), retaggedOut: round2(r.byCategory.retaggedOut),
                                 joinedPipeline: round2(r.byCategory.joinedPipeline), leftPipeline: round2(r.byCategory.leftPipeline) },
                   unexplained: unexplained, reconciles: Math.abs(unexplained) <= 0.01 };
    });
    out.status = 'ok'; out.added = added; out.removed = removed; out.changed = changed; out.leftPipeline = leftPipeline;
    out.joinedPipeline = joinedPipeline; out.amountChanges = amountChanges; out.reconciliation = recon;
    out.allReconcile = VALUE_KEYS.every(function (k) { return recon[k].reconciles; });
    return out;
  }

  /**
   * Deterministic synthetic history for TEST MODE ONLY (Phase 4 verification): per AE, a few weeks of official
   * submissions with builder tags drawn from their real open deals. Scenarios are chosen to exercise the trend rules:
   * a missing week (gap), intra-week resubmissions, a week with no builder tags, and one week whose submitted change
   * deliberately does not reconcile to tag movement.
   */
  function syntheticHistory(aes, openDealsByOwner, weeks, cwYtdByOwner) {
    var out = [], seedTimes = ['T10:15:00.000-04:00', 'T11:05:00.000-04:00'];
    var plan = {
      'phil-aroian': { skip: [], resub: [], noTags: [], mismatch: [], drift: [0, 0.04, 0.06, 0.02] },
      'spencer-wuthrich': { skip: [1], resub: [], noTags: [], mismatch: [], drift: [0, 0, 0.05, 0.05] },
      'ian-mclaughlin': { skip: [], resub: [2, 3], noTags: [], mismatch: [], drift: [0, 0.1, 0.15, 0.2] },
      'ben-de-winter': { skip: [], resub: [], noTags: [2], mismatch: [], drift: [0, -0.1, -0.2, -0.3] },
      'matt-lynch': { skip: [], resub: [1], noTags: [], mismatch: [3], drift: [0, 0.05, 0.25, 0.4] }
    };
    aes.forEach(function (a, ai) {
      var pl = plan[a.slug] || { skip: [], resub: [], noTags: [], mismatch: [], drift: [0, 0, 0, 0] };
      var deals = (openDealsByOwner[String(a.hubspot_owner_id)] || []).slice().sort(function (x, y) { return (x.amount || 0) - (y.amount || 0); });
      weeks.forEach(function (w, wi) {
        if (pl.skip.indexOf(wi) >= 0) return;
        // Tag the deals in bands; the bands shift a little each week so tags move between weeks.
        var n = deals.length, shift = wi % Math.max(1, n);
        var tags = {};
        deals.forEach(function (d, i) {
          var j = (i + shift) % Math.max(1, n);
          tags[d.id] = { tag: j < Math.ceil(n * 0.15) ? 'commit' : j < Math.ceil(n * 0.3) ? 'gut' : j < Math.ceil(n * 0.5) ? 'best_case' : j < Math.ceil(n * 0.6) ? 'lost' : 'none' };
        });
        var s = builderSummary(deals, tags, fiscalYearOf(w) + '-12-31');
        var saved = pl.noTags.indexOf(wi) < 0;
        var v = { commit: s.cumulative.commit.amount, gut: s.cumulative.gut.amount, best_case: s.cumulative.best_case.amount };
        if (!saved || pl.mismatch.indexOf(wi) >= 0) { var f = 1 + pl.drift[wi % pl.drift.length]; v = { commit: round2(v.commit * f), gut: round2(v.gut * f), best_case: round2(v.best_case * f) }; }
        var cw = round2((cwYtdByOwner[String(a.hubspot_owner_id)] || 0) * (0.7 + 0.1 * wi));
        var times = pl.resub.indexOf(wi) >= 0 ? seedTimes : [seedTimes[1]];
        times.forEach(function (t, ti) {
          var date = addDays(w, -1), submittedAt = date + t, last = ti === times.length - 1;
          var vals = last ? v : { commit: round2(v.commit * 0.9), gut: round2(v.gut * 0.9), best_case: round2(v.best_case * 0.9) };
          out.push({ ae: a, week: w, submittedAt: submittedAt, values: vals, closedWonYtd: cw, deals: deals, tags: saved ? tags : {}, saved: saved,
                     isOfficial: last, seq: ti + 1, scenario: { skip: false, noTags: !saved, mismatch: pl.mismatch.indexOf(wi) >= 0, resub: times.length > 1 } });
        });
      });
    });
    return out;
  }

  return {
    weekAxis: weekAxis, trendSeries: trendSeries, changeTable: changeTable, defaultReportWeek: defaultReportWeek,
    movementDrilldown: movementDrilldown, syntheticHistory: syntheticHistory, lastWeekOfYear: lastWeekOfYear, rolloverStatus: rolloverStatus,
    DOW: DOW, forecastWeekFor: forecastWeekFor, forecastPeriodFor: forecastPeriodFor, parseUsd: parseUsd,
    validateForecast: validateForecast, snapshotFileName: snapshotFileName, buildSnapshot: buildSnapshot,
    officialAssignments: officialAssignments, submissionStatus: submissionStatus, sectionOneRow: sectionOneRow, sectionOneTeam: sectionOneTeam,
    TAGS: TAGS, TAG_LABELS: TAG_LABELS, FORECAST_TAGS: FORECAST_TAGS, normalizeTag: normalizeTag,
    builderSummary: builderSummary, builderFilter: builderFilter, sortDeals: sortDeals,
    validateTagChanges: validateTagChanges,
    num: num, round2: round2, etOffsetMinutes: etOffsetMinutes, etParts: etParts, etDate: etDate, etIso: etIso,
    etToUtcMs: etToUtcMs, addDays: addDays, fiscalYearOf: fiscalYearOf, periodFor: periodFor,
    buildStageMap: buildStageMap, normalizeOwners: normalizeOwners, resolveViewer: resolveViewer, submittableSlugs: submittableSlugs, dealUrl: dealUrl,
    ACCESS_LEVELS: ACCESS_LEVELS, ACCESS_LABELS: ACCESS_LABELS, activeRoster: activeRoster, rosterUsers: rosterUsers, applyRosterChange: applyRosterChange, mergeFolders: mergeFolders, inviteMessage: inviteMessage,
    deriveOpenDeal: deriveOpenDeal, deriveWonDeal: deriveWonDeal, classifyDeals: classifyDeals,
    computeMetrics: computeMetrics, summarizeForTieOut: summarizeForTieOut, tieOut: tieOut, diffDealSets: diffDealSets
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ForecastCore;
