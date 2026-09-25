/**
 * Web app entry. Identity = Google SSO email of the viewer (Session.getActiveUser, same-domain,
 * deployment "Execute as: me", "Access: anyone within findigs.com"). The client never asserts identity:
 * every endpoint re-resolves the viewer server-side and checks what they may read or write.
 */
function currentViewer_() {
  var email = Session.getActiveUser().getEmail();
  var v = ForecastCore.resolveViewer(email, FORECAST_CONFIG.roster);
  if (!v) throw new Error(email ? 'Access denied: ' + email + ' is not on the forecast roster or leadership list.'
                                : 'Access denied: could not determine your Google account. Open the app signed in with your findigs.com account.');
  return v;
}

function doGet() {
  try { currentViewer_(); }
  catch (e) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif;padding:24px">' + escapeHtml_(e.message) + '</p>').setTitle('Sales forecast');
  }
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('Sales forecast').addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** HtmlService include: <?!= include('Styles') ?> */
function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

function rosterAeBySlug_(slug) {
  return FORECAST_CONFIG.roster.aes.filter(function (a) { return a.slug === slug; })[0] || null;
}

/** Which AE's data the viewer asked for, after permission checks. Defaults to the viewer's own AE. */
function targetAe_(v, slug) {
  if (!slug) {
    if (v.ae) return v.ae;
    return FORECAST_CONFIG.roster.aes.slice().sort(function (a, b) { return a.name < b.name ? -1 : 1; })[0];
  }
  var ae = rosterAeBySlug_(slug);
  if (!ae) throw new Error('Unknown AE: ' + slug);
  if (!v.canViewAll && (!v.ae || v.ae.slug !== slug)) throw new Error('Access denied: you can only view your own forecast builder.');
  return ae;
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
    viewer: viewerOut_(v),
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

function viewerOut_(v) {
  return { name: v.name, email: v.email, role: v.role, canViewAll: v.canViewAll, isAdmin: v.isAdmin, slug: v.ae ? v.ae.slug : null };
}

/**
 * Section 2 data for one AE: open deals and saved tags. Read-only unless the viewer is that AE.
 * Only currently open deals are returned (decision 2026-09-25): a tagged deal that closes or is reassigned
 * simply drops out; closed-won shows up in Closed Won YTD instead.
 */
function apiGetBuilder(aeSlug) {
  var v = currentViewer_(), ae = targetAe_(v, aeSlug);
  var ds = getDataset_(false);
  var deals = ds.metrics.openDealsByOwner[String(ae.hubspot_owner_id)] || [];
  var tags = readTags_(ae.email);
  var aes = v.canViewAll ? FORECAST_CONFIG.roster.aes.map(function (a) { return { slug: a.slug, name: a.name }; })
                         : [{ slug: ae.slug, name: ae.name }];
  return JSON.parse(JSON.stringify({
    viewer: viewerOut_(v),
    ae: { slug: ae.slug, name: ae.name, ownerId: String(ae.hubspot_owner_id) },
    readOnly: !(v.ae && v.ae.slug === ae.slug),
    aes: aes, deals: deals, tags: tags, tagsSavedAt: tagsSavedAt_(tags),
    pulledAt: ds.pulledAt, asOf: ds.asOf, period: ds.period,
    tieOutOk: ds.tieOut ? ds.tieOut.ok : null
  }));
}

/** Save tag changes for the viewer's own builder. Never writes to HubSpot. */
function apiSaveTags(aeSlug, changes) {
  var v = currentViewer_();
  if (!v.ae || v.ae.slug !== aeSlug) throw new Error('Read-only: you can only edit your own forecast builder.');
  var ds = getDataset_(false);
  var openIds = (ds.metrics.openDealsByOwner[String(v.ae.hubspot_owner_id)] || []).map(function (d) { return d.id; });
  var chk = ForecastCore.validateTagChanges(changes, openIds);
  if (!chk.ok) throw new Error('Not saved: ' + chk.errors.join('; '));
  var savedAt = writeTags_(v.ae.email, chk.clean, v.email);
  var tags = readTags_(v.ae.email);
  return JSON.parse(JSON.stringify({ savedAt: savedAt, tags: tags, tagsSavedAt: tagsSavedAt_(tags) }));
}
