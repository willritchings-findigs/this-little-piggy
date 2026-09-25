/**
 * Drive / Sheets storage: year folder resolution, _system cache, rollup workbook, build log.
 * Snapshot writes live in Snapshots.gs.
 *
 * TEST MODE: when Script Property FORECAST_TEST_FOLDER_ID is set, every read and write (cache, rollup,
 * snapshots, builder tags, build log) goes to FY<year> subfolders of that folder instead of the production
 * folders, and the UI shows a TEST MODE banner. Delete the property to go live.
 *
 * Mutable vs immutable:
 *   _system/data_cache.json  — mutable cache, overwritten each pull (never a snapshot).
 *   rollup workbook tabs     — build_log / meta append-only; submissions rows append-only except is_official.
 *   forecast_*.json          — immutable snapshots (Phase 3), never updated or trashed by the app.
 */
var ROLLUP_TABS_ = {
  submissions: ['submission_id', 'forecast_week', 'ae_slug', 'ae_name', 'ae_email', 'owner_id', 'submitted_at', 'commit', 'gut',
                'best_case', 'closed_won_ytd', 'gross_pipeline', 'gross_pipeline_in_period', 'weighted_pipeline', 'weighted_fallback_n',
                'is_official', 'resubmission_seq', 'builder_saved', 'builder_commit', 'builder_gut_cum', 'builder_best_cum', 'warnings',
                'tie_out_status', 'schema_version', 'drive_file_id', 'file_name', 'sha256'],
  builder_state: ['ae_email', 'deal_id', 'tag', 'updated_at', 'updated_by'],
  build_log: ['logged_at', 'status', 'as_of', 'pulled_at', 'open_count', 'won_ytd_count', 'cw_ytd', 'gross_open', 'weighted_open',
              'weighted_fallback_n', 'tie_out', 'message', 'config_version'],
  meta: ['key', 'value']
};

function testFolderId_() { return PropertiesService.getScriptProperties().getProperty('FORECAST_TEST_FOLDER_ID') || null; }
function isTestMode_() { return !!testFolderId_(); }

function getYearFolder_(fiscalYear) {
  var testId = testFolderId_();
  if (testId) {
    var root = DriveApp.getFolderById(testId), name = 'FY' + fiscalYear, it = root.getFoldersByName(name);
    return it.hasNext() ? it.next() : root.createFolder(name);
  }
  var id = FORECAST_CONFIG.forecast.drive.folders_by_fiscal_year[String(fiscalYear)];
  if (!id) throw new Error('No Drive folder configured for FY' + fiscalYear + ' in config/forecast.json (drive.folders_by_fiscal_year). Submissions are blocked until an admin adds it.');
  return DriveApp.getFolderById(id);
}

function getSystemFolder_(fiscalYear) {
  var parent = getYearFolder_(fiscalYear);
  var it = parent.getFoldersByName('_system');
  return it.hasNext() ? it.next() : parent.createFolder('_system');
}

function writeDataCache_(dataset) {
  var fy = dataset.period.fiscalYear, folder = getSystemFolder_(fy);
  dataset._writtenMs = Date.now();
  var body = JSON.stringify(dataset);
  var it = folder.getFilesByName('data_cache.json');
  if (it.hasNext()) it.next().setContent(body);
  else folder.createFile('data_cache.json', body, 'application/json');
}

function readDataCache_() {
  try {
    var it = getSystemFolder_(ForecastCore.fiscalYearOf(todayEt_())).getFilesByName('data_cache.json');
    return it.hasNext() ? JSON.parse(it.next().getBlob().getDataAsString()) : null;
  } catch (e) { return null; }
}

/** Rollup workbook for a fiscal year, created in the year folder on first use. */
function getRollup_(fiscalYear) {
  var test = isTestMode_();
  var props = PropertiesService.getScriptProperties(), key = (test ? 'ROLLUP_ID_TEST_' : 'ROLLUP_ID_') + fiscalYear;
  var id = props.getProperty(key);
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* recreate below */ } }
  var folder = getYearFolder_(fiscalYear), name = 'Sales Forecast Rollup ' + fiscalYear + (test ? ' (TEST)' : '');
  var it = folder.getFilesByName(name), ss;
  if (it.hasNext()) ss = SpreadsheetApp.open(it.next());
  else {
    ss = SpreadsheetApp.create(name);
    DriveApp.getFileById(ss.getId()).moveTo(folder);
  }
  Object.keys(ROLLUP_TABS_).forEach(function (tab) {
    var sh = ss.getSheetByName(tab) || ss.insertSheet(tab);
    if (sh.getLastRow() === 0) { sh.appendRow(ROLLUP_TABS_[tab]); sh.setFrozenRows(1); }
  });
  var def = ss.getSheetByName('Sheet1'); if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  props.setProperty(key, ss.getId());
  return ss;
}

function appendBuildLog_(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { console.error('build_log lock timeout: ' + JSON.stringify(e)); return; }
  try {
    var fy = ForecastCore.fiscalYearOf(e.asOf || todayEt_());
    getRollup_(fy).getSheetByName('build_log').appendRow([
      ForecastCore.etIso(Date.now()), e.status || '', e.asOf || '', e.pulledAt || '', e.openCount, e.wonYtdCount,
      e.cwYtd, e.grossOpen, e.weightedOpen, e.weightedFallbackCount, e.tieOut || '', (e.message || '').slice(0, 45000),
      FORECAST_CONFIG.generatedFrom.gtmDashboardConfigVersion + ' / ' + FORECAST_CONFIG.generatedFrom.rosterVersion
    ]);
  } finally { lock.releaseLock(); }
}
