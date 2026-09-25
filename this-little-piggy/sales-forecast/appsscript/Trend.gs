/**
 * Section 3 (Forecast Trend) and the Sources & Methodology panel. Read-only; everyone on the roster may view.
 * Trend math lives in ForecastCore (trendSeries / changeTable / movementDrilldown) and runs in the browser on
 * the rows returned here, so the charts, the change table, and the tests all use the same code.
 */

/**
 * Rollup rows for closed forecast weeks only (current FY, plus the prior FY when the prior week crosses New Year).
 * Decision P4-8: the open week is hidden until its cutoff passes (Section 1 shows it live), so a partly
 * submitted week never reads as a collapse in the trend.
 */
function apiGetTrend() {
  var v = currentViewer_(), cfg = FORECAST_CONFIG;
  var week = ForecastCore.forecastWeekFor(nowMs_(), cfg.forecast.cutoff);
  var all = submissionsForWeek_(week);
  var openWeekRows = all.filter(function (r) { return r.forecast_week >= week.forecastWeek; }).length;
  var rows = all.filter(function (r) { return r.forecast_week < week.forecastWeek; }).map(function (r) {
    return { ae_slug: r.ae_slug, forecast_week: r.forecast_week, submitted_at: r.submitted_at, commit: r.commit, gut: r.gut, best_case: r.best_case,
             closed_won_ytd: r.closed_won_ytd, is_official: r.is_official, resubmission_seq: Number(r.resubmission_seq) || null,
             builder_saved: r.builder_saved === true || String(r.builder_saved).toUpperCase() === 'TRUE',
             synthetic: String(r.submission_id).indexOf('synthetic-') === 0 };
  });
  return JSON.parse(JSON.stringify({
    viewer: viewerOut_(v), testMode: isTestMode_(),
    aes: cfg.roster.aes.map(function (a) { return { slug: a.slug, name: a.name }; }),
    week: { forecastWeek: week.forecastWeek, previousWeek: week.previousWeek, cutoffAt: week.cutoffAt },
    reportWeek: ForecastCore.defaultReportWeek(rows, week.forecastWeek),
    threshold: cfg.forecast.section3.delta_threshold_pct,
    rows: rows, syntheticRows: rows.filter(function (r) { return r.synthetic; }).length, openWeekRows: openWeekRows
  }));
}

/** Read and integrity-check one snapshot file. Returns { snapshot, integrity } (integrity: ok | changed | missing). */
function readSnapshot_(row) {
  if (!row) return { snapshot: null, integrity: 'none' };
  try {
    var body = DriveApp.getFileById(String(row.drive_file_id)).getBlob().getDataAsString();
    return { snapshot: JSON.parse(body), integrity: sha256Hex_(body) === row.sha256 ? 'ok' : 'changed' };
  } catch (e) { return { snapshot: null, integrity: 'missing', error: e.message }; }
}

/** Movement drill-down for one AE and week: this week's official snapshot vs the prior week's. */
function apiGetMovement(aeSlug, forecastWeek) {
  currentViewer_();
  var ae = rosterAeBySlug_(aeSlug);
  if (!ae) throw new Error('Unknown AE: ' + aeSlug);
  var prevWeek = ForecastCore.addDays(forecastWeek, -7);
  var rows = readSubmissions_(ForecastCore.fiscalYearOf(forecastWeek));
  if (ForecastCore.fiscalYearOf(prevWeek) !== ForecastCore.fiscalYearOf(forecastWeek)) {
    try { rows = readSubmissions_(ForecastCore.fiscalYearOf(prevWeek)).concat(rows); } catch (e) { /* prior FY not configured */ }
  }
  var off = function (w) { return rows.filter(function (r) { return r.is_official && r.ae_slug === aeSlug && r.forecast_week === w; })[0] || null; };
  var cur = readSnapshot_(off(forecastWeek)), prev = readSnapshot_(off(prevWeek));
  var result = ForecastCore.movementDrilldown(prev.snapshot, cur.snapshot);
  result.ae = { slug: ae.slug, name: ae.name };
  result.week = forecastWeek; result.priorWeek = prevWeek;
  result.integrity = { current: cur.integrity, prior: prev.integrity };
  result.synthetic = !!((cur.snapshot && cur.snapshot.synthetic) || (prev.snapshot && prev.snapshot.synthetic));
  return JSON.parse(JSON.stringify(result));
}

/** Everything the Sources & Methodology panel lists, from live config and the latest data pull. */
function apiGetMethodology() {
  var v = currentViewer_(), cfg = FORECAST_CONFIG, hs = cfg.hubspot, ds = getDataset_(false), m = ds.metrics;
  var stages = Object.keys(ds.stageMap.stages).map(function (id) { return ds.stageMap.stages[id]; })
    .sort(function (a, b) { return a.pipelineId === b.pipelineId ? a.order - b.order : (a.pipelineId < b.pipelineId ? -1 : 1); });
  var fy = ds.period.fiscalYear, folderId = cfg.forecast.drive.folders_by_fiscal_year[String(fy)] || null;
  return JSON.parse(JSON.stringify({
    viewer: viewerOut_(v), testMode: isTestMode_(),
    source: { system: 'HubSpot', portalId: cfg.portalId, apis: ['CRM Search API (deals)', 'CRM Objects list API (independent tie-out)', 'Pipelines API (stages, probabilities)', 'Owners API (owner status)'] },
    pulledAt: ds.pulledAt, asOf: ds.asOf, period: ds.period, refreshMinutes: cfg.forecast.data_refresh_minutes,
    tieOut: ds.tieOut ? { ok: ds.tieOut.ok, method: ds.tieOut.method, tolerance: ds.tieOut.toleranceUsd, mismatches: ds.tieOut.mismatches.length } : null,
    pipelines: Object.keys(hs.pipelines).map(function (id) { return { id: id, label: hs.pipelines[id].label, inScope: hs.pipelines[id].inScope }; }),
    stages: stages, wonStageIds: hs.wonStageIds, lostStageIds: hs.lostStageIds, stageRule: hs.stageRule,
    fields: hs.fields, notUsed: hs.notUsed,
    weighting: { method: hs.weightingMethod, formula: cfg.forecast.weighting.formula, reference: cfg.forecast.weighting.hubspot_weighted_amount,
                 notion: cfg.forecast.weighting.notion_definition,
                 stageWeightedCount: m.company.weightedOpen.stageCount, unavailableCount: m.company.weightedOpen.unavailableCount,
                 hubspotStoredCount: m.company.weightedOpen.hubspotStoredCount, hubspotStoredAmount: m.company.weightedOpen.hubspotStoredAmount,
                 weightedTotal: m.company.weightedOpen.amount },
    definitions: cfg.forecast.definitions, cutoff: cfg.forecast.cutoff,
    storage: { productionFolderId: folderId, testFolderId: cfg.forecast.drive.test_folder_id, snapshotPattern: 'forecast_{week}_{ae_slug}_{submitted_at}.json',
               rollup: 'Sales Forecast Rollup ' + fy, immutable: 'Snapshots are never overwritten or deleted; SHA-256 per file (verifySnapshots).' },
    population: { open: m.counts.open, wonYtd: m.counts.wonYtd, company: m.company, team: m.team },
    flags: m.flags.map(function (f) { return { code: f.code, severity: f.severity, message: f.message, count: f.count, amount: f.amount }; }),
    nonRoster: m.nonRoster.owners.map(function (o) { return { name: o.name, reason: o.reason, status: o.ownerStatus }; }),
    config: cfg.generatedFrom
  }));
}

/** Fallback when the Chart.js CDN is blocked: the same pinned build, served by the app. */
function apiGetChartJs() {
  currentViewer_();
  return HtmlService.createHtmlOutputFromFile('Vendor_ChartJs').getContent();
}
