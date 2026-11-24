# Data model — Base44 entities for the GTM executive dashboard

Seven entities. Everything the dashboard renders comes from `GtmDeal` rows and `GtmSnapshot` metadata for the one snapshot flagged `is_current`. Nothing is computed from HubSpot at page load. Entity names are alphanumeric per Base44 rules; files go in `base44/entities/` as kebab-case `.jsonc`.

Write access to every entity is **service role only** (the refresh backend function). Hub users get read access according to the access rules in `01_build_prompt.md` Stage 5.

## Entity: GtmConfig  (`gtm-config.jsonc`)

Singleton mirror of `seed/config.json`. The refresh function reads it on every run and refuses to run if `version` is empty. Change definitions in Notion first, then here. Never in function code.

```jsonc
{
  "name": "GtmConfig",
  "type": "object",
  "properties": {
    "version": { "type": "string", "description": "config version date, e.g. 2026-10-29" },
    "portal_id": { "type": "string" },
    "timezone": { "type": "string", "default": "America/New_York" },
    "config": { "type": "object", "description": "verbatim contents of seed/config.json" },
    "is_active": { "type": "boolean", "default": true }
  },
  "required": ["version", "portal_id", "config"]
}
```

## Entity: GtmStage  (`gtm-stage.jsonc`)

Every stage of both in-scope pipelines, read from the HubSpot pipelines API on each refresh. A deal referencing a stage not in this table fails the refresh.

```jsonc
{
  "name": "GtmStage",
  "type": "object",
  "properties": {
    "stage_id": { "type": "string" },
    "label": { "type": "string" },
    "pipeline_id": { "type": "string" },
    "pipeline": { "type": "string", "enum": ["N", "U"], "description": "N = New Logo 2313721535, U = Upsell / Expansion 2313830082" },
    "probability": { "type": "number" },
    "won": { "type": "boolean" },
    "lost": { "type": "boolean" },
    "display_order": { "type": "integer" },
    "last_seen_as_of": { "type": "string", "format": "date" }
  },
  "required": ["stage_id", "label", "pipeline_id", "pipeline", "probability", "won", "lost", "display_order"]
}
```

Seed from `seed/stages.json` (14 rows). Expected terminal stages: won `3753890502`, `3752297196`; lost `3753890503`, `3752297197`.

## Entity: GtmOwner  (`gtm-owner.jsonc`)

```jsonc
{
  "name": "GtmOwner",
  "type": "object",
  "properties": {
    "hubspot_owner_id": { "type": "string" },
    "name": { "type": "string" },
    "active": { "type": "boolean", "default": true },
    "last_seen_as_of": { "type": "string", "format": "date" }
  },
  "required": ["hubspot_owner_id", "name"]
}
```

Seed from `seed/owners.json` (15 rows, including `8309346` = HubSpot's "Unassigned" placeholder, which the owners API may not return). Inactive owners render as "{name} (inactive)". An owner ID that can't be resolved is **not** an error: the deal shows "Unresolved owner {id}" and DQ-12 counts it.

## Entity: GtmSnapshot  (`gtm-snapshot.jsonc`)

One row per refresh attempt. Exactly one row has `is_current = true` at any time, and it is always the most recent row with `status = reconciled`.

```jsonc
{
  "name": "GtmSnapshot",
  "type": "object",
  "properties": {
    "as_of": { "type": "string", "format": "date", "description": "ET date the QTD/YTD windows are anchored to" },
    "pulled_at": { "type": "string", "format": "date-time" },
    "pulled_at_label": { "type": "string", "description": "e.g. Nov 23, 2026 8:14 AM ET" },
    "status": { "type": "string", "enum": ["running", "reconciled", "failed", "superseded"], "default": "running" },
    "is_current": { "type": "boolean", "default": false },
    "trigger": { "type": "string", "enum": ["schedule", "manual", "api"] },
    "triggered_by": { "type": "string", "description": "user email for manual runs" },
    "config_version": { "type": "string" },
    "counts": {
      "type": "object",
      "description": "open_n, won_n, created_n, sdr_opp_n, weighted_fallback_n, past_due_n, swan_scored_n, unresolved_owner_n, blank_source_n"
    },
    "headline": {
      "type": "object",
      "description": "unfiltered totals: tier1 {qtd,ytd,asp,cycle,nl,ue,gross,wtd,fq,fy}, pg {cqtd,cytd,nqtd,nytd}, sdr {booked30,held30,opp30,heldopp30,oppTotal,oppTotalAmt}"
    },
    "windows": { "type": "object", "description": "qtd {start,end,label}, ytd {start,end,label}, priorQ {start,end,label}, sdr30 {start,end}" },
    "count_controls": { "type": "array", "description": "[{measure, pulled, control, ok}] from HubSpot search totals", "items": { "type": "object" } },
    "dollar_controls": { "type": "array", "description": "[{measure, pulled, control, delta, ok}] when a control document was supplied", "items": { "type": "object" } },
    "dollar_tieout": { "type": "string", "enum": ["passed", "not_run", "failed"], "default": "not_run" },
    "control_document_id": { "type": "string" },
    "dq": { "type": "array", "description": "[{id, severity, finding, count, handling, section}]", "items": { "type": "object" } },
    "stage_notes": { "type": "array", "items": { "type": "string" } },
    "schema_check": { "type": "object", "description": "properties verified, stages verified, probability changes" },
    "error": { "type": "string", "description": "verbatim failure reason when status = failed" },
    "failed_step": { "type": "string" },
    "duration_ms": { "type": "integer" },
    "hubspot_calls": { "type": "integer" }
  },
  "required": ["as_of", "pulled_at", "status"]
}
```

## Entity: GtmDeal  (`gtm-deal.jsonc`)

Derived deal rows for one snapshot. A HubSpot deal can appear **twice** in a snapshot: once in `population = tier` (open or closed-won, both pipelines; drives Tier 1–3) and once in `population = pg` (New Logo created this FY, any stage; drives Pipeline Generation and SDR). Keep both; they're filtered independently, exactly as the HTML keeps `DEALS` and `PG` arrays. Expect roughly 185 tier rows and 760 pg rows per snapshot.

```jsonc
{
  "name": "GtmDeal",
  "type": "object",
  "properties": {
    "snapshot_id": { "type": "string" },
    "as_of": { "type": "string", "format": "date" },
    "population": { "type": "string", "enum": ["tier", "pg"] },
    "hubspot_deal_id": { "type": "string" },
    "hubspot_url": { "type": "string", "format": "uri" },
    "name": { "type": "string" },
    "pipeline_id": { "type": "string" },
    "pipeline": { "type": "string", "enum": ["N", "U"] },
    "pipeline_label": { "type": "string" },
    "stage_id": { "type": "string" },
    "stage_label": { "type": "string" },
    "stage_probability": { "type": "number", "description": "pipeline default for the stage" },
    "deal_probability": { "type": "number", "description": "hs_deal_stage_probability on the record, falls back to stage_probability" },
    "owner_id": { "type": "string" },
    "owner_name": { "type": "string" },
    "amount": { "type": "number" },
    "acv": { "type": "number" },
    "units": { "type": "integer" },
    "segment": { "type": "string", "enum": ["SMB", "Mid-Market", "Enterprise"] },
    "segment_raw": { "type": "string", "description": "free-text deal segment, display only" },
    "close_date": { "type": "string", "format": "date", "description": "ET calendar date of closedate" },
    "create_date": { "type": "string", "format": "date", "description": "ET calendar date of createdate" },
    "weighted": { "type": "number" },
    "weighted_fallback": { "type": "boolean" },
    "prob_weighted": { "type": "number", "description": "amount × deal_probability, reference only" },
    "won": { "type": "boolean" },
    "lost": { "type": "boolean" },
    "past_due": { "type": "boolean" },
    "record_source": { "type": "string", "description": "hs_object_source_label, UNKNOWN if blank" },
    "migrated": { "type": "boolean", "description": "record_source = SALESFORCE" },
    "migration_cohort": { "type": "boolean", "description": "tier rows: create_date < 2026-07-14" },
    "source": { "type": "string", "description": "deal_source_drill_down, 'Unassigned' if blank" },
    "source_blank": { "type": "boolean" },
    "source_parent": { "type": "string", "description": "deal_source__c, 'Unassigned' if blank" },
    "source_group": { "type": "string", "description": "parent prefix mapped: IB Inbound, OB Outbound, EV Event, RE Referral, DA Data provider, UK Unknown, else Unassigned" },
    "swan_score": { "type": "integer" },
    "swan_band": { "type": "string", "enum": ["Swan 5", "Swan 4", "Swan 3", "No Swan score"] },
    "is_sdr_opp": { "type": "boolean" },
    "sdr_owner_id": { "type": "string" },
    "sdr_owner_name": { "type": "string" },
    "demo_booked": { "type": "string", "format": "date", "description": "demo_booked__c as the stored calendar date, never TZ-shifted" },
    "demo_held": { "type": "boolean", "description": "demo_completed__c = 'Yes'" },
    "channel_raw": { "type": "string", "description": "deal_source_group as stored (Outbound/Inbound/Referral/Event) or null" },
    "channel": { "type": "string", "enum": ["Outbound", "Inbound", "Events", "Unassigned"], "description": "SDR rows only" },
    "hs_deal_score": { "type": "number", "description": "pulled, never used" }
  },
  "required": ["snapshot_id", "as_of", "population", "hubspot_deal_id", "name", "pipeline_id", "pipeline", "stage_id", "stage_label", "owner_id", "owner_name", "amount", "units", "segment", "weighted", "won", "lost"]
}
```

### Derivation rules (apply in the refresh function, never in the UI)

| Field | Rule |
|---|---|
| `close_date`, `create_date` | Parse the UTC ISO timestamp, convert to America/New_York, take the calendar date. HubSpot `date`-type properties (`demo_booked__c`) are already calendar dates: take the first 10 characters, do not shift. |
| `segment` | from `units`: 0–2,999 SMB; 3,000–19,999 Mid-Market; ≥ 20,000 Enterprise. `units` null → fail the refresh (exit 3 equivalent). |
| `amount` null | fail the refresh. `amount = 0` is valid (PG-3). |
| `deal_probability` | `hs_deal_stage_probability` if present else the stage's probability. |
| `weighted` | won → `amount`; lost → 0; `weighted_amount` populated → that value (`weighted_fallback = false`); else `round(amount × deal_probability, 2)` with `weighted_fallback = true`. |
| `won` / `lost` | by stage ID membership in the terminal sets only. Never `hs_is_closed_won`. |
| `past_due` | tier rows only: not won and `close_date < as_of`. |
| `migration_cohort` | tier rows: `create_date < 2026-07-14`. `migrated` (pg rows): `record_source = SALESFORCE`. |
| `source` | `deal_source_drill_down`, blank → "Unassigned" and `source_blank = true` (PG-4, not a stop). |
| `swan_score` | company `swan_score` via the deal's primary associated company; absent → null, band "No Swan score". |
| `is_sdr_opp` | `sdr_owner` not null and not empty string. `8309346` counts as populated. |
| `channel` | SDR rows only: Outbound→Outbound, Inbound→Inbound, Referral→Inbound, Event→Events, blank→Unassigned. Compare case-sensitively against the stored capitalized values; if the API ever returns lowercase, normalize by `toLowerCase()` on both sides and record a stage note. |
| `owner_name`, `sdr_owner_name` | from `GtmOwner`; inactive → " (inactive)" suffix; missing → "Unresolved owner {id}". |
| `hubspot_url` | `https://app.hubspot.com/contacts/243635806/record/0-3/{hubspot_deal_id}` |

### Population filters (HubSpot side)

| population | filter |
|---|---|
| tier, open | `pipeline IN (2313721535, 2313830082)` AND `dealstage NOT IN (3753890502, 3752297196, 3753890503, 3752297197)` |
| tier, won | `dealstage IN (3753890502, 3752297196)` AND `closedate ≥ FY start 00:00 ET` AND `closedate < as_of + 1 day 00:00 ET` |
| pg | `pipeline = 2313721535` AND `createdate ≥ FY start 00:00 ET` |

Validation after derivation (each is a refresh failure): an open row whose stage is terminal; a won row whose stage is not a won stage; a won row with `close_date > as_of`; a pg row not in the New Logo pipeline; any tier row in a pipeline that isn't in scope.

## Entity: GtmKpiHistory  (`gtm-kpi-history.jsonc`)

Compare vs source. One row per `as_of`; a same-day re-run replaces that row. Rows older than `config.compare_vs.history_window_weeks` (26) before the current `as_of` are deleted on each reconciled refresh. Never written by a failed run.

```jsonc
{
  "name": "GtmKpiHistory",
  "type": "object",
  "properties": {
    "as_of": { "type": "string", "format": "date" },
    "snapshot_id": { "type": "string" },
    "tier1": { "type": "object", "description": "qtd, ytd, asp, cycle, nl, ue, gross, wtd, fq, fy" },
    "pg": { "type": "object", "description": "cqtd, cytd, nqtd, nytd" },
    "sdr": { "type": "object", "description": "booked30, held30, opp30, heldopp30 (ratio or null)" }
  },
  "required": ["as_of", "tier1", "pg"]
}
```

Seed from `seed/kpi_history.json` (12 entries, 2026-09-14 through 2026-11-23) so Compare vs works on the first Base44 refresh.

## Entity: GtmControlDocument  (`gtm-control-document.jsonc`)

Optional dollar-level controls from an independent aggregate source (today: the weekly Claude Routine's `controls.json`, produced by HubSpot's reporting API). When a document exists for the refresh's `as_of`, the function runs the full dollar tie-out against it.

```jsonc
{
  "name": "GtmControlDocument",
  "type": "object",
  "properties": {
    "as_of": { "type": "string", "format": "date" },
    "source": { "type": "string", "enum": ["routine", "manual", "api"] },
    "controls": { "type": "object", "description": "same shape as gtm-dashboard/data/controls.json (see seed/controls_2026-11-23.json)" },
    "applied_snapshot_id": { "type": "string" },
    "submitted_by": { "type": "string" }
  },
  "required": ["as_of", "source", "controls"]
}
```

## Retention

Keep `GtmDeal` rows for the current snapshot plus the previous 3 reconciled snapshots (so a failed refresh never leaves the page empty and an admin can diff). Delete older deal rows at the end of each reconciled refresh. Keep every `GtmSnapshot` row forever (it is the audit log, the equivalent of `runs/runs.jsonl`).
