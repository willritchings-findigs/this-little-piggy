# Data schema — `gtm-dashboard/data/`

Every file is written fresh on each refresh by the `gtm-dashboard-refresh` skill. Nothing in `data/` is edited by hand. `build.py` reads only these six files plus `config.json`.

Property values are kept exactly as HubSpot returns them (strings), so a `search_crm_objects` result can be written straight to disk. `build.py` does the typing and timezone conversion.

## `snapshot.json`

```json
{
  "portal": "243635806",
  "timezone": "America/New_York",
  "as_of": "2026-09-14",                       // ET date the QTD/YTD windows are anchored to (usually the run date)
  "pulled_at_et": "Sep 14, 2026 11:10 AM ET",  // shown in the dashboard header as "Data last refreshed"
  "supplemental_pulled_at_et": "…",            // optional; only if any field was pulled in a second pass
  "supplemental_fields": ["…"],                // optional
  "stages": [                                  // every stage of every in-scope pipeline, observed from live deals
    { "id": "3753890497", "label": "Intro & Challenge", "pipeline": "2313721535", "probability": 0.1, "won": false, "lost": false, "order": 0 }
  ],
  "owners": { "1053057926": { "name": "Phil Aroian", "active": true } },   // every hubspot_owner_id that appears in any deal file
  "notes": ["free-text caveats about this pull, surfaced in the Pipeline Generation DQ table"]
}
```

`stages` comes from `query_crm_data`: `SELECT pipeline, dealstage, hs_deal_stage_probability, COUNT(*) FROM DEAL WHERE pipeline IN (…) GROUP BY …`. Use the modal probability per stage. `build.py` refuses to run if a deal references a stage or owner not listed here — that is the intended trip-wire for pipeline or team changes.

## `deals_open.json` — both in-scope pipelines, all non-terminal stages

Array of `search_crm_objects` results, unchanged:

```json
[{ "id": "330249890550",
   "properties": { "dealname": "…", "pipeline": "2313721535", "dealstage": "3753890497", "hubspot_owner_id": "1053057926",
                   "amount": "10972500", "acv": "10972500", "units__c": "150000", "segment": "STRAT",
                   "closedate": "2026-10-27T04:00:00Z", "createdate": "2026-06-16T17:38:45Z",
                   "hs_deal_stage_probability": "0.1", "weighted_amount": "548625" } }]
```

Filter: `pipeline IN (new_logo, upsell_expansion)` AND `dealstage NOT IN (all four terminal stage IDs)`. Properties: the `pull_properties` list in `config.json`. Paginate with `offset` until `total` is reached; `total` must equal the array length.

## `deals_won.json` — closed-won, close date on or after FY start

Same shape. Filter: `dealstage IN (won stage IDs)` AND `closedate >= <FY start>`.

## `deals_created.json` — New Logo, created on or after FY start, any stage

Same shape; `deal_source_drill_down`, `deal_source__c`, `hs_object_source_label` must be present. Filter: `pipeline = new_logo` AND `createdate >= <FY start>`. Typically 600–800 records, 3–4 pages.

`build.py` fails if any record has a blank `deal_source_drill_down`. If that ever happens the field's no-null guarantee is gone; pull it per deal and report the count.

## `swan_scores.json` — company fit score joined to deals

```json
[{ "deal_id": "259826714312", "swan_score": 3 }]
```

From `query_crm_data`: `SELECT hs_object_id, company.swan_score FROM DEAL WHERE pipeline = '<new_logo>' AND createdate BETWEEN '<FY start>' AND '<FY end>' AND company.swan_score IS NOT NULL LIMIT 500`. Deals absent from this file are "No Swan score".

## `controls.json` — reporting-API aggregates used as the tie-out gate

```json
{
  "open_count": 117, "open_gross": 90193356.68, "open_hs_projected_amount": 17975274.348, "open_weighted_amount_stored": 10772534.045,
  "won_count": 71, "won_amount": 3896085.32, "won_units": 77104, "won_acv": 228661.44,
  "created_count": 644, "created_amount": 155082260.07,
  "created_by_record_source": { "SALESFORCE": { "n": 512, "a": 102041445.0 }, "CRM_UI": { "n": 131, "a": 52808895.07 } },
  "created_by_drill_down":    { "Outbound SDR": { "n": 330, "a": 74002620.89 }, "…": {} },
  "created_swan":             { "3": { "n": 111, "a": 23567066.83 }, "null": { "n": 519, "a": 128342698.49 } }
}
```

Produced by six `query_crm_data` aggregate queries (listed in `README.md → Refresh procedure → Step 2`). These are pulled **before** the record-level data, in the same session, so the gate compares like with like. `build.py` exits 2 on any delta over `tie_out_tolerance_usd` and writes nothing.

## Timezones and dates

All HubSpot timestamps are UTC ISO-8601. `build.py` converts to `America/New_York` before bucketing into days, weeks, months, quarters. Do not pre-convert in the data files.
