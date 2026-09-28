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

// Weighted checks.
// (a) Stage-weighted open pipeline (the method in use): primary Σ(amount × stage prob) per deal vs an independent
//     Σ over reporting-API SUM(amount) GROUP BY owner, stage × the same stage probability.
// (b) Reference: the raw HubSpot weighted_amount field (not used in totals) still reconciles, so the comparison is honest.
const indepWeighted = {};
for (const r of ctl.open_by_owner_stage) indepWeighted[r.owner] = (indepWeighted[r.owner] || 0) + r.a * stageMap.stages[r.stage].probability;
const alt = Core.computeMetrics({ openRaw: openPull.results, wonRaw: wonPull.results, stageMap, owners, roster: cfg.roster,
  hs: { ...hs, weightingMethod: 'stored_first' }, portalId: cfg.portalId, asOf });
const altByOwner = {};
for (const [id, ds] of Object.entries(alt.openDealsByOwner)) altByOwner[id] = ds.reduce((s, d) => s + (d.weighted || 0), 0);
const wChecks = Object.entries(ctl.open_by_owner).map(([id, r]) => {
  const ds = m.openDealsByOwner[id] || [];
  const stageW = ds.reduce((s, d) => s + (d.weighted || 0), 0);
  const hsStored = ds.filter((d) => d.hubspotWeightedAmount !== null).reduce((s, d) => s + d.hubspotWeightedAmount, 0);
  const nulls = ds.filter((d) => d.hubspotWeightedAmount === null).length;
  const ctlNull = ctl.weighted_null_by_owner[id] || 0;
  return { owner: labels[id] || id, stageW: Core.round2(stageW), indepStageW: Core.round2(indepWeighted[id] || 0),
           storedFirst: Core.round2(altByOwner[id] || 0), hsStored: Core.round2(hsStored), ctlStored: Core.round2(r.w), nulls, ctlNull,
           ok: Math.abs(stageW - (indepWeighted[id] || 0)) <= hs.tieOutToleranceUsd && Math.abs(hsStored - r.w) <= hs.tieOutToleranceUsd && nulls === ctlNull };
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
L.push('', '## Weighted open pipeline (method: amount × pipeline stage probability)', '',
  'Stage-weighted is checked against an independent reporting-API SUM(amount) by owner × stage. HubSpot `weighted_amount` is pulled for reference only and must still reconcile to prove the comparison uses the real field. "Old rule" = gtm-dashboard stored-first rule, shown for impact only.', '',
  '| Owner | Stage-weighted (primary) | Stage-weighted (independent) | Old rule (stored-first) | HubSpot weighted_amount Σ (primary / reporting API) | blank (primary / API) | |', '|---|---|---|---|---|---|---|');
for (const w of wChecks) L.push(`| ${w.owner} | ${usd(w.stageW)} | ${usd(w.indepStageW)} | ${usd(w.storedFirst)} | ${usd(w.hsStored)} / ${usd(w.ctlStored)} | ${w.nulls} / ${w.ctlNull} | ${w.ok ? '✅' : '❌'} |`);
const sum = (k) => Core.round2(wChecks.reduce((s, w) => s + w[k], 0));
L.push(`| **Company** | **${usd(sum('stageW'))}** | **${usd(sum('indepStageW'))}** | ${usd(sum('storedFirst'))} | ${usd(sum('hsStored'))} / ${usd(sum('ctlStored'))} | ${sum('nulls')} / ${sum('ctlNull')} | |`);
L.push('', '## Section 1 figures (roster AEs, team, non-roster, company)', '', '| Row | Closed Won YTD (n) | Gross Open (n) | In-period ≤ 12/31 (n) | Weighted Open (stage) | weighted n / blank n | Past due |', '|---|---|---|---|---|---|---|');
const fmtRow = (name, x) => `| ${name} | ${usd(x.closedWonYtd.amount)} (${x.closedWonYtd.count}) | ${usd(x.grossOpen.amount)} (${x.grossOpen.count}) | ${usd(x.grossOpenInPeriod.amount)} (${x.grossOpenInPeriod.count}) | ${usd(x.weightedOpen.amount)} | ${x.weightedOpen.stageCount} / ${x.weightedOpen.unavailableCount} | ${x.dq.pastDue} |`;
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
