# data/cohort_deals.csv — data dictionary
One row per closed New Logo deal (845). Source: HubSpot export 2026-09-30 + sdr_owner_new pull 2026-10-01, cleaned per the loss-analysis workbook v2 (Field_Decision_Register tab).

| Column | Definition |
|---|---|
| deal_id | HubSpot Record ID (hs_object_id) — join key |
| deal_name | HubSpot deal name (company-identifying; do not put in reports) |
| outcome | Won / Lost (current dealstage) |
| record_source | Salesforce (migrated) / CRM UI / Integration / Mobile iOS |
| created_pre_migration | 1 if createdate < 2026-07-14 |
| create_date, close_date | createdate, closedate (YYYY-MM-DD) |
| close_quarter | e.g. 2026-Q3 |
| sales_cycle_days | close − create |
| date_intro … date_closed_lost | nl_date_entered_* stage-entry dates (blank = stage not dated) |
| highest_stage_idx | 1 Intro & Challenge, 2 Discovery / Demo, 3 Business Case & Stakeholder Alignment, 4 Negotiation & Execution, 5 Trial (highest dated stage) |
| highest_stage | name of the above |
| funnel_tier_exit | TOFU (1), MOFU (2–3), BOFU (4–5) — for lost deals this is the exit tier; for won deals the last stage before Closed Won |
| units, segment | units__c; SMB < 3,000; Mid-Market 3,000–19,999; Enterprise ≥ 20,000 |
| amount_list_rate | amount (create-time units × list rate; NOT negotiated value — do not weight by it) |
| deal_owner | hubspot_owner_id resolved to name |
| sdr_owner_correct | sdr_owner_new if created pre-migration, else sdr_owner (approved coalesce rule) |
| deal_source | deal_source__c bucket |
| attribution_drill_down | attribution_source_drill_down (sparse before 2026) |
| reason_lost | reason_lost__c (blank for won) |
| reason_bucket | normalized bucket; Unresponsive split pre/post Discovery |
| who_we_lost_to, competitor_considered, primary_blocker | directional-only competitor / blocker fields |
| loss_detail_crm | coalesced loss notes: close_lost_notes, else reason_lost_notes__c, plus reason_lost_other when reason = Other. May contain names — never quote in reports |
