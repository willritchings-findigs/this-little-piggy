# HubSpot integration — the `refresh-gtm-dashboard` backend function

A Base44 backend function (Deno, `base44/functions/refresh-gtm-dashboard/entry.ts`) that reproduces steps 1–4 of the refresh skill against HubSpot's public API, then writes a reconciled snapshot. **Read-only.** It never creates, updates, or deletes anything in HubSpot.

## Auth

```ts
import { createClientFromRequest } from "npm:@base44/sdk";
const base44 = createClientFromRequest(req);
const { accessToken } = await base44.asServiceRole.connectors.getConnection("hubspot");
const HS = "https://api.hubapi.com";
const hs = (path: string, init: RequestInit = {}) =>
  fetch(HS + path, { ...init, headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
```

Connector type `hubspot`. Scopes to request when connecting: `crm.objects.deals.read`, `crm.objects.companies.read`, `crm.objects.owners.read`, `crm.schemas.deals.read`, `crm.schemas.pipelines.read`. Nothing with `write`.

Caller gate: only users with the Hub role `revops_admin` (or the app owner) may invoke manually. Scheduled/API triggers authenticate with the function's service key. Reject everything else with 403.

## Inputs

```json
{ "as_of": "2026-11-23", "trigger": "manual|schedule|api", "controls": { ...optional, controls.json shape... } }
```

`as_of` defaults to today's ET date. `controls` is optional; see Tie-out.

## Run outline and budget

| Step | Calls | Notes |
|---|---|---|
| 0 Create `GtmSnapshot` (status running) | — | record trigger, config version |
| 1 Schema check | 21 property GETs + 1 pipelines GET | can be parallelized 5 at a time |
| 2 Count controls | ~35 searches with `limit: 1` | read `total` only |
| 3 Record pulls | ~7 searches with `limit: 200` | open 1 page, won 1 page, created 4 pages |
| 4 Owners | 2 GETs | active + archived |
| 5 Swan join | ~8 association batch reads + ~8 company batch reads | 100 per batch |
| 6 Derive, validate, tie out | — | |
| 7 Write deals, history, flip `is_current` | bulk creates | ~950 rows |

About 80 HubSpot calls and 20–30 seconds. HubSpot's OAuth limit is 100 requests per 10 seconds per app, and the search endpoint is additionally limited to 5 requests per second: throttle searches to 4/s. If the Base44 function runtime limit is shorter than the run, split into two functions (`refresh-pull` writes raw pages to a staging entity, `refresh-build` derives and ties out) chained by invoking the second from the first.

Every HubSpot error (non-2xx) after 3 retries with exponential backoff (500 ms, 1.5 s, 4 s; retry on 429 and 5xx only) fails the run with the status, endpoint and body verbatim in `GtmSnapshot.error`.

## Step 1 — schema check

- `GET /crm/v3/properties/deals/{name}` for every name in `config.pull_properties` (20 names) and `GET /crm/v3/properties/companies/swan_score`. A 404 → **fail**: "property {name} missing".
- `GET /crm/v3/pipelines/deals` → for pipelines `2313721535` and `2313830082` collect each stage's `id`, `label`, `displayOrder`, `metadata.probability`, `metadata.isClosed`.
  - A stage ID not in `GtmStage` → **fail** ("new stage {id} {label} in pipeline {p}").
  - A closed stage with probability 1.0 must be in the config won set, probability 0 in the lost set; anything else → **fail** ("new terminal stage").
  - A changed probability is not a failure: update `GtmStage.probability`, add a `stage_notes` line, and record it under `schema_check.probability_changes`.
  - This replaces the old "observe probabilities from deals" method; DQ-9 becomes informational ("probabilities read from pipeline settings on {date}").

## Step 2 — count controls (HubSpot search totals)

`POST /crm/v3/objects/deals/search` with `limit: 1`, `properties: ["hs_object_id"]`, and the filter; read `total`. Totals are exact for populations under 10,000.

Date filters take epoch milliseconds. Compute from ET:

```ts
const etMidnightMs = (isoDate: string) => {
  // America/New_York offset for that date: -05:00 in standard time, -04:00 in daylight time
  const probe = new Date(isoDate + "T12:00:00Z");
  const off = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" })
    .formatToParts(probe).find(p => p.type === "timeZoneName")!.value;      // "GMT-5" or "GMT-4"
  const hours = parseInt(off.replace("GMT", ""), 10);                          // -5 or -4
  return Date.parse(isoDate + "T00:00:00Z") - hours * 3600_000;
};
const FY_START_MS = etMidnightMs(`${year}-01-01`);          // 2026 → 1767243600000
const AS_OF_NEXT_MS = etMidnightMs(addDays(asOf, 1));       // 2026-11-24 → 1795496400000
```

`demo_booked__c` is a `date` property: filter it with the calendar-date midnight UTC values (`Date.parse(d + "T00:00:00Z")`), not ET-shifted. The window is `[as_of − 29, as_of]`; use `GTE start` and `LTE end`.

| Control key | Filter (all AND within one group) |
|---|---|
| `open_count` | pipeline IN [N,U]; dealstage NOT_IN [4 terminal] |
| `won_count` | dealstage IN [won]; closedate GTE FY_START_MS; closedate LT AS_OF_NEXT_MS |
| `created_count` | pipeline EQ N; createdate GTE FY_START_MS |
| `created_by_record_source[v].n` | created filter + hs_object_source_label EQ v, for each distinct value seen in the pull (typically SALESFORCE, CRM_UI, MOBILE_IOS) |
| `created_by_drill_down[v].n` | created filter + deal_source_drill_down EQ v for each distinct value seen; plus one NOT_HAS_PROPERTY search for the blank bucket ("Unassigned") |
| `sdr_opp_count` | created filter + sdr_owner HAS_PROPERTY |
| `sdr_by_channel[v].n` | sdr filter + deal_source_group EQ v for each of Outbound, Inbound, Referral, Event; plus NOT_HAS_PROPERTY for blank |
| `sdr_meeting_booked_30d` | created filter + demo_booked__c GTE win.start, LTE win.end |
| `sdr_meeting_held_30d` | booked filter + demo_completed__c EQ "Yes" |
| `sdr_opp_from_held_30d` | held filter + sdr_owner HAS_PROPERTY |
| `sdr_opp_30d_count` | pipeline EQ N; sdr_owner HAS_PROPERTY; createdate GTE etMidnightMs(win.start); createdate LT etMidnightMs(win.end + 1 day) |

Swan-score counts cannot be reproduced with the deals search (the score is on the company). Coverage is recorded, not gated: see step 5.

Because the "for each distinct value" controls need the pull first, run them **immediately after** step 3 (same run, seconds apart). Record each as `{measure, pulled, control, ok}`. Any mismatch → re-run steps 2 and 3 once; a second mismatch → **fail** with the measures listed.

## Step 3 — record pulls

`POST /crm/v3/objects/deals/search`, `limit: 200`, `sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }]`, `properties` = the 20 names in `config.pull_properties`, page with `paging.next.after` until absent. Store raw results in memory as returned (strings); derive later.

| pull | filterGroups |
|---|---|
| open | `[{ filters: [ {pipeline IN [N,U]}, {dealstage NOT_IN [4 terminal]} ] }]` |
| won | `[{ filters: [ {dealstage IN [won]}, {closedate GTE FY_START_MS}, {closedate LT AS_OF_NEXT_MS} ] }]` |
| created | `[{ filters: [ {pipeline EQ N}, {createdate GTE FY_START_MS} ] }]` |

After each pull, `results.length` must equal the first page's `total`, otherwise **fail** ("{pull}: returned {n} of total {t}"). Expect open ≈ 110, won ≈ 76, created ≈ 760 (grows through the year).

## Step 4 — owners

`GET /crm/v3/owners?limit=500` and `GET /crm/v3/owners?limit=500&archived=true`. Map `id → { name: firstName + " " + lastName (or email if both blank), active: !archived }`. Upsert into `GtmOwner` for every `hubspot_owner_id` and every `sdr_owner` value seen in the three pulls. IDs the API doesn't return keep whatever `GtmOwner` already has (the seed includes `8309346` = "Unassigned"); if nothing exists, the deal renders "Unresolved owner {id}" and DQ-12 counts it. Not a failure.

## Step 5 — Swan score join

1. `POST /crm/v4/associations/deals/companies/batch/read` with `{ inputs: [{ id }] }` in chunks of 100 over all created-pull deal IDs. For each deal choose the company whose `associationTypes` includes the HubSpot-defined **primary** label (typeId 5); otherwise the first result; otherwise none.
2. `POST /crm/v3/objects/companies/batch/read` with `{ properties: ["swan_score"], inputs: [{ id }] }` in chunks of 100 over distinct company IDs.
3. `swan_score` = integer value or null. Record coverage counts by band in `counts.swan_scored_n` and the PG-2 flag. The prior kit's `created_swan` dollar/count control comes only from a control document (below).

## Step 6 — derive, validate, tie out

Apply the derivation rules in `03_data_model.md`. Validation failures (any → status failed, nothing written to `GtmDeal`):

- null `amount` or null `units__c` on any row ("deal {id} has null {field}")
- a stage ID not in `GtmStage`
- an open row in a terminal stage; a won row not in a won stage; a won row with `close_date > as_of`
- a created row outside the New Logo pipeline; a tier row outside the in-scope pipelines
- any count control mismatch after the one retry

### Dollar tie-out (when a control document is present)

If the request includes `controls`, or a `GtmControlDocument` exists for this `as_of` with no `applied_snapshot_id`, run every check `build.py` runs, tolerance $0.01:

- open: count, Σ amount, Σ stored `weighted_amount` (populated rows only), Σ amount × probability vs `open_hs_projected_amount` (reference)
- won: count, Σ amount, Σ units, Σ acv (populated only)
- created: count, Σ amount; per record source count and Σ; per `deal_source_drill_down` value count and Σ (blank = "Unassigned"); per Swan score count and Σ (`"null"` = no score)
- SDR: opportunity count and Σ; per `deal_source_group` raw value count and Σ (`"null"` = blank); booked / held / held-with-SDR counts; 30-day opportunity count and Σ

Any miss → **fail** with the measure, pulled, control and delta verbatim. Set `dollar_tieout = passed` and link the document. With no document, `dollar_tieout = not_run` and the header shows "count-reconciled" instead of "reconciled to the cent".

Where the document comes from today: the weekly Claude Routine commits `gtm-dashboard/data/controls.json` to GitHub for the same Monday. Either POST it to this function (`trigger: api`) from the Routine, or paste it into the admin "Submit controls" form. The two systems then reconcile each other.

## Step 7 — write

In this order, so a failure never leaves a half-written current snapshot:

1. Bulk-create `GtmDeal` rows for the new snapshot (tier rows, then pg rows).
2. Upsert `GtmKpiHistory` for `as_of` (replace same-day), then delete entries older than 26 weeks before `as_of`.
3. Update the new `GtmSnapshot`: `status = reconciled`, counts, headline, windows, controls, dq, duration.
4. Set `is_current = false` on the previous current snapshot and mark it `superseded`; set `is_current = true` on the new one.
5. Delete `GtmDeal` rows belonging to snapshots other than the 3 most recent reconciled ones (current plus previous 2).

On any failure before step 3: set `status = failed`, `failed_step`, `error`; delete any `GtmDeal` rows created for this snapshot; leave `is_current` untouched.

## Headline block written to the snapshot

```json
{ "tier1": { "qtd", "ytd", "asp", "cycle", "nl", "ue", "gross", "wtd", "fq", "fy" },
  "pg":    { "cqtd", "cytd", "nqtd", "nytd" },
  "sdr":   { "booked30", "held30", "opp30", "heldopp30", "oppTotal", "oppTotalAmt" } }
```

Same keys as `kpi_history.json`; the dashboard's QA compares tiles against this block.

## Scheduling

Target: Mondays 08:00 America/New_York (13:00 UTC in winter, 12:00 UTC in summer).

- If the Findigs Hub app has scheduled triggers / automations available, schedule `refresh-gtm-dashboard` with `{ "trigger": "schedule" }` weekly at that time.
- Otherwise, trigger it from outside: the existing Claude Routine (which already runs at that time) calls the function over HTTPS after its own steps succeed, posting its `controls.json` as the `controls` input. That gives the Base44 snapshot a dollar tie-out for free.
- Always expose a manual **Refresh now** button for `revops_admin` users on the dashboard page, with a confirmation and a live status readout from the `GtmSnapshot` row.

## Slack delivery (optional, mirrors the current skill)

Connector type `slack`. On `status = reconciled`: post to `#gtm_leadership` (`C0C1P09SPFF`) the text below, built only from the snapshot's headline block, then DM `U0BQ5AZK284` "Dashboard refresh succeeded, posted to #gtm_leadership. {dashboard URL}". On any failure: DM `U0BQ5AZK284` only, never the channel:

```
GTM dashboard refresh did not publish — {as_of}
Stopped at step {n} ({name}): {one sentence}.
{the measure / property / check that failed, verbatim}
Last successful build: {as_of of the current snapshot}. Prior snapshot remains current.
```

Channel post format (verbatim shape, numbers from the headline block, never typed):

```
GTM executive dashboard — refreshed {Mon D, YYYY}
Bookings QTD ${qtd} ({n} deals) · YTD ${ytd} ({n})
Gross open pipeline ${gross} · weighted ${wtd} · quarter forecast ${fq} · year forecast ${fy}
Pipeline created QTD ${cqtd} ({n}) · YTD ${cytd} ({n})
SDR opportunities ${oppTotalAmt} ({n}) · trailing 30d: booked {b}, held {h}, opportunities {o}
{dashboard URL}
Sources and methodology are in the dashboard. {High-severity DQ count | material changes ≥10% vs {prior as_of} | "No new data-quality flags."}
```

If both the Claude Routine and Base44 post, the channel gets two posts. Turn off one of them before enabling Slack here.
