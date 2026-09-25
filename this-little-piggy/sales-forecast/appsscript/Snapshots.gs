/**
 * Section 1 submissions: immutable JSON snapshot in the year folder + one row in the rollup `submissions` tab.
 *
 * Immutability rules (enforced by code review + tests/snapshots.test.mjs, which greps this file):
 *   - snapshot files are only ever created; this file never calls setContent, setTrashed, or removeFile;
 *   - the only rollup cell ever rewritten is is_official, when a later submission for the same AE and week
 *     supersedes an earlier one.
 */
// A function, not a top-level var: Apps Script loads files alphabetically, so Storage.gs (ROLLUP_TABS_) loads after this file.
function subCols_() { return ROLLUP_TABS_.submissions; }

function nowMs_() { return Date.now(); }

function colIndex_(name) { var i = subCols_().indexOf(name); if (i < 0) throw new Error('unknown submissions column ' + name); return i; }

/** All submission rows for a fiscal year as objects (numbers typed, is_official boolean). */
function readSubmissions_(fiscalYear) {
  var values = getRollup_(fiscalYear).getSheetByName('submissions').getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var r = {}, v = values[i];
    subCols_().forEach(function (c, j) { r[c] = v[j]; });
    ['commit', 'gut', 'best_case', 'closed_won_ytd', 'gross_pipeline', 'gross_pipeline_in_period', 'weighted_pipeline'].forEach(function (k) { r[k] = ForecastCore.num(r[k]); });
    r.is_official = r.is_official === true || String(r.is_official).toUpperCase() === 'TRUE';
    r.submitted_at = String(r.submitted_at); r.forecast_week = normalizeDateCell_(r.forecast_week);
    r._row = i + 1;
    out.push(r);
  }
  return out;
}

/** Sheets may auto-convert '2026-10-02' into a Date; always read it back as YYYY-MM-DD (ET). */
function normalizeDateCell_(v) {
  if (v instanceof Date) return ForecastCore.etDate(v.getTime());
  return String(v);
}

/** Submissions relevant to a forecast week: its FY, plus the previous week's FY when the year rolls over. */
function submissionsForWeek_(week) {
  var fy = ForecastCore.fiscalYearOf(week.forecastWeek), prevFy = ForecastCore.fiscalYearOf(week.previousWeek);
  var rows = readSubmissions_(fy);
  if (prevFy !== fy) { try { rows = readSubmissions_(prevFy).concat(rows); } catch (e) { /* prior FY folder not configured */ } }
  return rows;
}

/**
 * Validate → fresh HubSpot figures → build snapshot → (lock) create file, append row, flip is_official.
 * Returns the stored row plus any warnings. Throws with a user-facing message on any blocking error.
 */
function writeSubmission_(v, rawValues) {
  var cfg = FORECAST_CONFIG, ae = v.ae;
  var submittedMs = nowMs_(), submittedAt = ForecastCore.etIso(submittedMs);
  var week = ForecastCore.forecastWeekFor(submittedMs, cfg.forecast.cutoff);

  var pre = ForecastCore.validateForecast(rawValues, {});
  if (!pre.ok) throw new Error('Not submitted: ' + pre.errors.map(function (e) { return e.message; }).join(' '));

  var fy = ForecastCore.fiscalYearOf(week.forecastWeek);
  var folder = getYearFolder_(fy);   // throws (blocks the submission) if the FY folder is not configured

  // Fresh, submission-time figures (outside the lock: this is the slow part).
  var fig = pullOwnerFigures_(ae.hubspot_owner_id);
  var period = ForecastCore.forecastPeriodFor(ForecastCore.etDate(submittedMs), week.forecastWeek);
  var row = JSON.parse(JSON.stringify(fig.row));
  var extraWarnings = [];
  if (ForecastCore.fiscalYearOf(fig.asOf) !== fy) {
    // Year rollover (e.g. submitting on Dec 28 for the week ending Jan 1): Closed Won YTD of the new FY is 0.
    row.metrics.closedWonYtd = { amount: 0, count: 0, nullAmountCount: 0 };
    extraWarnings.push({ field: null, code: 'fy_rollover_closed_won_reset', message: 'This forecast week belongs to FY' + fy + '; Closed Won YTD starts at $0.' });
  }
  var chk = ForecastCore.validateForecast(rawValues, { inPeriodPipeline: row.metrics.grossOpenInPeriod.amount, periodEnd: period.end });
  if (!chk.ok) throw new Error('Not submitted: ' + chk.errors.map(function (e) { return e.message; }).join(' '));
  var warnings = chk.warnings.concat(extraWarnings);

  var tags = readTags_(ae.email);
  var ds = readDataCache_();
  var snapshot = ForecastCore.buildSnapshot({
    schemaVersion: cfg.forecast.schema_version, submissionId: Utilities.getUuid(), appVersion: cfg.generatedFrom.gtmDashboardConfigVersion + '/' + cfg.generatedFrom.rosterVersion,
    week: week, period: period, ae: ae, submittedAt: submittedAt, submittedBy: v.email, values: chk.values, warnings: warnings,
    pulledAt: fig.pulledAt, asOf: fig.asOf, row: row, weightingMethod: cfg.hubspot.weightingMethod,
    tieOutStatus: ds && ds.tieOut ? (ds.tieOut.ok ? 'reconciled' : 'mismatch') : 'not_checked', stageMapSha256: fig.stageMapSha256,
    openDeals: fig.openDeals, tags: tags, tagsSavedAt: tagsSavedAt_(tags)
  });
  var body = JSON.stringify(snapshot, null, 2), sha = sha256Hex_(body);
  var name = ForecastCore.snapshotFileName(week.forecastWeek, ae.slug, submittedAt);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another submission is being saved. Nothing was saved; please submit again in a few seconds.');
  try {
    if (folder.getFilesByName(name).hasNext()) throw new Error('A snapshot named ' + name + ' already exists; not overwriting. Submit again.');
    var file = folder.createFile(name, body, 'application/json');
    var sh = getRollup_(fy).getSheetByName('submissions');
    var existing = readSubmissions_(fy).filter(function (r) { return r.ae_slug === ae.slug && r.forecast_week === week.forecastWeek; });
    var m = row.metrics, s = snapshot.builder.totals;
    var rec = {
      submission_id: snapshot.submission_id, forecast_week: "'" + week.forecastWeek, ae_slug: ae.slug, ae_name: ae.name, ae_email: ae.email,
      owner_id: "'" + String(ae.hubspot_owner_id), submitted_at: "'" + submittedAt, commit: chk.values.commit, gut: chk.values.gut, best_case: chk.values.best_case,
      closed_won_ytd: m.closedWonYtd.amount, gross_pipeline: m.grossOpen.amount, gross_pipeline_in_period: m.grossOpenInPeriod.amount,
      weighted_pipeline: m.weightedOpen.amount, weighted_fallback_n: m.weightedOpen.fallbackCount,
      is_official: true, resubmission_seq: existing.length + 1, builder_saved: snapshot.builder.saved,
      builder_commit: s.commit, builder_gut_cum: s.gut_cumulative, builder_best_cum: s.best_case_cumulative,
      warnings: warnings.map(function (w) { return w.code; }).join(','), tie_out_status: snapshot.context_at_submission.tie_out_status,
      schema_version: snapshot.schema_version, drive_file_id: file.getId(), file_name: name, sha256: sha
    };
    sh.appendRow(subCols_().map(function (c) { return rec[c]; }));
    // Supersede earlier submissions for the same AE and week: the only in-place edit this app makes.
    var col = colIndex_('is_official') + 1;
    existing.forEach(function (r) { if (r.is_official) sh.getRange(r._row, col).setValue(false); });
    return { submissionId: snapshot.submission_id, forecastWeek: week.forecastWeek, cutoffAt: week.cutoffAt, submittedAt: submittedAt,
             fileName: name, fileId: file.getId(), sha256: sha, resubmissionSeq: existing.length + 1, warnings: warnings, values: chk.values };
  } finally { lock.releaseLock(); }
}

/** Admin: re-hash every snapshot listed in the rollup and report any file that changed or disappeared. */
function verifySnapshots(fiscalYear) {
  var fy = fiscalYear || ForecastCore.fiscalYearOf(todayEt_()), rows = readSubmissions_(fy), problems = [];
  rows.forEach(function (r) {
    try {
      var body = DriveApp.getFileById(String(r.drive_file_id)).getBlob().getDataAsString();
      if (sha256Hex_(body) !== r.sha256) problems.push({ row: r._row, file: r.file_name, problem: 'content changed (sha256 mismatch)' });
    } catch (e) { problems.push({ row: r._row, file: r.file_name, problem: 'file missing or unreadable: ' + e.message }); }
  });
  var result = { fiscalYear: fy, checked: rows.length, problems: problems, ok: problems.length === 0 };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
