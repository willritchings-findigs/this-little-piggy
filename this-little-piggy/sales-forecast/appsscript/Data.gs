/**
 * Data layer: pull → derive → tie-out → cache → build log.
 * All derivation lives in ForecastCore (Generated_Core.gs); this file only orchestrates I/O.
 */

/** Today's date in ET, from the server clock. */
function todayEt_() { return ForecastCore.etDate(Date.now()); }

/**
 * Full pull used by the time-driven trigger and the "Refresh data" button.
 * opts.skipIndependent: skip the objects-list tie-out path (per-AE submission pulls use this).
 */
function pullData_(opts) {
  opts = opts || {};
  var cfg = FORECAST_CONFIG, hs = cfg.hubspot;
  var startedMs = Date.now();
  var asOf = opts.asOf || todayEt_();
  var period = ForecastCore.periodFor(asOf);

  var pipelines = hsGetPipelines_();
  var stageMap = ForecastCore.buildStageMap(pipelines, hs);
  if (!stageMap.ok) {
    appendBuildLog_({ status: 'STOPPED', asOf: asOf, message: 'Stage map drift: ' + stageMap.errors.join(' | ') });
    throw new Error('Stage configuration drift — ' + stageMap.errors.join(' | '));
  }
  var owners = ForecastCore.normalizeOwners(hsGetOwners_());
  var openRaw = hsSearchDeals_(hsOpenFilter_(hs), hs.pullProperties).results;
  var wonRaw = hsSearchDeals_(hsWonFilter_(hs, period.fyStart, asOf), hs.pullProperties).results;

  var metrics = ForecastCore.computeMetrics({ openRaw: openRaw, wonRaw: wonRaw, stageMap: stageMap, owners: owners,
    roster: runtimeRoster_(), hs: hs, portalId: cfg.portalId, asOf: asOf });

  var tie = null;
  if (!opts.skipIndependent) tie = runIndependentTieOut_(metrics, stageMap, owners, asOf);

  var dataset = {
    schema: 'data_cache/1', pulledAt: ForecastCore.etIso(startedMs), asOf: asOf, period: period,
    durationMs: Date.now() - startedMs,
    stageMap: stageMap, stageMapSha256: sha256Hex_(JSON.stringify(pipelines)),
    owners: owners, metrics: metrics, tieOut: tie,
    config: cfg.generatedFrom
  };
  if (!opts.noCache) writeDataCache_(dataset);
  appendBuildLog_({
    status: tie && !tie.ok ? 'TIE-OUT MISMATCH' : 'OK', asOf: asOf, pulledAt: dataset.pulledAt,
    openCount: metrics.counts.open, wonYtdCount: metrics.counts.wonYtd,
    cwYtd: metrics.company.closedWonYtd.amount, grossOpen: metrics.company.grossOpen.amount,
    weightedOpen: metrics.company.weightedOpen.amount, weightedFallbackCount: metrics.company.weightedOpen.fallbackCount,
    tieOut: tie ? (tie.ok ? 'reconciled' : tie.mismatches.length + ' mismatch(es)') : 'skipped',
    message: tie && !tie.ok ? JSON.stringify(tie.mismatches.slice(0, 10)) : ''
  });
  return dataset;
}

/**
 * Independent path: objects list API (primary store) → same classification → compare to the
 * Search-API-derived figures. Different backend, same definitions.
 */
function runIndependentTieOut_(metrics, stageMap, owners, asOf) {
  var cfg = FORECAST_CONFIG, hs = cfg.hubspot, period = ForecastCore.periodFor(asOf);
  var all = hsListAllDeals_(hs.pullProperties);
  var ctx = { hs: hs, stageMap: stageMap, portalId: cfg.portalId, asOf: asOf, fyStart: period.fyStart, periodEnd: period.end };
  var indep = ForecastCore.classifyDeals(all, ctx);

  var primOpen = [], primWon = [];
  Object.keys(metrics.openDealsByOwner).forEach(function (k) { primOpen = primOpen.concat(metrics.openDealsByOwner[k]); });
  Object.keys(metrics.wonYtdByOwner).forEach(function (k) { primWon = primWon.concat(metrics.wonYtdByOwner[k]); });

  var labels = {}; Object.keys(owners).forEach(function (id) { labels[id] = owners[id].name; });
  var tie = ForecastCore.tieOut(ForecastCore.summarizeForTieOut(primOpen, primWon),
                                ForecastCore.summarizeForTieOut(indep.open, indep.wonYtd), hs.tieOutToleranceUsd, labels);
  tie.method = 'CRM Search API (primary) vs CRM Objects list API (independent), identical ET classification';
  if (!tie.ok) {
    tie.openDiff = ForecastCore.diffDealSets(primOpen, indep.open);
    tie.wonDiff = ForecastCore.diffDealSets(primWon, indep.wonYtd);
  }
  return tie;
}

/** Fresh figures for one owner — used at submission time so snapshots reflect submission-time state. */
function pullOwnerFigures_(ownerId) {
  var ds = pullData_({ skipIndependent: true, noCache: true });
  var row = ds.metrics.rows.filter(function (r) { return r.ownerId === String(ownerId); })[0];
  return { pulledAt: ds.pulledAt, asOf: ds.asOf, row: row, openDeals: ds.metrics.openDealsByOwner[String(ownerId)] || [],
           stageMapSha256: ds.stageMapSha256 };
}

/** Cached dataset for page loads; pulls if the cache is missing or older than the refresh interval. */
function getDataset_(forceRefresh) {
  if (!forceRefresh) {
    var c = readDataCache_();
    var maxAgeMs = FORECAST_CONFIG.forecast.data_refresh_minutes * 60000 * 2;
    if (c && c._writtenMs && Date.now() - c._writtenMs < maxAgeMs) return c;
  }
  return pullData_();
}

function sha256Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

// ------------------------------------------------------------------ triggers & admin (run from the editor)

/** Time-driven trigger target. */
function refreshDataTrigger() { pullData_(); }

/** Admin: install the refresh trigger (idempotent). */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshDataTrigger') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshDataTrigger').timeBased().everyMinutes(FORECAST_CONFIG.forecast.data_refresh_minutes).create();
}

/** Admin / Phase 1 verification: pull live and log one AE's figures plus the tie-out. */
function debugSampleAe(slug) {
  var ds = pullData_();
  var row = ds.metrics.rows.filter(function (r) { return r.key === (slug || 'ben-de-winter'); })[0];
  Logger.log(JSON.stringify({ pulledAt: ds.pulledAt, row: row, tieOut: { ok: ds.tieOut.ok, mismatches: ds.tieOut.mismatches },
                              flags: ds.metrics.flags.map(function (f) { return f.code + ': ' + f.message; }) }, null, 2));
}
