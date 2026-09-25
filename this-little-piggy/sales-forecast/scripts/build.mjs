#!/usr/bin/env node
/**
 * Generates the Apps Script config + core from their single sources of truth:
 *   gtm-dashboard/config.json   → HubSpot definitions (pipelines, stage IDs, fields, weighting, tolerance)
 *   sales-forecast/config/*.json → roster + forecast motion settings
 *   sales-forecast/core/forecast_core.js → business logic
 * Writes appsscript/Generated_Config.gs and appsscript/Generated_Core.gs.
 *
 *   node scripts/build.mjs          write generated files
 *   node scripts/build.mjs --check  exit 1 if generated files are stale or config is invalid (CI / pre-push)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const GTM_CONFIG = join(ROOT, '..', 'gtm-dashboard', 'config.json');
// Normalize CRLF → LF so Windows checkouts (git core.autocrlf) produce identical output and hashes.
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const sha = (s) => createHash('sha256').update(s).digest('hex');

// Fields this tool must never read (requirements + gtm-dashboard config.fields.not_used).
const FORBIDDEN_FIELDS = ['hs_acv', 'acv__c', 'acv', 'hs_forecast_amount', 'hs_is_closed_won', 'hs_is_closed_lost'];

export function buildConfig() {
  const gtmRaw = read(GTM_CONFIG);
  const gtm = JSON.parse(gtmRaw);
  const roster = JSON.parse(read(join(ROOT, 'config', 'roster.json')));
  const forecast = JSON.parse(read(join(ROOT, 'config', 'forecast.json')));
  const errors = [];

  const pipes = Object.values(gtm.pipelines);
  const f = gtm.fields;
  const hubspot = {
    portalId: gtm.portal_id,
    inScopePipelineIds: pipes.filter((p) => p.in_scope).map((p) => p.id),
    excludedPipelineIds: pipes.filter((p) => !p.in_scope).map((p) => p.id),
    pipelines: Object.fromEntries(pipes.map((p) => [p.id, { label: p.label, inScope: p.in_scope }])),
    wonStageIds: gtm.terminal_stages.won,
    lostStageIds: gtm.terminal_stages.lost,
    stageRule: gtm.terminal_stages.rule,
    fields: {
      bookings_amount: f.bookings_amount, units: f.units, owner: f.owner, close_date: f.close_date,
      stage_probability: f.stage_probability, weighted_stored: f.weighted_stored
    },
    weightingMethod: forecast.weighting.method,
    gtmDashboardWeightingRule: gtm.weighting_rule,
    tieOutToleranceUsd: gtm.tie_out_tolerance_usd,
    notUsed: f.not_used
  };
  hubspot.pullProperties = ['dealname', 'pipeline', 'dealstage', ...Object.values(hubspot.fields)];

  // --- guards: requirements that must hold regardless of what gtm-dashboard config says
  if (hubspot.fields.bookings_amount !== 'amount') errors.push(`bookings_amount must be "amount", got "${hubspot.fields.bookings_amount}"`);
  if (hubspot.fields.weighted_stored !== 'weighted_amount') errors.push('weighted_stored must be "weighted_amount"');
  for (const p of hubspot.pullProperties) if (FORBIDDEN_FIELDS.includes(p)) errors.push(`forbidden field in pull list: ${p}`);
  if (!hubspot.excludedPipelineIds.includes('2559714036')) errors.push('Renewal pipeline 2559714036 must be excluded');
  if (hubspot.inScopePipelineIds.includes('2559714036')) errors.push('Renewal pipeline 2559714036 is in scope');
  if (!['stage_probability', 'stored_first'].includes(hubspot.weightingMethod)) errors.push(`unknown weighting method ${hubspot.weightingMethod}`);
  if (hubspot.tieOutToleranceUsd !== 0.01) errors.push('tie-out tolerance must be 0.01');
  if (gtm.timezone !== forecast.timezone) errors.push(`timezone mismatch gtm=${gtm.timezone} forecast=${forecast.timezone}`);

  // --- roster validation
  const seen = { email: new Set(), slug: new Set(), owner: new Set() };
  for (const a of roster.aes) {
    if (!/^[a-z0-9.\-]+@findigs\.com$/.test(a.email)) errors.push(`bad AE email ${a.email}`);
    if (!/^[a-z0-9\-]+$/.test(a.slug)) errors.push(`bad slug ${a.slug}`);
    if (!/^\d+$/.test(a.hubspot_owner_id)) errors.push(`bad owner id for ${a.name}`);
    if (!['ae', 'ae_leader'].includes(a.role)) errors.push(`bad role ${a.role} for ${a.name}`);
    for (const [k, v] of [['email', a.email], ['slug', a.slug], ['owner', a.hubspot_owner_id]]) {
      if (seen[k].has(v)) errors.push(`duplicate ${k} ${v}`); seen[k].add(v);
    }
  }
  for (const l of [...roster.leadership, ...(roster.admins || [])]) {
    if (seen.email.has(l.email)) errors.push(`${l.email} appears in more than one role list`);
    seen.email.add(l.email);
  }
  for (const n of roster.non_roster_owners.owners) if (seen.owner.has(n.hubspot_owner_id)) errors.push(`${n.name} is both roster and non-roster`);
  if (!forecast.drive.folders_by_fiscal_year[String(roster.fiscal_year)]) errors.push(`no Drive folder configured for FY${roster.fiscal_year}`);
  // Year rollover reminder (not an error): from Dec 1, next year's folder must be configured before the last Friday cutoff.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), ny = Number(today.slice(0, 4)) + 1;
  if (today.slice(5) >= '12-01' && !forecast.drive.folders_by_fiscal_year[String(ny)]) console.warn(`WARNING: no Drive folder configured for FY${ny}. See README "Year rollover".`);

  const config = {
    generatedFrom: {
      gtmDashboardConfigVersion: gtm.version, gtmDashboardConfigSha256: sha(gtmRaw.trimEnd()),
      rosterVersion: roster.version, forecastVersion: forecast.version
    },
    portalId: gtm.portal_id,
    timezone: gtm.timezone,
    hubspot, roster, forecast
  };
  return { config, errors };
}

const header = (src) => `// GENERATED by sales-forecast/scripts/build.mjs from ${src}. DO NOT EDIT — edit the source and rebuild.\n`;

export function renderFiles() {
  const { config, errors } = buildConfig();
  const coreSrc = read(join(ROOT, 'core', 'forecast_core.js'));
  // Chart.js: pinned build, loaded from jsDelivr with SRI; the same bytes are bundled as a fallback (Vendor_ChartJs.html).
  // Normalize CRLF in case a Windows checkout converted it; the published file is LF and the SRI hash is of those bytes.
  const chartRaw = Buffer.from(readFileSync(join(ROOT, 'vendor', 'chart.umd.js'), 'utf8').replace(/\r\n?/g, '\n'), 'utf8');
  const chartJs = { version: '4.4.4', url: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.js',
                    integrity: 'sha384-' + createHash('sha384').update(chartRaw).digest('base64') };
  if (!chartRaw.toString('utf8', 0, 40).includes('Chart.js v' + chartJs.version)) errors.push('vendor/chart.umd.js is not Chart.js ' + chartJs.version);
  // Browser-safe subset only: no roster, no emails, no owner IDs.
  const clientConfig = {
    portalId: config.portalId, timezone: config.timezone,
    seriesColors: config.forecast.series_colors, definitions: config.forecast.definitions,
    cutoff: { weekday: config.forecast.cutoff.weekday, time_et: config.forecast.cutoff.time_et },
    section1: config.forecast.section1, section3: config.forecast.section3, weighting: config.forecast.weighting.method,
    chartJs
  };
  const htmlHeader = (src) => `<!-- GENERATED by sales-forecast/scripts/build.mjs from ${src}. DO NOT EDIT. -->\n`;
  return {
    errors,
    files: {
      [join(ROOT, 'appsscript', 'Vendor_ChartJs.html')]: chartRaw.toString('utf8'),
      // Async so a slow CDN never blocks the page; Client_Trend waits for it and falls back to Vendor_ChartJs.
      [join(ROOT, 'appsscript', 'Client_ChartLoader.html')]: htmlHeader('scripts/build.mjs (chartJs)') +
        `<script id="chartjs-cdn" async src="${chartJs.url}" integrity="${chartJs.integrity}" crossorigin="anonymous" onerror="window.__chartCdnFailed=true"></script>\n`,
      [join(ROOT, 'appsscript', 'Client_Core.html')]: htmlHeader('core/forecast_core.js') + '<script>\n' + coreSrc + '</script>\n',
      [join(ROOT, 'appsscript', 'Client_Config.html')]: htmlHeader('config/forecast.json') + '<script>\nvar CLIENT_CONFIG = ' + JSON.stringify(clientConfig, null, 2) + ';\n</script>\n',
      [join(ROOT, 'appsscript', 'Generated_Config.gs')]:
        header('gtm-dashboard/config.json + sales-forecast/config/*.json') + 'var FORECAST_CONFIG = ' + JSON.stringify(config, null, 2) + ';\n',
      [join(ROOT, 'appsscript', 'Generated_Core.gs')]: header('sales-forecast/core/forecast_core.js') + coreSrc
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const { errors, files } = renderFiles();
  if (errors.length) { console.error('CONFIG INVALID:\n  ' + errors.join('\n  ')); process.exit(1); }
  let stale = 0;
  for (const [p, content] of Object.entries(files)) {
    const cur = existsSync(p) ? read(p) : null;
    if (check) { if (cur !== content) { console.error(`STALE: ${p} — run node scripts/build.mjs`); stale++; } }
    else if (cur !== content) { writeFileSync(p, content); console.log(`wrote ${p}`); }
    else console.log(`unchanged ${p}`);
  }
  if (stale) process.exit(1);
  if (check) console.log('generated files up to date; config valid');
}
