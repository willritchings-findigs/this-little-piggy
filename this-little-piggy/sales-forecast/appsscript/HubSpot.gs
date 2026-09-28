/**
 * HubSpot API client — READ-ONLY by construction.
 *
 * Token: Script Properties → HUBSPOT_TOKEN (private app; scopes crm.objects.deals.read,
 * crm.objects.owners.read, crm.schemas.deals.read). Never logged, never sent to the client.
 * hsRequest_ refuses any call that is not a GET or a POST to a /search endpoint, so a coding
 * mistake cannot write to HubSpot even if the token were ever granted write scopes.
 */
var HS_BASE_ = 'https://api.hubapi.com';
var HS_MAX_RETRIES_ = 5;
var HS_SEARCH_PAGE_ = 200;   // Search API max
var HS_LIST_PAGE_ = 100;     // Objects list API max
var HS_SEARCH_CAP_ = 10000;  // Search API hard result cap

function hsToken_() {
  var t = PropertiesService.getScriptProperties().getProperty('HUBSPOT_TOKEN');
  if (!t) throw new Error('HUBSPOT_TOKEN is not set in Script Properties (Project Settings → Script properties).');
  return t;
}

function hsRequest_(method, path, body) {
  var isSearch = method === 'post' && /\/search$/.test(path.split('?')[0]);
  if (method !== 'get' && !isSearch) throw new Error('Blocked non-read HubSpot call: ' + method.toUpperCase() + ' ' + path);
  var opts = { method: method, muteHttpExceptions: true, contentType: 'application/json',
               headers: { Authorization: 'Bearer ' + hsToken_() } };
  if (body) opts.payload = JSON.stringify(body);
  for (var attempt = 0; ; attempt++) {
    var res = UrlFetchApp.fetch(HS_BASE_ + path, opts);
    var code = res.getResponseCode();
    if (code >= 200 && code < 300) return JSON.parse(res.getContentText());
    var retryable = code === 429 || code >= 500;
    if (!retryable || attempt >= HS_MAX_RETRIES_) {
      var msg = res.getContentText().slice(0, 500);
      throw new Error('HubSpot ' + code + ' on ' + method.toUpperCase() + ' ' + path.split('?')[0] + ': ' + msg);
    }
    Utilities.sleep(Math.min(16000, 1000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250));
  }
}

/** GET /crm/v3/pipelines/deals — stage IDs, labels, metadata.isClosed, metadata.probability. */
function hsGetPipelines_() {
  return hsRequest_('get', '/crm/v3/pipelines/deals');
}

/** All owners, active and archived (inactive). Returns raw v3 owner objects. */
function hsGetOwners_() {
  var out = [];
  [false, true].forEach(function (archived) {
    var after = null;
    do {
      var q = '/crm/v3/owners?limit=500&archived=' + archived + (after ? '&after=' + encodeURIComponent(after) : '');
      var r = hsRequest_('get', q);
      (r.results || []).forEach(function (o) { o.archived = archived || o.archived === true; out.push(o); });
      after = r.paging && r.paging.next ? r.paging.next.after : null;
    } while (after);
  });
  return out;
}

/**
 * CRM Search API, fully paginated. Asserts returned count === reported total (a mismatch means
 * records changed mid-pull or the 10k cap was hit — either way the pull is not trustworthy).
 */
function hsSearchDeals_(filterGroups, properties) {
  var results = [], after = null, total = null;
  do {
    var body = { filterGroups: filterGroups, properties: properties, limit: HS_SEARCH_PAGE_,
                 sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }] };
    if (after) body.after = after;
    var r = hsRequest_('post', '/crm/v3/objects/deals/search', body);
    if (total === null) total = r.total;
    results = results.concat(r.results || []);
    after = r.paging && r.paging.next ? r.paging.next.after : null;
    if (results.length >= HS_SEARCH_CAP_) throw new Error('Search API 10,000-result cap reached; narrow the filter.');
  } while (after);
  if (results.length !== total) throw new Error('Search returned ' + results.length + ' records but reported total ' + total + ' — re-run the pull.');
  return { results: results, total: total };
}

/**
 * Objects list API (primary store, not the search index) — every deal in the portal, all pipelines.
 * Used only by the independent tie-out path. ~35 calls at current volume.
 */
function hsListAllDeals_(properties) {
  var results = [], after = null;
  do {
    var q = '/crm/v3/objects/deals?limit=' + HS_LIST_PAGE_ + '&archived=false&properties=' +
            encodeURIComponent(properties.join(',')) + (after ? '&after=' + encodeURIComponent(after) : '');
    var r = hsRequest_('get', q);
    results = results.concat(r.results || []);
    after = r.paging && r.paging.next ? r.paging.next.after : null;
  } while (after);
  return results;
}

/** Filter groups for the two primary populations. ET date boundaries → epoch ms. */
function hsOpenFilter_(hs) {
  return [{ filters: [
    { propertyName: 'pipeline', operator: 'IN', values: hs.inScopePipelineIds },
    { propertyName: 'dealstage', operator: 'NOT_IN', values: hs.wonStageIds.concat(hs.lostStageIds) }
  ] }];
}
function hsWonFilter_(hs, fyStart, asOf) {
  // Over-fetch by one day on each side; ForecastCore.classifyDeals applies the exact ET window.
  var from = ForecastCore.etToUtcMs(ForecastCore.addDays(fyStart, -1), '00:00');
  var to = ForecastCore.etToUtcMs(ForecastCore.addDays(asOf, 2), '00:00');
  return [{ filters: [
    { propertyName: 'pipeline', operator: 'IN', values: hs.inScopePipelineIds },
    { propertyName: 'dealstage', operator: 'IN', values: hs.wonStageIds },
    { propertyName: hs.fields.close_date, operator: 'BETWEEN', value: String(from), highValue: String(to) }
  ] }];
}
