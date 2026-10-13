/**
 * Admin panel (decision P6-1). Any admin (Will, Brian, Phil) can manage users and settings.
 *
 * Runtime roster: Script Property ROSTER_JSON holds the live roster, edited from the panel. Until the first panel
 * change it is absent and config/roster.json (FORECAST_CONFIG.roster) is used as the seed. After that, the panel is the
 * source of truth for people; config/roster.json only seeds a brand-new deployment.
 * Runtime folders: Script Property FY_FOLDERS_JSON holds Drive folder IDs added in the panel (year rollover). Folders in
 * config/forecast.json always win for the same year.
 * Every change is appended to the rollup's admin_log tab (who, what, when, before/after).
 * Rules for who may be changed live in ForecastCore.applyRosterChange (pure, Node-tested).
 */
var ROSTER_PROP_ = 'ROSTER_JSON';
var FOLDERS_PROP_ = 'FY_FOLDERS_JSON';
var ROSTER_MEMO_ = null;

/** Full roster, active and inactive. */
function roster_() {
  if (ROSTER_MEMO_) return ROSTER_MEMO_;
  var raw = PropertiesService.getScriptProperties().getProperty(ROSTER_PROP_);
  ROSTER_MEMO_ = raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(FORECAST_CONFIG.roster));
  return ROSTER_MEMO_;
}
/** Roster as the app runs it: active people only; deactivated AEs become "Other owners". */
function runtimeRoster_() { return ForecastCore.activeRoster(roster_()); }
function rosterSource_() { return PropertiesService.getScriptProperties().getProperty(ROSTER_PROP_) ? 'admin_panel' : 'config'; }

function saveRoster_(r) {
  r.version = 'panel ' + ForecastCore.etIso(Date.now());
  var body = JSON.stringify(r);
  if (body.length > 8500) throw new Error('The roster is too large to store (' + body.length + ' bytes). Ask Will to move it to a Sheet.');
  PropertiesService.getScriptProperties().setProperty(ROSTER_PROP_, body);
  ROSTER_MEMO_ = null;
}

function panelFolders_() {
  var raw = PropertiesService.getScriptProperties().getProperty(FOLDERS_PROP_);
  return raw ? JSON.parse(raw) : {};
}
/** Drive folder per fiscal year: config/forecast.json plus years added in the admin panel. */
function foldersByFy_() { return ForecastCore.mergeFolders(FORECAST_CONFIG.forecast.drive.folders_by_fiscal_year, panelFolders_()); }

function requireAdmin_() {
  var v = currentViewer_();
  if (!v.isAdmin) throw new Error('Admins only.');
  return v;
}

function appendAdminLog_(actor, res) {
  withScriptLock_(function () {
    getRollup_(ForecastCore.fiscalYearOf(todayEt_())).getSheetByName('admin_log').appendRow([
      ForecastCore.etIso(Date.now()), actor, res.action, String(res.target || ''), res.summary || '',
      res.before ? JSON.stringify(res.before) : '', res.after ? JSON.stringify(res.after) : ''
    ]);
  }, 'Busy; try again in a few seconds.');
}

function readAdminLog_(limit) {
  try {
    var v = getRollup_(ForecastCore.fiscalYearOf(todayEt_())).getSheetByName('admin_log').getDataRange().getValues();
    return v.slice(1).reverse().slice(0, limit || 50).map(function (r) {
      return { at: String(r[0]), actor: r[1], action: r[2], target: String(r[3]), summary: r[4] };
    });
  } catch (e) { return []; }
}

function readBuildLog_(limit) {
  try {
    var v = getRollup_(ForecastCore.fiscalYearOf(todayEt_())).getSheetByName('build_log').getDataRange().getValues();
    return v.slice(1).reverse().slice(0, limit || 10).map(function (r) {
      return { at: String(r[0]), status: r[1], openCount: r[4], wonYtdCount: r[5], tieOut: r[10], message: String(r[11] || '').slice(0, 300) };
    });
  } catch (e) { return []; }
}

function appUrl_() { try { return ScriptApp.getService().getUrl() || null; } catch (e) { return null; } }

function triggerInstalled_() {
  try { return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'refreshDataTrigger'; }); }
  catch (e) { return null; }
}

/** Everything the admin panel shows. */
function apiAdminGet() {
  var v = requireAdmin_(), cfg = FORECAST_CONFIG, r = roster_(), ds = getDataset_(false), m = ds.metrics;
  var owners = ds.owners || {};
  var assigned = {};
  r.aes.forEach(function (a) { assigned[String(a.hubspot_owner_id)] = a.name + (a.active === false ? ' (inactive)' : ''); });
  var ownerList = Object.keys(owners).map(function (id) {
    var o = owners[id];
    return { id: id, name: o.name, email: o.email, status: !o.isActive ? 'inactive' : (!o.hasUserSeat ? 'no_user_seat' : 'active'), assignedTo: assigned[id] || null };
  }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  var nrMetrics = {};
  (m.nonRoster.owners || []).forEach(function (o) { nrMetrics[o.ownerId] = o; });
  var nonRoster = ((r.non_roster_owners || {}).owners || []).map(function (o) {
    var x = nrMetrics[String(o.hubspot_owner_id)];
    return { ownerId: String(o.hubspot_owner_id), name: o.name, reason: o.reason,
             openCount: x ? x.metrics.grossOpen.count : 0, openAmount: x ? x.metrics.grossOpen.amount : 0, wonYtdAmount: x ? x.metrics.closedWonYtd.amount : 0 };
  });
  var unlisted = (m.nonRoster.owners || []).filter(function (o) { return !nonRoster.some(function (n) { return n.ownerId === o.ownerId; }); })
    .map(function (o) { return { ownerId: o.ownerId, name: o.name, reason: o.reason, openCount: o.metrics.grossOpen.count, openAmount: o.metrics.grossOpen.amount }; });

  var week = ForecastCore.forecastWeekFor(nowMs_(), cfg.forecast.cutoff);
  var subs = submissionsForWeek_(week);
  var thisWeek = m.rows.map(function (row) {
    var s = ForecastCore.sectionOneRow(row, subs, week);
    return { slug: s.key, name: s.name, status: s.status, lastSubmittedAt: s.lastSubmittedAt, submissions: s.submissionsThisWeek };
  });

  var folders = foldersByFy_(), panel = panelFolders_();
  var years = Object.keys(folders).sort().map(function (y) {
    return { year: Number(y), folderId: folders[y], source: cfg.forecast.drive.folders_by_fiscal_year[y] ? 'config' : 'admin_panel' };
  });
  var curFy = ForecastCore.fiscalYearOf(todayEt_());
  return JSON.parse(JSON.stringify({
    viewer: viewerOut_(v), testMode: isTestMode_(), rosterSource: rosterSource_(),
    accessLevels: ForecastCore.ACCESS_LEVELS.map(function (k) { return { key: k, label: ForecastCore.ACCESS_LABELS[k] }; }),
    users: ForecastCore.rosterUsers(r, owners), owners: ownerList,
    nonRoster: nonRoster, unlistedOwners: unlisted,
    thisWeek: { forecastWeek: week.forecastWeek, cutoffAt: week.cutoffAt, rows: thisWeek },
    health: { pulledAt: ds.pulledAt, asOf: ds.asOf, tieOut: ds.tieOut ? { ok: ds.tieOut.ok, mismatches: ds.tieOut.mismatches.length } : null,
              flags: m.flags.map(function (f) { return { severity: f.severity, message: f.message }; }),
              triggerInstalled: triggerInstalled_(), refreshMinutes: cfg.forecast.data_refresh_minutes, buildLog: readBuildLog_(10),
              config: cfg.generatedFrom, appUrl: appUrl_() },
    folders: { years: years, currentFy: curFy, nextFy: curFy + 1, rollover: ForecastCore.rolloverStatus(todayEt_(), folders, cfg.forecast.cutoff),
               panelYears: Object.keys(panel) },
    settings: { cutoff: cfg.forecast.cutoff, threshold: cfg.forecast.section3.delta_threshold_pct, schemaVersion: cfg.forecast.schema_version,
                docsUrl: cfg.forecast.docs_url || null, timezone: cfg.timezone },
    audit: readAdminLog_(50)
  }));
}

/**
 * Apply one user or Other-owners change (see ForecastCore.applyRosterChange), log it, optionally email an invite,
 * then re-pull HubSpot so every section reflects the new roster.
 */
function apiAdminChange(change, opts) {
  var v = requireAdmin_();
  opts = opts || {};
  var owners = getDataset_(false).owners || {};
  var res = withScriptLock_(function () {
    ROSTER_MEMO_ = null;
    var out = ForecastCore.applyRosterChange(roster_(), change, { owners: owners, now: ForecastCore.etIso(nowMs_()), actor: v.email });
    saveRoster_(out.roster);
    return out;
  }, 'Another admin change is being saved. Try again in a few seconds.');
  // The change is saved at this point. Anything below that fails is reported, not thrown, so the admin never sees
  // "Not saved" for a change that was in fact saved.
  var emailNote = null;
  if (res.action === 'invite' && opts.sendInvite !== false) {
    try { emailNote = sendInvite_(v, String(change.email).toLowerCase()); }
    catch (e) { emailNote = 'invite email FAILED (' + e.message + '); use Resend invite'; }
  }
  if (emailNote) res.summary += '; ' + emailNote;
  appendAdminLog_(v.email, res);
  try { pullData_(); }
  catch (e) { res.summary += '. Saved, but the HubSpot refresh failed (' + e.message + '); figures update at the next scheduled refresh'; }
  return JSON.parse(JSON.stringify({ result: { summary: res.summary, email: emailNote }, panel: apiAdminGet() }));
}

function apiAdminResendInvite(email) {
  var v = requireAdmin_();
  var note = sendInvite_(v, String(email).toLowerCase());
  appendAdminLog_(v.email, { action: 'resend_invite', target: email, summary: note });
  return JSON.parse(JSON.stringify({ result: { summary: note }, panel: apiAdminGet() }));
}

/** Email the invite from the script owner's account. Returns a short note for the log. Never sends in test mode. */
function sendInvite_(actor, email) {
  var u = ForecastCore.rosterUsers(roster_(), {}).filter(function (x) { return x.email.toLowerCase() === email && x.active; })[0];
  if (!u) throw new Error(email + ' is not an active user.');
  if (isTestMode_()) return 'invite email not sent (test mode)';
  var url = appUrl_(), docs = FORECAST_CONFIG.forecast.docs_url || null, cutoff = FORECAST_CONFIG.forecast.cutoff;
  var msg = ForecastCore.inviteMessage({ name: u.name, access: u.access, admin: u.admin, appUrl: url, docsUrl: docs, invitedBy: actor.name, cutoff: cutoff });
  MailApp.sendEmail({ to: email, subject: msg.subject, body: msg.text, htmlBody: msg.html, name: 'Findigs Sales Forecast', replyTo: actor.email });
  return 'invite emailed to ' + email;
}

/** Year rollover: add a Drive folder for a fiscal year that has none. Existing years can't be changed from here. */
function apiAdminSetFolder(year, folderId) {
  var v = requireAdmin_();
  year = Number(year); folderId = String(folderId || '').trim().replace(/^.*\/folders\//, '').replace(/[?#].*$/, '');
  var cur = ForecastCore.fiscalYearOf(todayEt_());
  if (!(year >= cur && year <= cur + 1)) throw new Error('You can add a folder for FY' + cur + ' or FY' + (cur + 1) + ' only.');
  if (!/^[A-Za-z0-9_-]{20,}$/.test(folderId)) throw new Error('Paste the Drive folder link or ID.');
  var folders = foldersByFy_();
  if (folders[String(year)]) throw new Error('FY' + year + ' already has a folder. Changing it needs a code change, so existing snapshots are never orphaned.');
  if (Object.keys(folders).some(function (y) { return folders[y] === folderId; }) || folderId === FORECAST_CONFIG.forecast.drive.test_folder_id)
    throw new Error('That folder is already used for another year or for test mode.');
  var name;
  try { name = DriveApp.getFolderById(folderId).getName(); }
  catch (e) { throw new Error('The app can\'t open that folder. Check the ID and that the script owner has access.'); }
  withScriptLock_(function () {
    var p = panelFolders_(); p[String(year)] = folderId;
    PropertiesService.getScriptProperties().setProperty(FOLDERS_PROP_, JSON.stringify(p));
  }, 'Busy; try again in a few seconds.');
  appendAdminLog_(v.email, { action: 'set_folder', target: 'FY' + year, summary: 'Set FY' + year + ' Drive folder to "' + name + '" (' + folderId + ')', after: { year: year, folderId: folderId, name: name } });
  return JSON.parse(JSON.stringify({ result: { summary: 'FY' + year + ' folder set to "' + name + '".' }, panel: apiAdminGet() }));
}

function apiAdminRefresh() {
  var v = requireAdmin_();
  var ds = pullData_();
  appendAdminLog_(v.email, { action: 'refresh', target: '', summary: 'Refreshed HubSpot data (tie-out ' + (ds.tieOut && ds.tieOut.ok ? 'reconciled' : 'MISMATCH') + ')' });
  return JSON.parse(JSON.stringify({ result: { summary: 'Data refreshed at ' + ds.pulledAt + '.' }, panel: apiAdminGet() }));
}

function apiAdminInstallTrigger() {
  var v = requireAdmin_();
  installTriggers();
  appendAdminLog_(v.email, { action: 'install_trigger', target: 'refreshDataTrigger', summary: 'Installed the ' + FORECAST_CONFIG.forecast.data_refresh_minutes + '-minute refresh trigger' });
  return JSON.parse(JSON.stringify({ result: { summary: 'Refresh trigger installed.' }, panel: apiAdminGet() }));
}

function apiAdminVerifySnapshots() {
  var v = requireAdmin_();
  var r = verifySnapshots(ForecastCore.fiscalYearOf(todayEt_()));
  appendAdminLog_(v.email, { action: 'verify_snapshots', target: 'FY' + r.fiscalYear, summary: 'Integrity check: ' + r.checked + ' checked, ' + r.problems.length + ' problem(s)' });
  return JSON.parse(JSON.stringify({ result: { summary: r.ok ? 'All ' + r.checked + ' snapshots match their recorded SHA-256.' : r.problems.length + ' problem(s) found.', verify: r }, panel: apiAdminGet() }));
}
