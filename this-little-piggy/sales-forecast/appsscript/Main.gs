/**
 * Web app entry. Identity = Google SSO email of the viewer (Session.getActiveUser, same-domain,
 * deployment "Execute as: me", "Access: anyone within findigs.com"). The client never asserts identity.
 * Phase 1: auth guard + read-only data endpoint. UI sections arrive in Phases 2–4.
 */
function currentViewer_() {
  var email = Session.getActiveUser().getEmail();
  var v = ForecastCore.resolveViewer(email, FORECAST_CONFIG.roster);
  if (!v) throw new Error(email ? 'Access denied: ' + email + ' is not on the forecast roster or leadership list.'
                                : 'Access denied: could not determine your Google account. Open the app signed in with your findigs.com account.');
  return v;
}

function doGet() {
  var v;
  try { v = currentViewer_(); }
  catch (e) { return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">' + e.message + '</p>').setTitle('Sales Forecast'); }
  return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">Signed in as ' + v.name + ' (' + v.role +
    '). Forecast UI ships in Phase 2.</p>').setTitle('Sales Forecast');
}

/**
 * google.script.run endpoint: data for the viewer. AEs receive only their own row and deals;
 * leadership / ae_leader / admin receive all rows. Deal lists for other owners are never sent to an AE.
 */
function apiGetData(forceRefresh) {
  var v = currentViewer_();
  // A forced refresh costs ~40 HubSpot calls (independent tie-out path), so only view-all roles may trigger it.
  var ds = getDataset_(!!forceRefresh && v.canViewAll);
  var m = ds.metrics, ownRow = v.ae ? m.rows.filter(function (r) { return r.ownerId === String(v.ae.hubspot_owner_id); }) : [];
  var out = {
    viewer: { name: v.name, email: v.email, role: v.role, canViewAll: v.canViewAll, isAdmin: v.isAdmin, slug: v.ae ? v.ae.slug : null },
    pulledAt: ds.pulledAt, asOf: ds.asOf, period: ds.period,
    rows: v.canViewAll ? m.rows : ownRow,
    team: v.canViewAll ? m.team : null, nonRoster: v.canViewAll ? m.nonRoster : null, company: v.canViewAll ? m.company : null,
    tieOut: ds.tieOut ? { ok: ds.tieOut.ok, method: ds.tieOut.method, mismatches: ds.tieOut.mismatches } : null,
    // Company-wide flags carry other owners' deal IDs, so an AE gets only flags scoped to their own owner ID.
    flags: v.canViewAll ? m.flags : m.flags.filter(function (f) { return v.ae && f.ownerId === String(v.ae.hubspot_owner_id); }),
    stages: ds.stageMap.stages
  };
  return JSON.parse(JSON.stringify(out));
}
