#!/usr/bin/env node
/**
 * Phase 1 verification: run the exact core logic the Apps Script app uses against live HubSpot pulls
 * (CRM Search API, via MCP) and tie out to independent reporting-API aggregates (via MCP).
 *
 *   node scripts/verify_phase1.mjs [verification/<date>] [sample-ae-slug]
 * Writes <dir>/tieout.md and <dir>/sample_output_<slug>.json. Exit 2 on any tie-out mismatch.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildConfig } from './build.mjs';

const require = createRequire(import.meta.url);
const Core = require('../core/forecast_core.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(ROOT, process.argv[2] || 'verification/2026-09-25');
const slug = process.argv[3] || 'ben-de-winter';
const asOf = dir.match(/(\d{4}-\d{2}-\d{2})/)[1];
const J = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

const { config: cfg, errors } = buildConfig();
if (errors.length) { console.error(errors); process.exit(3); }
const hs = cfg.hubspot;

const stageMap = Core.buildStageMap(J('pipelines_observed.json'), hs);
if (!stageMap.ok) { console.error('STAGE MAP:', stageMap.errors); process.exit(3); }
const owners = Core.normalizeOwners(J('owners.json').results);
const openPull = J('deals_open_raw.json'), wonPull = J('deals_won_raw.json');
for (const [n, p] of [['open', openPull], ['won', wonPull]]) if (p.results.length !== p.total) { console.error(`${n} pull ${p.results.length} != total ${p.total}`); process.exit(3); }

const m = Core.computeMetrics({ openRaw: openPull.results, wonRaw: wonPull.results, stageMap, owners, roster: cfg.roster, hs, portalId: cfg.portalId, asOf });

// ---------------------------------------------------------------- independent side: reporting API aggregates
const ctl = J('controls_reporting_api.json');
const indep = { company: { cwYtd: { amount: 0, count: 0 }, grossOpen: { amount: 0, count: 0 } }, byOwner: {} };
const ob = (id) => (indep.byOwner[id] ||= { cwYtd: { amount: 0, count: 0 }, grossOpen: { amount: 0, count: 0 } });
for (const [id, r] of Object.entries(ctl.open_by_owner)) { ob(id).grossOpen = { amount: r.a, count: r.n }; indep.company.grossOpen.amount += r.a; indep.company.grossOpen.count += r.n; }
for (const [id, r] of Object.entries(ctl.won_ytd_by_owner)) { ob(id).cwYtd = { amount: r.a, count: r.n }; indep.company.cwYtd.amount += r.a; indep.company.cwYtd.count += r.n; }

const primOpen = Object.values(m.openDealsByOwner).flat(), primWon = Object.values(m.wonYtdByOwner).flat();
const labels = Object.fromEntries(Object.values(owners).map((o) => [o.id, o.name]));
const tie = Core.tieOut(Core.summarizeForTieOut(primOpen, primWon), indep, hs.tieOutToleranceUsd, labels);

// Secondary checks: stored-weighted sums and null-weighted counts vs reporting API.
const wChecks = Object.entries(ctl.open_by_owner).map(([id, r]) => {
  const ds = m.openDealsByOwner[id] || [];
  const stored = ds.filter((d) => d.weightedMethod === 'stored').reduce((s, d) => s + d.weighted, 0);
  const nulls = ds.filter((d) => d.weightedMethod !== 'stored').length;
  const ctlNull = ctl.weighted_null_by_owner[id] || 0;
  return { owner: labels[id] || id, stored: Core.round2(stored), ctlStored: Core.round2(r.w), nulls, ctlNull,
           ok: Math.abs(stored - r.w) <= hs.tieOutToleranceUsd && nulls === ctlNull };
});

// Won-pull boundary: deals fetched but excluded by the ET window.
const wonIncluded = new Set(primWon.map((d) => d.id));
const boundary = wonPull.results.filter((r) => !wonIncluded.has(String(r.id))).map((r) => ({ id: String(r.id), name: r.properties.dealname,
  closedateUtc: r.properties.closedate, closeDateEt: Core.etDate(r.properties.closedate) }));

// ---------------------------------------------------------------- outputs
const usd = (v) => (v === null || v === undefined ? '' : (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const row = m.rows.find((r) => r.key === slug);
const sample = {
  _about: `Phase 1 sample output for one AE, as returned by ForecastCore.computeMetrics (the same object apiGetData serves). As of ${asOf} ET.`,
  row,
  openDeals: (m.openDealsByOwner[row.ownerId] || []).sort((a, b) => (a.closeDate || '9999') < (b.closeDate || '9999') ? -1 : 1),
  closedWonYtdDeals: m.wonYtdByOwner[row.ownerId] || [],
  flagsForThisAe: m.flags.filter((f) => f.ownerId === row.ownerId || (f.dealIds || []).some((id) => (m.openDealsByOwner[row.ownerId] || []).some((d) => d.id === id)))
    .map((f) => ({ ...f, dealIds: (f.dealIds || []).filter((id) => (m.openDealsByOwner[row.ownerId] || []).some((d) => d.id === id)) }))
};
writeFileSync(join(dir, `sample_output_${slug}.json`), JSON.stringify(sample, null, 1));

const L = [];
L.push(`# Phase 1 tie-out — as of ${asOf} ET`, '');
L.push(`Primary: CRM Search API record pulls (open ${openPull.total}, won ${wonPull.total} incl. boundary over-fetch) → \`ForecastCore.computeMetrics\`.`);
L.push('Independent: HubSpot reporting API aggregates (`controls_reporting_api.json`). Tolerance $0.01; counts exact.', '');
L.push(`**Result: ${tie.ok ? 'RECONCILED' : tie.mismatches.length + ' MISMATCH(ES)'}** · weighted checks ${wChecks.every((w) => w.ok) ? 'reconciled' : 'MISMATCH'}`, '');
L.push('## Closed Won YTD and Gross Open Pipeline', '', '| Scope | Measure | Primary | Independent | Δ $ | n (P / I) | |', '|---|---|---|---|---|---|---|');
for (const r of tie.rows) L.push(`| ${r.scope} | ${r.measure} | ${usd(r.primaryAmount)} | ${usd(r.independentAmount)} | ${r.deltaAmount.toFixed(2)} | ${r.primaryCount} / ${r.independentCount} | ${r.ok ? '✅' : '❌'} |`);
L.push('', '## Stored weighted_amount and null counts (open deals)', '', '| Owner | Σ stored (primary) | Σ stored (reporting API) | null or "" (primary) | IS NULL (reporting API) | |', '|---|---|---|---|---|---|');
for (const w of wChecks) L.push(`| ${w.owner} | ${usd(w.stored)} | ${usd(w.ctlStored)} | ${w.nulls} | ${w.ctlNull} | ${w.ok ? '✅' : '❌'} |`);
L.push('', '## Section 1 figures (roster AEs, team, non-roster, company)', '', '| Row | Closed Won YTD (n) | Gross Open (n) | In-period ≤ 12/31 (n) | Weighted Open | stored / fallback n | Past due |', '|---|---|---|---|---|---|---|');
const fmtRow = (name, x) => `| ${name} | ${usd(x.closedWonYtd.amount)} (${x.closedWonYtd.count}) | ${usd(x.grossOpen.amount)} (${x.grossOpen.count}) | ${usd(x.grossOpenInPeriod.amount)} (${x.grossOpenInPeriod.count}) | ${usd(x.weightedOpen.amount)} | ${x.weightedOpen.storedCount} / ${x.weightedOpen.fallbackCount} | ${x.dq.pastDue} |`;
for (const r of m.rows) L.push(fmtRow(r.name + (r.role === 'ae_leader' ? ' (AE + leader)' : ''), r.metrics));
L.push(fmtRow('**Team Total (roster)**', m.team));
for (const o of m.nonRoster.owners) L.push(fmtRow(`↳ ${o.name} — ${o.reason}`, o.metrics));
L.push(fmtRow('**Non-roster owners**', m.nonRoster.total));
L.push(fmtRow('**Company total**', m.company));
L.push('', '## FY boundary handling (won pull over-fetched from 2025-12-31)', '');
if (boundary.length) for (const b of boundary) L.push(`- Excluded ${b.id} "${b.name}": closedate ${b.closedateUtc} UTC = ${b.closeDateEt} ET (FY${b.closeDateEt.slice(0, 4)})`);
else L.push('- none');
L.push('', '## Data-quality flags', '', '| Code | Severity | Detail |', '|---|---|---|');
for (const f of m.flags) L.push(`| ${f.code} | ${f.severity} | ${f.message}${f.amount !== undefined ? ' · ' + usd(f.amount) + (f.amountBasis ? ' (' + f.amountBasis + ')' : '') : ''} |`);
L.push('', `Stage map: ${Object.keys(stageMap.stages).length} stages, won ${stageMap.wonIds.join(', ')}, lost ${stageMap.lostIds.join(', ')} — matches gtm-dashboard config ${cfg.generatedFrom.gtmDashboardConfigVersion}.`);
writeFileSync(join(dir, 'tieout.md'), L.join('\n') + '\n');

console.log(L.slice(0, 6).join('\n'));
console.log(`wrote ${join(dir, 'tieout.md')} and sample_output_${slug}.json`);
process.exit(tie.ok && wChecks.every((w) => w.ok) ? 0 : 2);
