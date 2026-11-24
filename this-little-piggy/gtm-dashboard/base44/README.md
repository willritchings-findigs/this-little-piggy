# GTM executive dashboard — Base44 build package

Everything needed to rebuild the weekly GTM executive dashboard as a live module inside the **Findigs Hub** Base44 app (`findigs-growth-hub.base44.app`), with the Base44 AI builder doing the implementation.

The current dashboard is a static HTML file rebuilt weekly from HubSpot by `gtm-dashboard/build.py` and posted to #gtm_leadership. This package translates that kit, file for file, into something the Base44 builder can execute: the same metric definitions, the same brand, the same tie-out posture, but served from Base44 entities and refreshed by a Base44 backend function that calls HubSpot directly.

## What's in here

| File | What it is | How to use it |
|---|---|---|
| `01_build_prompt.md` | The prompts to paste into the Base44 builder, in five stages | Paste stage by stage. Don't skip ahead; each stage assumes the previous one deployed. |
| `02_design_spec.md` | Design guidance: section order, every chart's encoding, viz color roles, formatting, states; reference tokens from the HTML build | Attach in Stages 3 to 5. The Hub's own design system takes precedence on chrome and components. |
| `03_data_model.md` | Base44 entity schemas (JSON) and the derived-field rules | Stage 1 reference. The builder should create these entities exactly. |
| `04_metric_definitions.md` | Every number on the dashboard: population, formula, window, nulls | Stage 3 reference. Mirrors Notion → Data Definitions and `config.json`; if they disagree, Notion wins. |
| `05_hubspot_integration.md` | The refresh function: HubSpot endpoints, filters, pagination, owners, stages, Swan join, tie-out gates, scheduling | Stage 2 reference. |
| `06_qa_checklist.md` | Acceptance tests mirroring `qa.py`, plus what to check against the current HTML | Run after stage 5 and after every later change. |
| `07_scope_expansion_prompt.md` | Triage of the Will / Brian recap, the Notion definitions it needs, and Stages 6–8: Pulse strip, meetings view, qualified pipeline and week-over-week waterfall, AI interpretation layer, client health discovery and build | Only after Stages 1–5 are reconciled. Stage 6 needs four new Notion rows first; Stage 8 needs discovery, then rows. |
| `08_brian_recap_prompt.md` | One paste-ready prompt covering everything from the Will / Brian recap: pulse strip, meetings, qualified pipeline and waterfall, forecast change, AI "This week's read", client health. New definitions are marked provisional until confirmed in Notion. | Alternative to Stages 6–8 in `07_...` when you want one build pass instead of three. |
| `seed/` | `config.json` mirror, `kpi_history.json` (12 weekly snapshots), `stages.json`, `owners.json`, `controls_2026-11-23.json` | Import so the builder has real shapes and a Compare vs history on day one. |

## Order of operations

1. In the Findigs Hub app, connect the **HubSpot** connector (Base44 connector type `hubspot`) as the app builder. Scopes: `crm.objects.deals.read`, `crm.objects.companies.read`, `crm.objects.owners.read`, `crm.schemas.deals.read`, `crm.schemas.pipelines.read`.
2. Paste **Stage 1** of `01_build_prompt.md` (entities + config). Import the `seed/` files when asked.
3. Paste **Stage 2** (refresh function). Run it once manually. Check the run record: status must be `reconciled` with 9 count controls matched.
4. Paste **Stage 3** (dashboard page: Tier 1–3). Compare the four headline tiles to the latest #gtm_leadership post. They must match to the cent for the same as-of date.
5. Paste **Stage 4** (Pipeline Generation + SDR sections).
6. Paste **Stage 5** (Compare vs, data quality, methodology, access, schedule, Slack post).
7. Run `06_qa_checklist.md`.

## Decisions baked into this package

- **Definitions don't change.** Notion → Revenue Operations → Reporting & Analytics → Data Definitions is still the system of record. `seed/config.json` mirrors it. Nothing here redefines a metric.
- **Read-only against HubSpot.** The refresh function only ever reads. No HubSpot connector scope in this package grants write access.
- **Stop, don't estimate.** A refresh that fails a tie-out writes a run record with `status = failed` and leaves the previous snapshot live. The dashboard never shows a number that didn't reconcile.
- **Tie-out changes shape.** The public HubSpot API has no SQL aggregate endpoint, so dollar-sum controls can't be reproduced the way `query_crm_data` did. Counts can (search `total`). Dollar controls become an optional document the function accepts. See `05_hubspot_integration.md → Tie-out`.
- **Stage probabilities improve.** Base44 reads them from the pipelines API, not observed from deals, which retires DQ-9.
- **The Hub owns the look.** The dashboard is a new page at Sales → GTM Dashboard, built from the Hub's component library, theme and accessibility features. It doesn't need to match the HTML pixel for pixel; `02_design_spec.md` guides structure, chart encodings and formatting. Numbers are exact, design is native.

## What this does not replace yet

Until the Base44 module has run reconciled for several consecutive weeks and been compared tile-for-tile with the HTML, keep the existing Routine running. Both can coexist: the Base44 refresh function can even accept the Routine's `controls.json` as its dollar-control document.
