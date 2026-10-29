# Data schema — `gtm-dashboard/data/`

The six pull files below are written fresh on each refresh by the `gtm-dashboard-refresh` skill; `kpi_history.json` is maintained by `build.py` itself. Nothing in `data/` is edited by hand. `build.py` reads these seven files plus `config.json`, and appends to `runs/runs.jsonl`.

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
  "owners": { "1053057926": { "name": "Phil Aroian", "active": true } },   // every hubspot_owner_id AND every sdr_owner that appears in any deal file, incl. "8309346" (HubSpot's "Unassigned" placeholder)
  "notes": ["free-text caveats about this pull, surfaced in the Pipeline Generation DQ table"]
}
```

`stages` comes from `query_crm_data`: `SELECT pipeline, dealstage, hs_deal_stage_probability, COUNT(*) FROM DEAL WHERE pipeline IN (…) GROUP BY …`. Use the modal probability per stage. `build.py` refuses to run (exit 3) if a deal references a stage not listed here — the trip-wire for pipeline changes. An owner ID that isn't listed doesn't stop the build: it's shown as "Unresolved owner <id>" and counted in DQ-12.

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

## `deals_won.json` — closed-won, close date from FY start through the as-of date

Same shape. Filter: `dealstage IN (won stage IDs)` AND `closedate >= <FY start>` AND `closedate < <as_of + 1 day 00:00 ET, as UTC>` (YTD = Jan 1 through today).

## `deals_created.json` — New Logo, created on or after FY start, any stage

Same shape; `deal_source_drill_down`, `deal_source__c`, `hs_object_source_label` must be present. Filter: `pipeline = new_logo` AND `createdate >= <FY start>`. Typically 600–800 records, 3–4 pages.

A blank `deal_source_drill_down` doesn't stop the build: the deal is bucketed as "Unassigned" (which is also how the reporting API labels the blank group in the `created_by_drill_down` control) and counted in PG-4.

The pull also includes `sdr_owner`, `demo_booked__c`, `demo_completed__c`, `deal_source_group` (all in `config.pull_properties`) — the SDR section's population (New Logo, createdate >= FY start, `sdr_owner` IS NOT NULL) is a filtered subset of this same file, not a separate pull. Unlike `deal_source_drill_down`, none of these four are required non-null: `sdr_owner` blank means "not an SDR opportunity" (excluded, not estimated), `demo_booked__c`/`demo_completed__c` blank means "not booked"/"not held", and `deal_source_group` blank is bucketed as "Unassigned" in the channel-mix chart (documented as a data-quality flag — see `sdr_section.channel_buckets` in `config.json`).

## `swan_scores.json` — company fit score joined to deals

```json
[{ "deal_id": "259826714312", "swan_score": 3 }]
```

From `query_crm_data`: `SELECT hs_object_id, company.swan_score FROM DEAL WHERE pipeline = '<new_logo>' AND createdate BETWEEN '<FY start>' AND '<FY end>' AND company.swan_score IS NOT NULL LIMIT 500`. Deals absent from this file are "No Swan score".

## `controls.json` — reporting-API aggregates used as the tie-out gate

```json
{
  "open_count": 109, "open_gross": 71762742.13, "open_hs_projected_amount": 11477202.088, "open_weighted_amount_stored": 4203336.27,
  "won_count": 73, "won_amount": 7571305.12, "won_units": 131295, "won_acv": 3903881.24,
  "created_count": 664, "created_amount": 157710274.27,
  "created_by_record_source": {"SALESFORCE": {"n": 512, "a": 95348394.8}, "CRM_UI": {"n": 151, "a": 62129959.47}, "MOBILE_IOS": {"n": 1, "a": 231920}},
  "created_by_drill_down":    {"Outbound SDR": {"n": 343, "a": 75747050.89}, "…": {} },
  "created_swan":             {"3": {"n": 116, "a": 26932206.83}, "null": {"n": 524, "a": 121330517.79}, "…": {} },
  "sdr_opp_count": 663, "sdr_opp_amount": 157665006.67,
  "sdr_by_channel":    {"Outbound": {"n": 410, "a": 87090209.99}, "Inbound": {"n": 161, "a": 32851809.5}, "Referral": {"n": 74, "a": 35334577.83}, "Event": {"n": 16, "a": 1912901.35}, "null": {"n": 2, "a": 475508}},
  "sdr_meeting_booked_30d": 61, "sdr_meeting_held_30d": 32, "sdr_opp_from_held_30d": 32,
  "sdr_opp_30d_count": 49, "sdr_opp_30d_amount": 22146522
}
```

Values from the 2026-09-28 pull (two groups abbreviated with `…`). Every key above is required; `build.py` reads nothing else from this file.

Produced by `query_crm_data` aggregate queries (listed in `README.md → Refresh procedure → Step 2`). These are pulled **before** the record-level data, in the same session, so the gate compares like with like. `build.py` exits 2 on any delta over `tie_out_tolerance_usd` and writes nothing.

The `sdr_*` keys tie out the SDR section the same way: `sdr_opp_count`/`sdr_opp_amount` over the SDR opportunity population (`sdr_owner IS NOT NULL`); `sdr_by_channel` is that population grouped by `deal_source_group`, keyed by the **raw, capitalized** stored value (`null` key = blank, bucketed "Unassigned"); `sdr_meeting_booked_30d` / `sdr_meeting_held_30d` / `sdr_opp_from_held_30d` are counts over the trailing-30-day `demo_booked__c` cohort (booked, held subset, held subset with `sdr_owner` populated); `sdr_opp_30d_count` / `sdr_opp_30d_amount` are SDR opportunities with `createdate` in the same window. All are exact counts/sums pulled fresh each run, not carried over.

## `kpi_history.json` — Compare vs history (written by `build.py`, not by the skill)

```json
[{ "asOf": "2026-09-28", "file": "findigs_gtm_executive_dashboard_2026-09-28.html",
   "tier1": { "qtd": 3904709.24, "ytd": 7571305.12, "asp": 103716.51, "cycle": 45.3, "nl": 7156547.37, "ue": 414757.75,
              "gross": 71762742.13, "wtd": 9704462.77, "fq": 4825953.56, "fy": 14375035.75 },
   "pg":    { "cqtd": 64457496.92, "cytd": 157710274.27, "nqtd": 165, "nytd": 664 },
   "sdr":   { "booked30": 61, "held30": 32, "opp30": 49, "heldopp30": 1.0 } }]
```

One entry per `asOf`, sorted ascending; a same-day re-run replaces that date's entry. Entries older than `config.compare_vs.history_window_weeks` before the current `asOf` are dropped. Unfiltered headline totals only, never deal-level data. An entry may lack a group (`sdr` before the SDR section existed); its badges read blank. `heldopp30` is a ratio (`null` when nothing was held). `--diagnostic` never writes this file.

## `runs/runs.jsonl` — audit log (one line per successful non-diagnostic build)

```json
{"as_of": "2026-09-28", "pulled": "Sep 28, 2026 8:16 AM ET", "built": "2026-09-29 17:31 ET", "open_n": 109, "won_n": 73, "created_n": 664, "open_gross": 71762742.13, "open_weighted": 9704462.77, "weighted_fallback_n": 59, "won_amount": 7571305.12, "created_amount": 157710274.27, "past_due_n": 7, "swan_coverage": 0.211, "dq_high": 2, "sdr_opp_n": 663, "sdr_opp_amount": 157665006.67, "sdr_booked_30d": 61, "sdr_held_30d": 32, "output": "findigs_gtm_executive_dashboard_2026-09-28.html"}
```

Append-only, never deduped: a same-day re-run adds a second line. Failed builds (exit 2/3) and `--diagnostic` runs write nothing. Example is the last line of the committed file.

## Timezones and dates

All HubSpot timestamps are UTC ISO-8601. `build.py` converts to `America/New_York` before bucketing into days, weeks, months, quarters. Do not pre-convert in the data files.
