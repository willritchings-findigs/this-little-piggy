/**
 * Forecast Builder tag persistence — rollup workbook, tab `builder_state` (one row per AE × deal).
 * Mutable working state (the AE's current tags). It is frozen into the immutable snapshot at submission
 * (Phase 3). Nothing here touches HubSpot.
 */
var BS_COLS_ = { ae_email: 0, deal_id: 1, tag: 2, updated_at: 3, updated_by: 4 };

function builderSheet_() {
  return getRollup_(ForecastCore.fiscalYearOf(todayEt_())).getSheetByName('builder_state');
}

/** {dealId: {tag, updatedAt, updatedBy}} for one AE. */
function readTags_(aeEmail) {
  var e = String(aeEmail).toLowerCase(), out = {};
  var values = builderSheet_().getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (String(r[BS_COLS_.ae_email]).toLowerCase() !== e) continue;
    out[String(r[BS_COLS_.deal_id])] = { tag: ForecastCore.normalizeTag(r[BS_COLS_.tag]) || 'none',
                                         updatedAt: String(r[BS_COLS_.updated_at] || ''), updatedBy: String(r[BS_COLS_.updated_by] || '') };
  }
  return out;
}

/** Latest updated_at across the AE's rows, or null if the AE has never saved a tag. */
function tagsSavedAt_(tags) {
  var max = null;
  Object.keys(tags).forEach(function (id) { var t = tags[id].updatedAt; if (t && (!max || t > max)) max = t; });
  return max;
}

/**
 * Upsert tag rows under the script lock. `clean` comes from ForecastCore.validateTagChanges.
 * Existing rows are updated in place; new rows are appended in one write.
 */
function writeTags_(aeEmail, clean, byEmail) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another save is in progress. Your tags are kept on screen; try again in a few seconds.');
  try {
    var sh = builderSheet_(), e = String(aeEmail).toLowerCase(), now = ForecastCore.etIso(Date.now());
    var values = sh.getDataRange().getValues(), rowByDeal = {};
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][BS_COLS_.ae_email]).toLowerCase() === e) rowByDeal[String(values[i][BS_COLS_.deal_id])] = i + 1;
    }
    var appends = [];
    clean.forEach(function (c) {
      var row = [e, "'" + c.dealId, c.tag, now, String(byEmail).toLowerCase()];   // leading ' keeps deal IDs as text
      if (rowByDeal[c.dealId]) sh.getRange(rowByDeal[c.dealId], 1, 1, row.length).setValues([row]);
      else appends.push(row);
    });
    if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, appends[0].length).setValues(appends);
    return now;
  } finally { lock.releaseLock(); }
}
