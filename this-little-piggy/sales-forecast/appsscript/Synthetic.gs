/**
 * Admin, TEST MODE ONLY: seed four closed weeks of synthetic official submissions so Section 3 has a trend to
 * render. Refuses to run unless FORECAST_TEST_FOLDER_ID is set, and refuses to seed twice (snapshots are
 * never deleted). Scenarios come from ForecastCore.syntheticHistory:
 *   Spencer misses a week (gap) · Ian resubmits twice (overlay) · Ben saves no builder tags one week ·
 *   Matt's latest week does not reconcile to tag movement · Phil is steady.
 * Every file and row is marked synthetic (submission_id starts with "synthetic-", snapshot.synthetic = true).
 */
function seedSyntheticSnapshots() {
  if (!isTestMode_()) throw new Error('Refusing: synthetic snapshots can only be written in TEST MODE (Script Property FORECAST_TEST_FOLDER_ID).');
  var cfg = FORECAST_CONFIG, ds = getDataset_(false);
  var cur = ForecastCore.forecastWeekFor(nowMs_(), cfg.forecast.cutoff).forecastWeek;
  var weeks = [28, 21, 14, 7].map(function (d) { return ForecastCore.addDays(cur, -d); });
  var fy = ForecastCore.fiscalYearOf(weeks[weeks.length - 1]);
  weeks = weeks.filter(function (w) { return ForecastCore.fiscalYearOf(w) === fy; });
  var existing = readSubmissions_(fy);
  if (existing.some(function (r) { return String(r.submission_id).indexOf('synthetic-') === 0; }))
    throw new Error('Synthetic snapshots already exist in the test rollup; not seeding twice.');
  // Never mix synthetic rows into an (AE, week) that already has real test submissions: two official rows would result.
  var taken = {}, skipped = [];
  existing.forEach(function (r) { taken[r.ae_slug + '|' + r.forecast_week] = true; });
  var cwByOwner = {};
  ds.metrics.rows.forEach(function (r) { cwByOwner[r.ownerId] = r.metrics.closedWonYtd.amount; });
  var hist = ForecastCore.syntheticHistory(runtimeRoster_().aes, ds.metrics.openDealsByOwner, weeks, cwByOwner).filter(function (h) {
    var k = h.ae.slug + '|' + h.week;
    if (!taken[k]) return true;
    if (skipped.indexOf(k) < 0) skipped.push(k);
    return false;
  });
  var folder = getYearFolder_(fy), written = 0;
  withScriptLock_(function () {
    var sh = getRollup_(fy).getSheetByName('submissions');
    hist.forEach(function (h) {
      var metricsRow = ds.metrics.rows.filter(function (r) { return r.key === h.ae.slug; })[0];
      var row = JSON.parse(JSON.stringify(metricsRow));
      row.metrics.closedWonYtd = { amount: h.closedWonYtd, count: row.metrics.closedWonYtd.count, nullAmountCount: 0 };
      var week = { forecastWeek: h.week, cutoffAt: ForecastCore.etIso(ForecastCore.etToUtcMs(h.week, cfg.forecast.cutoff.time_et)) };
      var snapshot = ForecastCore.buildSnapshot({
        schemaVersion: cfg.forecast.schema_version, submissionId: 'synthetic-' + Utilities.getUuid(), appVersion: 'synthetic',
        week: week, period: ForecastCore.forecastPeriodFor(h.submittedAt.slice(0, 10), h.week), ae: h.ae, submittedAt: h.submittedAt,
        submittedBy: 'synthetic-seed@test', onBehalf: true, values: h.values, warnings: [], pulledAt: ds.pulledAt, asOf: h.submittedAt.slice(0, 10),
        row: row, weightingMethod: cfg.hubspot.weightingMethod, tieOutStatus: 'synthetic', stageMapSha256: ds.stageMapSha256,
        openDeals: h.deals, tags: h.tags, tagsSavedAt: h.saved ? h.submittedAt : null
      });
      snapshot.synthetic = true; snapshot.synthetic_scenario = h.scenario;
      var body = JSON.stringify(snapshot, null, 2), name = ForecastCore.snapshotFileName(h.week, h.ae.slug, h.submittedAt).replace(/^forecast_/, 'forecast_synthetic_');
      var file = folder.createFile(name, body, 'application/json');
      sh.appendRow(submissionRow_(snapshot, row.metrics, h.isOfficial, h.seq, file.getId(), name, sha256Hex_(body), true));
      written++;
    });
  }, 'Busy; try again in a few seconds.');
  var result = { weeks: weeks, snapshotsWritten: written, folder: folder.getName(), skippedExisting: skipped };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
